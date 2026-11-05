import { expect, test } from 'claude-code/testing'
import { layoutFiles } from './layout-files'

import { ago, applyChanges, stepOf } from '../hooks/register'

const PLAN = {
  title: 'Port fixes',
  updated: '',
  steps: [
    { step: 'Read', status: 'done' as const },
    { step: 'Patch', status: 'running' as const, note: 'collision' },
    { step: 'Commit', status: 'pending' as const },
  ],
}

test('changes update only the named steps', () => {
  const next = applyChanges(PLAN, { changes: [{ number: 2, status: 'done', note: '' }, { number: 3, status: 'running' }] })
  if (typeof next === 'string') throw new Error(next)
  expect(next.title).toBe('Port fixes')
  expect(next.steps.map(s => s.status)).toEqual(['done', 'done', 'running'])
  expect(next.steps[1]?.note).toBe(undefined)
  expect(PLAN.steps[1]?.status).toBe('running')
})

test('bad changes are refused with the reason', () => {
  expect(applyChanges(PLAN, { changes: [{ number: 4, status: 'done' }] })).toBe('changes[0].number must be a step number from 1 to 3')
  expect(applyChanges(PLAN, { changes: [{ number: 1, status: 'later' }] })).toBe(
    'changes[0].status must be one of done, running, pending, failed',
  )
  expect(applyChanges({ title: '', steps: [], updated: '' }, { changes: [{ number: 1 }] })).toBe(
    'there is no checklist yet: pass title and steps first',
  )
  expect(applyChanges(PLAN, {})).toBe('pass steps (the whole list) or changes (what changed)')
})

test('a change call through the tool updates the stored list', async ($, on) => {
  const store = new Map<string, unknown>()
  session(on, store)
  await $.tool.call({ tool: TOOL, ...PLAN })
  const answer = await $.tool.call({ tool: TOOL, changes: [{ number: 2, status: 'done' }, { number: 3, status: 'running' }] })
  expect(answer.result).toBe('Checklist updated: 2 of 3 steps done.')
  expect((store.get('list:s1') as { steps: { status: string }[] }).steps.map(s => s.status)).toEqual(['done', 'done', 'running'])
})

const TOOL = 'mcp__checklist__set'
const FACTS = { model: 'm', promptModel: 'm', outputStyle: null, traits: [] }

// Stand-ins for what a session answers, with an in-memory store; a key in `refuse` fails its next write.
// biome-ignore lint: the test registrar's overloads are not worth spelling out here
function session(on: any, store: Map<string, unknown>, refuse = new Set<string>()) {
  layoutFiles(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.id', () => ({ value: 's1' }))
  on('session.root', () => ({ value: '/Users/me/projects/app' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 226_000, window: 1_000_000 }, rateLimits: [] } }))
  on('store.get', (_$: unknown, e: { key: string }) => ({ value: store.get(e.key) }))
  on('store.set', (_$: unknown, e: { key: string; value: unknown }) =>
    refuse.delete(e.key) ? { deny: 'Lock file is already being held' } : (store.set(e.key, e.value), { value: undefined }),
  )
}

test('a valid list is stored, counted and published to the board', async ($, on) => {
  const store = new Map<string, unknown>()
  session(on, store)
  const answer = await $.tool.call({
    tool: TOOL,
    title: 'Port fixes',
    steps: [
      { step: 'Read', status: 'done' },
      { step: 'Patch', status: 'running', note: 'collision' },
      { step: 'Commit', status: 'pending' },
    ],
  })
  expect(answer.result).toBe('Checklist updated: 1 of 3 steps done.')
  expect(store.get('list:s1')).toEqual(expect.objectContaining({ title: 'Port fixes', updated: expect.any(String) }))
  expect(store.get('session:s1')).toEqual(
    expect.objectContaining({ name: 'app', title: 'Port fixes', step: 'step 2/3', ctx: 23, state: 'idle' }),
  )
})

const NOTE = { message: 'Claude needs your permission to use Bash', session_id: 's1', transcript_path: '', cwd: '/x' }

test('a permission prompt in the main session shows "waiting on you"', async ($, on) => {
  const store = new Map<string, unknown>()
  session(on, store)
  on('classic.Notification', () => ({}))
  await $.classic.Notification({ ...NOTE, notification_type: 'permission_prompt' })
  expect(store.get('session:s1')).toEqual(expect.objectContaining({ state: 'needs-you' }))
})

test('an agent inside a workflow never makes a session "waiting on you"', async ($, on) => {
  const store = new Map<string, unknown>()
  session(on, store)
  on('classic.Notification', () => ({}))
  await $.classic.Notification({ ...NOTE, notification_type: 'permission_prompt', agent_id: 'wf_6227ae77-c83-3' })
  await $.classic.Notification({ ...NOTE, notification_type: 'idle_prompt' })
  expect(store.get('session:s1')).toBe(undefined)
})

test('board step and idle time', () => {
  const steps = [
    { step: 'a', status: 'done' as const },
    { step: 'b', status: 'running' as const },
    { step: 'c', status: 'pending' as const },
  ]
  expect(stepOf({ title: 't', steps, updated: '' })).toBe('step 2/3')
  expect(stepOf({ title: 't', steps: steps.map(s => ({ ...s, status: 'done' as const })), updated: '' })).toBe('step 3/3')
  expect(ago(14 * 60_000)).toBe('14m')
  expect(ago(75 * 60_000)).toBe('1h 15m')
})

test('a malformed list is refused with the reason', async ($, on) => {
  session(on, new Map())
  const answer = await $.tool.call({ tool: TOOL, title: 'x', steps: [{ step: 'a', status: 'later' }] })
  expect(answer.isError).toBe(true)
  expect(answer.result).toBe('Checklist not changed: steps[0].status must be one of done, running, pending, failed')
})

test('the policy is appended when the tool is offered and something draws', async ($, on) => {
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' }] }))
  const drawn = await $.prompt.compose({ ...FACTS, tools: [TOOL], surfaces: ['terminal'] })
  expect(drawn.sections.map(s => s.id)).toEqual(['intro', 'checklist:policy'])
  expect(drawn.sections[1]?.scope).toBe('session')
})

test('no policy without the tool or without a surface', async ($, on) => {
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' }] }))
  const noTool = await $.prompt.compose({ ...FACTS, tools: ['Bash'], surfaces: ['terminal'] })
  const noSurface = await $.prompt.compose({ ...FACTS, tools: [TOOL], surfaces: [] })
  expect(noTool.sections.map(s => s.id)).toEqual(['intro'])
  expect(noSurface.sections.map(s => s.id)).toEqual(['intro'])
})

// Stand-ins for the turn events: the main loop's when agentId is left out.
// biome-ignore lint: the test registrar's overloads are not worth spelling out here
function turns(on: any) {
  on('turn.start', (_$: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
}
const END = { answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' as const }
type Saved = { steps: { status: string }[]; finish?: boolean }

test('finish marks the running steps done when the turn answers', async ($, on) => {
  const store = new Map<string, unknown>()
  session(on, store)
  turns(on)
  await $.tool.call({ tool: TOOL, ...PLAN, finish: true })
  await $.turn.complete(END)
  const saved = store.get('list:s1') as Saved
  expect(saved.steps.map(s => s.status)).toEqual(['done', 'done', 'pending'])
  expect(saved.finish).toBe(undefined)
  expect(store.get('session:s1')).toEqual(expect.objectContaining({ step: 'step 2/3', state: 'idle' }))
})

test('finish waits while an agent turn runs, then fires at a later turn end', async ($, on) => {
  const store = new Map<string, unknown>()
  session(on, store)
  turns(on)
  await $.tool.call({ tool: TOOL, ...PLAN, finish: true })
  await $.turn.start({ text: '', turnId: 'a1', agentId: 'agent-1' })
  await $.turn.complete(END)
  expect((store.get('list:s1') as Saved).steps.map(s => s.status)).toEqual(['done', 'running', 'pending'])
  expect((store.get('list:s1') as Saved).finish).toBe(true)
  await $.turn.complete({ ...END, turnId: 'a1', agentId: 'agent-1' })
  await $.turn.complete({ ...END, turnId: 't2' })
  expect((store.get('list:s1') as Saved).steps.map(s => s.status)).toEqual(['done', 'done', 'pending'])
})

test('finish does not fire on an aborted turn', async ($, on) => {
  const store = new Map<string, unknown>()
  session(on, store)
  turns(on)
  await $.tool.call({ tool: TOOL, ...PLAN, finish: true })
  await $.turn.complete({ ...END, isAborted: true, reason: 'aborted' })
  expect((store.get('list:s1') as Saved).steps.map(s => s.status)).toEqual(['done', 'running', 'pending'])
})

test('a whole list without finish, or finish false, clears it', async ($, on) => {
  const store = new Map<string, unknown>()
  session(on, store)
  await $.tool.call({ tool: TOOL, ...PLAN, finish: true })
  await $.tool.call({ tool: TOOL, changes: [{ number: 3, status: 'running' }] })
  expect((store.get('list:s1') as Saved).finish).toBe(true)
  await $.tool.call({ tool: TOOL, changes: [{ number: 3, status: 'pending' }], finish: false })
  expect((store.get('list:s1') as Saved).finish).toBe(undefined)
  await $.tool.call({ tool: TOOL, ...PLAN, finish: true })
  await $.tool.call({ tool: TOOL, ...PLAN })
  expect((store.get('list:s1') as Saved).finish).toBe(undefined)
})

test('the board record counts agent turns while the main turn is not running', async ($, on) => {
  const store = new Map<string, unknown>()
  session(on, store)
  turns(on)
  await $.turn.start({ text: '', turnId: 'a1', agentId: 'agent-1' })
  await $.turn.start({ text: '', turnId: 'a2', agentId: 'agent-2' })
  expect(store.get('session:s1')).toEqual(expect.objectContaining({ agents: 2, state: 'idle' }))
  await $.turn.complete({ ...END, turnId: 'a1', agentId: 'agent-1' })
  expect(store.get('session:s1')).toEqual(expect.objectContaining({ agents: 1 }))
  await $.turn.complete({ ...END, turnId: 'a2', agentId: 'agent-2' })
  expect(store.get('session:s1')).toEqual(expect.objectContaining({ agents: 0 }))
})

test('the board hides records not seen lately and keeps older versions by their own rule', async ($, on) => {
  const now = Date.now()
  const row = { title: '', step: '', ctx: 5, state: 'idle', agents: 0 }
  const store = new Map<string, unknown>([
    ['session:a', { ...row, name: 'checklist', at: now - 14 * 60_000, seen: now }],
    ['session:b', { ...row, name: 'crashed', at: now, seen: now - 4 * 30_000 }],
    ['session:c', { ...row, name: 'old', state: 'idle', at: now - 60_000, agents: undefined }],
    ['session:d', { ...row, name: 'gone', at: now - 13 * 60 * 60_000, agents: undefined }],
    ['session:e', { ...row, name: 'busy', agents: 2, at: now, seen: now }],
  ])
  session(on, store)
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('agent.list', () => ({ value: [] }))
  const ui = await $.ui.mount({
    plugin: 'checklist',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'checklist',
    props: { title: 'Checklist', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
  })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts.filter(t => /^[○▸●] /.test(t))).toEqual([
    `▸ busy      2 agents running    ctx  5%`,
    `○ checklist idle 14m          ctx  5%`,
    `○ old       idle 1m           ctx  5%`,
  ])
})

test('a store write that fails once is tried again and the tool call still answers', async ($, on) => {
  const store = new Map<string, unknown>()
  const refuse = new Set(['list:s1'])
  session(on, store, refuse)
  on('clock.sleep', () => ({ value: undefined }))
  const answer = await $.tool.call({ tool: TOOL, ...PLAN })
  expect(answer.result).toBe('Checklist updated: 1 of 3 steps done.')
  expect(refuse.size).toBe(0)
  expect(store.get('list:s1')).toEqual(expect.objectContaining({ title: 'Port fixes' }))
})
