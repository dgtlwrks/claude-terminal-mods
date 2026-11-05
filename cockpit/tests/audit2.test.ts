import { expect, mock, test } from 'claude-code/testing'
import { layoutFiles } from './layout-files'

// Each test states what SHOULD happen. A failing test = a confirmed bug in the live mod.
// biome-ignore lint: the test registrar's overloads are not worth spelling out here
function session(on: any, store: Map<string, unknown>, id: { now: string }) {
  layoutFiles(on)
  mock.clock(on)
  on('session.id', () => ({ value: id.now }))
  on('session.root', () => ({ value: '/Users/me/projects/app' }))
  on('store.get', (_$: unknown, e: { key: string }) => ({ value: store.get(e.key) }))
  on('store.set', (_$: unknown, e: { key: string; value: unknown }) => (store.set(e.key, JSON.parse(JSON.stringify(e.value))), { value: undefined }))
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }))
  on('turn.start', (_$: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', (_$: unknown, e: { answer: string }) => ({ text: e.answer }))
  on('session.end', (_$: unknown, e: { sessionId: string }) => ({ sessionId: e.sessionId }))
  on('tool.call', () => ({ result: 'ran' }))
}
const END = { answer: 'ok', durationMs: 1000, isAborted: false, reason: 'answer' as const }
type Usage = { checklistCalls: number }

test('AUDIT after /clear the previous conversation is not counted a second time', async ($, on) => {
  const store = new Map<string, unknown>()
  const id = { now: 's1' }
  session(on, store, id)
  // The model answers its one request with a checklist call.
  on('turn.step', async function* (_$: unknown, e: { turnId: string; index: number }) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [{ name: 'mcp__checklist__set', input: {} }], stopReason: 'tool_use', usage: null }
  })
  await $.turn.start({ text: 'go', turnId: 't1' })
  const step = $.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 1 })
  for await (const _chunk of step) {
    // the stand-in yields nothing; the response is its return value
  }
  await step.result
  await $.turn.complete({ ...END, turnId: 't1' })
  expect((store.get('usage:s1') as Usage).checklistCalls).toBe(1)
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  id.now = 's2'
  await $.turn.start({ text: 'again', turnId: 't2' })
  await $.turn.complete({ ...END, turnId: 't2' })
  expect((store.get('usage:s2') as Usage).checklistCalls).toBe(0)
})

test('AUDIT the turn line counts the main session tool calls, not the agents', async ($, on) => {
  const store = new Map<string, unknown>()
  session(on, store, { now: 's1' })
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'a1' })
  await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'a1' })
  const done = await $.turn.complete({ ...END, turnId: 't1' })
  expect(done.text).toContain('· 1 tool call')
})
