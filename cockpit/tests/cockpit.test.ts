import { describe, expect, mock, test } from 'claude-code/testing'
import { layoutFiles } from './layout-files'
import type { Engine } from 'claude-code/testing'

import { count, duration, type ModUsage, refusal, report, testSummary } from '../hooks/register'

const CHECKLIST = 'mcp__checklist__set'
const END = { answer: 'ok', durationMs: 192_000, isAborted: false, reason: 'answer' as const }

type Counts = Partial<Record<'input_tokens' | 'output_tokens' | 'cache_read_input_tokens' | 'cache_creation_input_tokens', number>>
type Step = { tools?: string[]; usage?: Counts }

let sessions = 0

// The world beneath the plugin: a session with an id of its own (the mod keeps its counters per id),
// an in-memory store, a clock that moves only when the test moves it, a project root, osascript,
// and a model that answers each request from `steps`. `failStore` makes every store write reject,
// `failBanner` makes osascript fail.
// biome-ignore lint: the test registrar's overloads are not worth spelling out here
function world(on: any, { steps = [] as Step[], failStore = false, failBanner = false, layout = undefined as unknown } = {}) {
  layoutFiles(on, layout)
  const id = `s${++sessions}`
  const store = new Map<string, unknown>()
  const ran: string[][] = []
  const clock = mock.clock(on, { now: 1_000_000 })
  on('session.id', () => ({ value: id }))
  on('session.root', () => ({ value: '/Users/me/projects/shop' }))
  on('store.get', (_$: unknown, e: { key: string }) => ({ value: store.get(e.key) }))
  on('store.set', (_$: unknown, e: { key: string; value: unknown }) => {
    if (failStore) throw new Error('two sessions wrote at once')
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('process.run', (_$: unknown, e: { argv: string[] }) => {
    if (failBanner) throw new Error('osascript is gone')
    ran.push(e.argv)
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('tool.call', () => ({ result: 'ran' }))
  on('turn.start', (_$: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', (_$: unknown, e: { answer: string }) => ({ text: e.answer }))
  on('turn.step', async function* (_$: unknown, e: { turnId: string; index: number }) {
    const step = steps.shift() ?? {}
    const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'm', ...step.usage }
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: (step.tools ?? []).map(name => ({ name, input: {} })),
      stopReason: step.tools?.length ? 'tool_use' : 'end_turn',
      usage: step.usage ? usage : null,
    }
  })
  return { id, store, ran, clock, saved: () => store.get(`usage:${id}`) as ModUsage }
}

// One model request through the chain, read to its end.
async function ask($: Engine, turnId: string, index: number, agentId?: string) {
  const stream = $.turn.step({ turnId, index, model: 'm', messageCount: 1, ...(agentId ? { agentId } : {}) })
  for await (const _chunk of stream) {
    // the stand-in yields nothing: the response is its return value
  }
  return stream.result
}

describe('mods usage', () => {
  test('the report adds this session to all sessions', () => {
    const mine: ModUsage = { requests: 40, checklistCalls: 5, loneCalls: 2, loneReread: 90_000, denies: 1 }
    const other: ModUsage = { requests: 1500, checklistCalls: 60, loneCalls: 25, loneReread: 4_000_000, denies: 3 }
    const text = report(mine, [mine, other])
    const line = (label: string) => text.split('\n').find(l => l.trim().startsWith(label)) ?? ''
    expect(line('requests')).toMatch(/\b40 +1\.5k$/)
    expect(line('checklist updates')).toMatch(/\b5 +65$/)
    expect(line('sent alone')).toMatch(/\b2 +27$/)
    expect(line('tokens re-read because of those')).toMatch(/\b90\.0k +4\.1M$/)
    expect(line('guard refusals')).toMatch(/\b1 +4$/)
    expect(text).toContain('The checklist tool and its policy add about 620 tokens to every request, read from cache.')
  })

  test('a checklist update sent alone costs one request, counted with what it read', async ($, on) => {
    const w = world(on, {
      steps: [
        { tools: [CHECKLIST], usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 90 } },
        { tools: [], usage: { input_tokens: 7, cache_read_input_tokens: 500 } }, // an agent's request in between
        { tools: [], usage: { input_tokens: 5, cache_read_input_tokens: 2000, cache_creation_input_tokens: 45 } },
      ],
    })
    await $.turn.start({ text: 'go', turnId: 'm1' })
    await ask($, 'm1', 0)
    await ask($, 'a1', 0, 'agent-1') // another loop: it neither is the follow-up nor clears the mark
    await ask($, 'm1', 1)
    await $.turn.complete({ ...END, turnId: 'm1' })
    expect(w.saved()).toEqual({ requests: 3, checklistCalls: 1, loneCalls: 1, loneReread: 2050, denies: 0 })
  })

  test('a checklist update beside another tool call is not sent alone', async ($, on) => {
    const w = world(on, {
      steps: [
        { tools: [CHECKLIST, 'Bash'], usage: { input_tokens: 10, cache_read_input_tokens: 1000 } },
        { tools: [], usage: { input_tokens: 5, cache_read_input_tokens: 2000 } },
      ],
    })
    await $.turn.start({ text: 'go', turnId: 'm1' })
    await ask($, 'm1', 0)
    await ask($, 'm1', 1)
    await $.turn.complete({ ...END, turnId: 'm1' })
    expect(w.saved()).toEqual({ requests: 2, checklistCalls: 1, loneCalls: 0, loneReread: 0, denies: 0 })
  })
})

describe('needs-you alert', () => {
  const base = { message: 'Claude needs your permission to use Bash', session_id: 's1', transcript_path: '', cwd: '/x' }

  // biome-ignore lint: the test registrar's overloads are not worth spelling out here
  function capture(on: any) {
    const ran: string[][] = []
    on('session.root', () => ({ value: '/Users/me/projects/shop' }))
    on('process.run', (_$: unknown, e: { argv: string[] }) => (ran.push(e.argv), { value: { exitCode: 0, stdout: '', stderr: '' } }))
    on('classic.Notification', () => ({}))
    return ran
  }

  test('a permission prompt in the main session alerts, named after the project', async ($, on) => {
    const ran = capture(on)
    await $.classic.Notification({ ...base, notification_type: 'permission_prompt' })
    expect(ran.length).toBe(1)
    expect(ran[0]?.[2]).toContain('shop needs your permission')
  })

  test('an agent inside a workflow never alerts', async ($, on) => {
    const ran = capture(on)
    await $.classic.Notification({ ...base, notification_type: 'permission_prompt', agent_id: 'wf_6227ae77-c83-3' })
    expect(ran.length).toBe(0)
  })

  test('other notification types do not alert', async ($, on) => {
    const ran = capture(on)
    await $.classic.Notification({ ...base, notification_type: 'idle_prompt' })
    await $.classic.Notification({ ...base, notification_type: 'auth_success' })
    expect(ran.length).toBe(0)
  })
})

describe('finished alert', () => {
  test('a long piece of work alerts with its whole duration', async ($, on) => {
    const { ran, clock } = world(on)
    await $.turn.start({ text: 'go', turnId: 'm1' })
    await clock.advance(65_000)
    await $.turn.complete({ ...END, turnId: 'm1', durationMs: 65_000 })
    expect(ran.length).toBe(1)
    expect(ran[0]?.[2]).toContain('shop finished (1m 5s)')
  })

  test('a banner that cannot be shown does not take the turn line with it', async ($, on) => {
    const { clock } = world(on, { failBanner: true })
    await $.turn.start({ text: 'go', turnId: 'm1' })
    await clock.advance(65_000)
    const done = await $.turn.complete({ ...END, turnId: 'm1', durationMs: 65_000 })
    expect(done.text).toContain('↳ this turn:')
  })

  test('an error ends the work in its own words', async ($, on) => {
    const { ran, clock } = world(on)
    await $.turn.start({ text: 'go', turnId: 'm1' })
    await clock.advance(40_000)
    await $.turn.complete({ ...END, turnId: 'm1', durationMs: 40_000, reason: 'error' })
    expect(ran[0]?.[2]).toContain('shop stopped with an error (40s)')
  })

  test('short work does not alert and the next piece of work starts over', async ($, on) => {
    const { ran, clock } = world(on)
    await $.turn.start({ text: 'go', turnId: 'm1' })
    await clock.advance(10_000)
    await $.turn.complete({ ...END, turnId: 'm1', durationMs: 10_000 })
    await clock.advance(90_000) // the person is away
    await $.turn.start({ text: 'again', turnId: 'm2' })
    await clock.advance(5_000)
    await $.turn.complete({ ...END, turnId: 'm2', durationMs: 5_000 })
    expect(ran.length).toBe(0)
  })

  test('the alert waits while an agent turn is running', async ($, on) => {
    const { ran, clock } = world(on)
    await $.turn.start({ text: 'go', turnId: 'm1' })
    await $.turn.start({ text: 'work', turnId: 'a1', agentId: 'agent-1' })
    await clock.advance(45_000)
    await $.turn.complete({ ...END, turnId: 'm1', durationMs: 45_000 })
    expect(ran.length).toBe(0) // the agent is still running: the work is not done
    await clock.advance(20_000)
    await $.turn.complete({ ...END, turnId: 'a1', agentId: 'agent-1', durationMs: 20_000 })
    expect(ran.length).toBe(0) // an agent's end alone alerts nothing
    await $.turn.start({ text: 'the agent finished', turnId: 'm2' })
    await clock.advance(1_000)
    await $.turn.complete({ ...END, turnId: 'm2', durationMs: 1_000 })
    expect(ran.length).toBe(1)
    expect(ran[0]?.[2]).toContain('shop finished (1m 6s)') // counted from the first prompt
  })

  test('an interrupted turn keeps the start while an agent still runs', async ($, on) => {
    const { ran, clock } = world(on)
    await $.turn.start({ text: 'go', turnId: 'm1' })
    await $.turn.start({ text: 'work', turnId: 'a1', agentId: 'agent-1' })
    await clock.advance(60_000)
    await $.turn.complete({ ...END, turnId: 'm1', durationMs: 60_000, isAborted: true, reason: 'aborted' })
    await $.turn.complete({ ...END, turnId: 'a1', agentId: 'agent-1', durationMs: 60_000 })
    await $.turn.start({ text: 'the agent finished', turnId: 'm2' })
    await clock.advance(1_000)
    await $.turn.complete({ ...END, turnId: 'm2', durationMs: 1_000 })
    expect(ran[0]?.[2]).toContain('shop finished (1m 1s)')
  })

  test('an interrupted turn neither alerts nor leaves its start behind', async ($, on) => {
    const { ran, clock } = world(on)
    await $.turn.start({ text: 'go', turnId: 'm1' })
    await clock.advance(60_000)
    await $.turn.complete({ ...END, turnId: 'm1', durationMs: 60_000, isAborted: true, reason: 'aborted' })
    await $.turn.start({ text: 'again', turnId: 'm2' })
    await clock.advance(5_000)
    await $.turn.complete({ ...END, turnId: 'm2', durationMs: 5_000 })
    expect(ran.length).toBe(0)
  })
})

describe('git guard', () => {
  const blocked = [
    'git add .',
    'git add -A',
    'cd js && git add --all',
    'git -C /tmp/x add .',
    'git stash',
    'git stash pop',
    'git stash push -u',
    'git push --force origin main',
    'git push -f',
    'git push origin +main',
    'git reset --hard HEAD~1',
    'git clean -fd',
    'git restore .',
    'git checkout -- .',
  ]
  const allowed = [
    'git add js/physics/collision.mjs',
    'git stash push -u -m "wip-tag"',
    'git stash list',
    'git stash apply 3f2a91c',
    'git push origin main',
    'git reset --soft HEAD~1',
    'git restore js/a.mjs',
    'git checkout main',
    'git status && git diff',
    'echo "git add ."',
  ]
  for (const c of blocked) test(`blocks: ${c}`, () => expect(refusal(c)).not.toBe(null))
  for (const c of allowed) test(`allows: ${c}`, () => expect(refusal(c)).toBe(null))

  test('the reason names the segment', () => {
    expect(refusal('npm test && git add .')).toBe('guard: "git add ." blocked: stage only the paths you own')
  })

  test('a blocked call is denied through tool.call', async ($, on) => {
    on('tool.call', () => ({ result: 'ran' }))
    const answer = await $.tool.call({ tool: 'Bash', command: 'git add .' })
    expect(answer).toEqual({ deny: 'guard: "git add ." blocked: stage only the paths you own' } as never)
  })

  test('an allowed call runs', async ($, on) => {
    on('tool.call', () => ({ result: 'ran' }))
    const answer = await $.tool.call({ tool: 'Bash', command: 'git status' })
    expect(answer.result).toBe('ran')
  })

  test('refusals reach the counters, the turn line counts the main conversation only', async ($, on) => {
    const w = world(on)
    await $.turn.start({ text: 'go', turnId: 'm1' })
    await $.tool.call({ tool: 'Bash', command: 'git add .' })
    await $.tool.call({ tool: 'Bash', command: 'git add .', agentId: 'agent-1' })
    const done = await $.turn.complete({ ...END, turnId: 'm1' })
    expect(done.text).toContain('· 1 tool call · 1 blocked')
    expect(w.saved().denies).toBe(2)
  })
})

describe('turn line', () => {
  const usage = { input_tokens: 40_000, output_tokens: 2_100, cache_read_input_tokens: 1_160_000, cache_creation_input_tokens: 0, model: 'm' }

  test('the real counts of the turn', async ($, on) => {
    world(on)
    await $.turn.start({ text: 'go', turnId: 'm1' })
    for (let i = 0; i < 14; i++) await $.tool.call({ tool: 'Bash', command: 'ls' })
    const done = await $.turn.complete({ ...END, turnId: 'm1', usage })
    expect(done.text).toBe('↳ this turn: 2.1k out · 1.2M in, 97% from cache · 3m 12s · 14 tool calls')
  })

  test('input is new input plus cache reads plus cache writes', async ($, on) => {
    world(on)
    await $.turn.start({ text: 'go', turnId: 'm1' })
    await $.tool.call({ tool: 'Bash', command: 'ls' })
    const done = await $.turn.complete({
      ...END,
      turnId: 'm1',
      usage: { input_tokens: 200, output_tokens: 812, cache_read_input_tokens: 600, cache_creation_input_tokens: 200, model: 'm' },
    })
    expect(done.text).toBe('↳ this turn: 812 out · 1.0k in, 60% from cache · 3m 12s · 1 tool call')
  })

  test('without usage the token part is left out', async ($, on) => {
    world(on)
    await $.turn.start({ text: 'go', turnId: 'm1' })
    const done = await $.turn.complete({ ...END, turnId: 'm1' })
    expect(done.text).toBe('↳ this turn: 3m 12s · 0 tool calls')
  })

  const own = (turnSummary: unknown[]) => ({ format: 'claude-terminal-layout', version: 1, sidebar: [], bandAbovePrompt: [], statusLine: [], turnSummary })

  test("the person's layout orders the line and drops what it leaves out", async ($, on) => {
    world(on, { layout: own([{ key: 'turn.summary', elements: [{ key: 'turn.time' }, { key: 'sep', text: '|' }, { key: 'turn.out' }, { key: 'emoji', text: '🧰' }, { key: 'turn.blocked' }] }]) })
    await $.turn.start({ text: 'go', turnId: 'm1' })
    const done = await $.turn.complete({ ...END, turnId: 'm1', usage })
    expect(done.text).toBe('3m 12s | 2.1k out')
  })

  test('a layout without a turn summary leaves the answer as it was', async ($, on) => {
    world(on, { layout: own([]) })
    await $.turn.start({ text: 'go', turnId: 'm1' })
    const done = await $.turn.complete({ ...END, turnId: 'm1', usage })
    expect(done.text).toBe(END.answer)
  })

  const DEFAULT_LINE = '↳ this turn: 2.1k out · 1.2M in, 97% from cache · 3m 12s · 0 tool calls'

  test('a file that is not JSON leaves the default line', async ($, on) => {
    world(on, { layout: '{ "turnSummary": [' })
    await $.turn.start({ text: 'go', turnId: 'm1' })
    expect((await $.turn.complete({ ...END, turnId: 'm1', usage })).text).toBe(DEFAULT_LINE)
  })

  test('a layout of another version or format leaves the default line', async ($, on) => {
    world(on, { layout: { ...own([{ key: 'l', elements: [{ key: 'text', text: 'mine' }] }]), version: 2 } })
    await $.turn.start({ text: 'go', turnId: 'm1' })
    expect((await $.turn.complete({ ...END, turnId: 'm1', usage })).text).toBe(DEFAULT_LINE)
  })

  test('a file that cannot be read leaves the default line', async ($, on) => {
    world(on, { layout: new Error('EACCES') })
    await $.turn.start({ text: 'go', turnId: 'm1' })
    expect((await $.turn.complete({ ...END, turnId: 'm1', usage })).text).toBe(DEFAULT_LINE)
  })

  test('a width pads the value, a pictograph counting two columns, and align right pads on the left', async ($, on) => {
    world(on, {
      layout: own([
        { key: 'l', elements: [{ key: 'emoji', text: '⏱', width: 3 }, { key: 'turn.tools', width: 14, align: 'right' }, { key: 'text', text: '|' }, { key: 'emoji', text: '🔔', width: 4 }, { key: 'text', text: '|' }] },
      ]),
    })
    await $.turn.start({ text: 'go', turnId: 'm1' })
    const done = await $.turn.complete({ ...END, turnId: 'm1', usage })
    expect(done.text).toBe('⏱     0 tool calls | 🔔   |') // ⏱ without U+FE0F is 1 column + 2 pad, 12-char value right-aligned in 14, 🔔 2+2 pad
  })

  test('a store that rejects the write does not break the line', async ($, on) => {
    world(on, { failStore: true })
    await $.turn.start({ text: 'go', turnId: 'm1' })
    const done = await $.turn.complete({ ...END, turnId: 'm1' })
    expect(done.text).toContain('↳ this turn:')
  })
})

describe('test output folding', () => {
  test('node --test TAP', () => expect(testSummary('ok 1\n# tests 52\n# pass 52\n# fail 0\n')).toEqual({ passed: 52, failed: 0, skipped: 0 }))
  test('node --test TAP with skips', () =>
    expect(testSummary('# tests 54\n# pass 52\n# fail 0\n# cancelled 0\n# skipped 2\n# todo 0\n')).toEqual({ passed: 52, failed: 0, skipped: 2 }))
  test('node --test spec', () => expect(testSummary('ℹ tests 3\nℹ pass 2\nℹ fail 1\n')).toEqual({ passed: 2, failed: 1, skipped: 0 }))
  test('node --test spec with skips', () =>
    expect(testSummary('ℹ tests 4\nℹ pass 3\nℹ fail 0\nℹ cancelled 0\nℹ skipped 1\nℹ todo 0\n')).toEqual({ passed: 3, failed: 0, skipped: 1 }))
  test('claude plugin test', () => expect(testSummary('\n 4 pass\n 0 fail\nRan 4 tests')).toEqual({ passed: 4, failed: 0, skipped: 0 }))
  test('bun with skips', () => expect(testSummary('\n 4 pass\n 2 skip\n 0 fail\nRan 6 tests')).toEqual({ passed: 4, failed: 0, skipped: 2 }))
  test('pytest', () => expect(testSummary('==== 52 passed, 2 skipped in 1.20s ====')).toEqual({ passed: 52, failed: 0, skipped: 2 }))
  test('pytest with failures', () => expect(testSummary('=== 1 failed, 51 passed in 2s ===')).toEqual({ passed: 51, failed: 1, skipped: 0 }))
  test('plain output', () => expect(testSummary('total 8\ndrwxr-xr-x  js')).toBe(null))
})

describe('turn line pieces', () => {
  test('count', () => {
    expect(count(812)).toBe('812')
    expect(count(2100)).toBe('2.1k')
    expect(count(999_999)).toBe('1.0M')
    expect(count(1_200_000)).toBe('1.2M')
  })
  test('duration', () => {
    expect(duration(112_000)).toBe('1m 52s')
    expect(duration(9_400)).toBe('9s')
  })
})
