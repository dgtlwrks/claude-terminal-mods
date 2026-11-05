import { expect, mock, test } from 'claude-code/testing'
import { layoutFiles } from './layout-files'

// Each test states what SHOULD happen. A failing test = a confirmed bug or gap in the live mod.
const TOOL = 'mcp__checklist__set'
const PLAN = {
  title: 'Port fixes',
  steps: [
    { step: 'Read', status: 'done' },
    { step: 'Patch', status: 'running' },
    { step: 'Commit', status: 'pending' },
  ],
}
type Saved = { title: string; steps: { status: string }[] }

// Stand-ins for what a session answers. `id.now` is the session id, which /clear and resume change.
// biome-ignore lint: the test registrar's overloads are not worth spelling out here
function session(on: any, store: Map<string, unknown>, id: { now: string }) {
  layoutFiles(on)
  const calls = { toolRegister: 0, invalidate: 0, open: 0 }
  on('ui.open', () => (calls.open++, { value: { isPlaced: true } }))
  on('ui.invalidate', () => (calls.invalidate++, { value: undefined }))
  on('tool.register', () => (calls.toolRegister++, { value: { tool: TOOL } }))
  on('command.register', () => ({ value: { command: 'checklist' } }))
  on('session.id', () => ({ value: id.now }))
  on('session.cwd', () => ({ value: '/Users/me/projects/app/tools/web' }))
  on('session.root', () => ({ value: '/Users/me/projects/app' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 226_000, window: 1_000_000 }, rateLimits: [] } }))
  on('store.get', (_$: unknown, e: { key: string }) => ({ value: store.get(e.key) }))
  on('store.set', (_$: unknown, e: { key: string; value: unknown }) => (store.set(e.key, e.value), { value: undefined }))
  on('store.delete', (_$: unknown, e: { key: string }) => (store.delete(e.key), { value: undefined }))
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('session.end', (_$: unknown, e: { sessionId: string }) => ({ sessionId: e.sessionId }))
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  return calls
}

test('AUDIT an agent cannot replace the main session checklist', async ($, on) => {
  const store = new Map<string, unknown>()
  session(on, store, { now: 's1' })
  await $.tool.call({ tool: TOOL, ...PLAN })
  await $.tool.call({ tool: TOOL, agentId: 'wf_0f0845af-cb4', title: 'Task 5.8 part 2', steps: [{ step: 'Write file', status: 'running' }] })
  expect((store.get('list:s1') as Saved).title).toBe('Port fixes')
})

test('AUDIT /clear starts the new conversation with an empty checklist', async ($, on) => {
  const store = new Map<string, unknown>()
  const id = { now: 's1' }
  session(on, store, id)
  await $.tool.call({ tool: TOOL, ...PLAN })
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  id.now = 's2'
  const answer = await $.tool.call({ tool: TOOL, changes: [{ number: 1, status: 'pending' }] })
  expect(answer.isError).toBe(true)
  expect(store.get('list:s2')).toBe(undefined)
})

test('AUDIT resuming another session in the same window keeps that session list', async ($, on) => {
  const store = new Map<string, unknown>()
  const id = { now: 's1' }
  session(on, store, id)
  store.set('list:s2', { title: 'Other task', steps: [{ step: 'A', status: 'running' }, { step: 'B', status: 'pending' }], updated: '', at: Date.now() })
  await $.tool.call({ tool: TOOL, ...PLAN })
  await $.session.end({ reason: 'resume', sessionId: 's1', resume: { id: 's1' } })
  id.now = 's2'
  await $.tool.call({ tool: TOOL, changes: [{ number: 1, status: 'done' }] })
  expect((store.get('list:s2') as Saved).title).toBe('Other task')
})

test('AUDIT the board keeps refreshing after /clear', async ($, on) => {
  const store = new Map<string, unknown>()
  const calls = session(on, store, { now: 's1' })
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/Users/me/projects/app', surface: 'terminal', isInteractive: true })
  await clock.advance(11_000)
  const before = calls.invalidate
  expect(before).toBeGreaterThan(0)
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  await clock.advance(30_000)
  expect(calls.invalidate).toBeGreaterThan(before)
})

test('AUDIT the board names a session after its project, not the folder it is working in', async ($, on) => {
  const store = new Map<string, unknown>()
  session(on, store, { now: 's1' })
  await $.tool.call({ tool: TOOL, ...PLAN })
  expect((store.get('session:s1') as { name: string }).name).toBe('app')
})

test('AUDIT a -p run (nobody watching) gets no checklist tool', async ($, on) => {
  const store = new Map<string, unknown>()
  const calls = session(on, store, { now: 's1' })
  await $.session.start({ cwd: '/Users/me/projects/app', surface: null, isInteractive: false })
  expect(calls.toolRegister).toBe(0)
  expect(store.get('session:s1')).toBe(undefined)
})

test('AUDIT resending the whole list without a title keeps the title', async ($, on) => {
  const store = new Map<string, unknown>()
  session(on, store, { now: 's1' })
  await $.tool.call({ tool: TOOL, ...PLAN })
  const answer = await $.tool.call({ tool: TOOL, steps: [...PLAN.steps, { step: 'Push', status: 'pending' }] })
  expect(answer.isError).not.toBe(true)
  expect((store.get('list:s1') as Saved).title).toBe('Port fixes')
})
