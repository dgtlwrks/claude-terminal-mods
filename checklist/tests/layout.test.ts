import { type Engine, expect, test } from 'claude-code/testing'

import { type Block, type Line, type Piece, parseLayout, plain, resolveLine } from '../hooks/layout'
import { type View, blockRows } from '../hooks/register'
import { layoutFiles } from './layout-files'

const el = (key: string, text?: string, more: object = {}) => ({ key, ...(text === undefined ? {} : { text }), ...more })
const line = (...elements: ReturnType<typeof el>[]): Line => ({ key: 'l', elements })

test('an empty data element leaves with the icons and the separator before it', () => {
  const l = line(el('text', '['), el('model', '', { spaceBefore: 0 }), el('sep', '·'), el('effort'), el('text', ']', { spaceBefore: 0 }), el('emoji', '📁'), el('cwd'))
  expect(plain(resolveLine(l, { model: 'Opus', effort: '', cwd: '~/app' }))).toBe('[Opus] 📁 ~/app')
  expect(plain(resolveLine(l, { model: 'Opus', effort: 'high', cwd: '' }))).toBe('[Opus · high]')
})

test('a separator shows only between two runs that hold data', () => {
  const l = line(el('mark', '↳'), el('text', 'this turn:'), el('turn.out'), el('sep', '·'), el('turn.time'), el('sep', '·'), el('turn.tools'))
  expect(plain(resolveLine(l, { 'turn.out': '', 'turn.time': '3s', 'turn.tools': '1 tool call' }))).toBe('↳ this turn: 3s · 1 tool call')
  expect(plain(resolveLine(l, { 'turn.out': '2k out', 'turn.time': '3s', 'turn.tools': '' }))).toBe('↳ this turn: 2k out · 3s')
})

test('a key the surface does not know is left out, and an empty one with a width keeps its columns', () => {
  const l = line(el('name', 'x', { width: 5 }), el('alert', '🔔', { width: 2 }), el('cost', '$1'), el('text', 'ctx'))
  expect(plain(resolveLine(l, { name: 'api', alert: '' }))).toBe('api      ctx')
  expect(plain(resolveLine(l, { name: 'api', alert: '🔔' }))).toBe('api   🔔 ctx')
})

test('only a version 1 layout of this format is read', () => {
  expect(parseLayout('{"format":"claude-terminal-layout","version":2}')).toBe(undefined)
  expect(parseLayout('not json')).toBe(undefined)
  expect(parseLayout('{"format":"claude-terminal-layout","version":1}')).toEqual({ sidebar: [], bandAbovePrompt: [], turnSummary: [], statusLine: [] })
})

// biome-ignore lint: the test registrar's overloads are not worth spelling out here
function world(on: any, own?: unknown, agents: object[] = []) {
  layoutFiles(on, own)
  const now = Date.now()
  const store = new Map<string, unknown>([
    ['session:a', { name: 'api', title: 'Fix login', step: '', ctx: 61, state: 'needs-you', agents: 0, at: now, seen: now }],
    ['session:b', { name: 'docs', title: '', step: '', ctx: 8, state: 'idle', agents: 0, at: now - 14 * 60_000, seen: now }],
  ])
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.id', () => ({ value: 's1' }))
  on('session.root', () => ({ value: '/Users/me/projects/api' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 1, window: 10 }, rateLimits: [] } }))
  on('store.get', (_$: unknown, e: { key: string }) => ({ value: store.get(e.key) }))
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('agent.list', () => ({ value: agents }))
}
const PANE = {
  plugin: 'checklist',
  surface: 'terminal',
  component: 'Pane',
  requestId: 'checklist',
  props: { title: 'Checklist', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const
const layout = (o: object) => ({ format: 'claude-terminal-layout', version: 1, sidebar: [], bandAbovePrompt: [], turnSummary: [], statusLine: [], ...o })

test('without a layout of the person, the pane draws the shipped default', async ($, on) => {
  world(on)
  const ui = await $.ui.mount(PANE)
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts).toContain('● api   waiting on you 🔔 ctx 61%')
  expect(texts).toContain('  Fix login')
  expect(texts).toContain('○ docs  idle 14m          ctx  8%')
})

test('the person moves the bell to the front of the row and adds a block of their own', async ($, on) => {
  world(
    on,
    layout({
      sidebar: [
        { key: 'sessions', title: 'Sessions', lines: [{ key: 'session.row', elements: [el('session.alert'), el('session.name'), el('sep', '|'), el('session.ctx')] }] },
        { key: 'custom', title: 'Notes', lines: [{ key: 'line', elements: [el('emoji', '🚀'), el('text', 'ship friday')] }] },
      ],
    }),
  )
  const ui = await $.ui.mount(PANE)
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts).toContain('🔔 api  | 61%')
  expect(texts).toContain('docs | 8%')
  expect(texts).toContain('🚀 ship friday')
})

test('a block in the band above the prompt draws there, and an empty band passes', async ($, on) => {
  world(on, layout({ bandAbovePrompt: [{ key: 'custom', title: '', lines: [{ key: 'line', elements: [el('text', 'deploy freeze until 18:00')] }] }] }))
  const band = await $.ui.mount({
    plugin: 'checklist',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} },
  })
  expect((await band.findAll({ type: 'Text' })).map(t => t.text)).toContain('deploy freeze until 18:00')
})

test('/checklist says so when the layout puts nothing in the sidebar', async ($, on) => {
  world(on, layout({}))
  const answer = await $.command.run({ command: 'checklist', args: '' } as never) // the engine fills in origin and presentation
  expect(answer.text).toBe('The layout puts no block in the sidebar, so there is no pane to open.')
})

const BAND = layout({ bandAbovePrompt: [{ key: 'custom', title: '', lines: [{ key: 'line', elements: [el('text', 'deploy freeze until 18:00')] }] }] })
const bandProps = (hasSurvey: boolean) => ({ hasSurvey, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} })

test('the band yields to a survey and comes back when it is gone', async ($, on) => {
  world(on, BAND)
  // What the band shows when the hook passes: the engine's own row, here a stand-in.
  on('ui.render', ($: any, e: any) => $.ui.resolve(e).Text({ children: 'the survey' }))
  const shown = async (hasSurvey: boolean) =>
    (await (await $.ui.mount({ plugin: 'checklist', surface: 'terminal', component: 'AbovePrompt', props: bandProps(hasSurvey) })).findAll({ type: 'Text' })).map(t => t.text)
  expect(await shown(true)).toEqual(['the survey'])
  expect(await shown(false)).toContain('deploy freeze until 18:00')
  expect(await shown(false)).not.toContain('the survey')
})

// What a pane shows when the person's file is not a layout this version reads: the shipped default.
async function paneTexts($: Engine) {
  return (await (await $.ui.mount(PANE)).findAll({ type: 'Text' })).map(t => t.text)
}

test('a file that is not JSON leaves the default layout in place', async ($, on) => {
  world(on, '{ "sidebar": [')
  expect(await paneTexts($)).toContain('● api   waiting on you 🔔 ctx 61%')
})

test('a layout of another version or format leaves the default layout in place', async ($, on) => {
  world(on, layout({ version: 2, sidebar: [] }))
  expect(await paneTexts($)).toContain('● api   waiting on you 🔔 ctx 61%')
})

test('a file that cannot be read leaves the default layout in place', async ($, on) => {
  world(on, new Error('EACCES'))
  expect(await paneTexts($)).toContain('○ docs  idle 14m          ctx  8%')
})

test('a running subagent shows its time, taken from when it was spawned', async ($, on) => {
  world(on, undefined, [{ id: 'a1', type: 'Explore', status: 'running', description: '' }])
  on('agent.spawn', () => ({ agentId: 'a1', model: 'm' }))
  await $.agent.spawn({ prompt: 'look', description: 'look', subagentType: 'Explore' } as never) // the stub below answers it
  const texts = await paneTexts($)
  expect(texts.some(t => /^▸ Explore\s+running 0:0\d$/.test(t))).toBe(true)
})

// ── The rows of one block, from a view ───────────────────────────────────────
const text = (r: Piece[]) => r.map(p => p.text).join('')
const view = (o: Partial<View> = {}): View => ({ list: { title: '', steps: [], updated: '' }, sessions: [], agents: [], now: 1_000_000, ...o })
const block = (key: string, lines: Line[], more: Partial<Block> = {}): Block => ({ key, title: '', lines, ...more })
const session = (name: string, o: object = {}) => ({ name, title: '', step: '', ctx: 5, state: 'idle' as const, agents: 0, at: 1_000_000, seen: 1_000_000, ...o })
const PLAN = {
  title: 'Port',
  updated: '16:58 UTC',
  steps: [
    { step: 'Read', status: 'done' as const, when: '16:40 UTC' },
    { step: 'Patch', status: 'running' as const, note: 'collision' },
    { step: 'Commit', status: 'pending' as const },
  ],
}
const stepLine: Line = { key: 'checklist.step', elements: [el('step.mark'), el('step.num'), el('step.text', undefined, { style: ['g', 'b'] }), el('step.when', undefined, { spaceBefore: 2 })] }

test('a step draws once per step, its note dim under it, its time after it', () => {
  const rows = blockRows(block('checklist', [stepLine, stepLine]), view({ list: PLAN }))!
  expect(rows.map(text)).toEqual(['✓ 1. Read  (16:40 UTC)', '▸ 2. Patch', '   collision', '○ 3. Commit'])
  expect(rows[2]).toEqual([{ text: '   collision', style: ['dim'] }])
})

test("a pattern's colors are dropped for the state's, and bold stays", () => {
  const rows = blockRows(block('checklist', [stepLine]), view({ list: PLAN }))!
  const word = (i: number) => rows[i]!.find(p => p.text === ['Read', 'Patch', '', 'Commit'][i])!.style
  expect(word(0)).toEqual(['b', 'g', 'dim']) // pattern 'g' is gone; done is green and dim
  expect(word(1)).toEqual(['b', 'y'])
  expect(word(3)).toEqual(['b', 'dim'])
})

test('a checklist without steps says so under its title, and its badge stays hidden', () => {
  const rows = blockRows(block('checklist', [stepLine], { title: 'Checklist', badge: 'count' }), view())!
  expect(rows.map(text)).toEqual(['Checklist', 'No checklist yet.'])
})

test("a built-in block's badge is the live count whatever the badge says, and gone at zero", () => {
  const two = view({ sessions: [session('api'), session('docs')] })
  const row: Line = { key: 'session.row', elements: [el('session.name')] }
  expect(blockRows(block('sessions', [row], { title: 'Sessions', badge: 'anything' }), two)!.map(text)[0]).toBe('Sessions  2 ')
  expect(blockRows(block('sessions', [row], { title: 'Sessions', badge: 'count' }), view())).toBe(undefined)
  const steps = blockRows(block('checklist', [stepLine], { title: 'Checklist', badge: 'x' }), view({ list: PLAN }))!
  expect(text(steps[0]!)).toBe('Checklist  3 ')
  expect(steps[0]!.at(-1)!.style).toContain('tagel')
})

test("an own block's badge is its text, and a block with no title draws no badge", () => {
  const l: Line = { key: 'line', elements: [el('text', 'hello')] }
  expect(blockRows(block('custom', [l], { title: 'Notes', badge: 'new' }), view())!.map(text)).toEqual(['Notes  new ', 'hello'])
  expect(blockRows(block('custom', [l], { badge: 'new' }), view())!.map(text)).toEqual(['hello'])
})

test('sessions and subagents with no rows are not drawn', () => {
  const row: Line = { key: 'x', elements: [el('session.name')] }
  expect(blockRows(block('sessions', [row], { title: 'Sessions' }), view())).toBe(undefined)
  expect(blockRows(block('subagents', [row], { title: 'Subagents' }), view())).toBe(undefined)
})

test('a session task draws under each session that has a title, in the row pattern', () => {
  const row: Line = { key: 'session.row', elements: [el('session.name', undefined, { width: 3 }), el('session.ctx')] }
  const task: Line = { key: 'session.task', elements: [el('spacer', undefined, { width: 1 }), el('session.task')] }
  const rows = blockRows(block('sessions', [row, task]), view({ sessions: [session('api', { title: 'Fix login' }), session('docs')] }))!
  expect(rows.map(text)).toEqual(['api  5%', '  Fix login', 'docs 5%'])
})

test('a subagent row shows how long a live agent has run, and nothing for a finished one', () => {
  const row: Line = { key: 'subagent.row', elements: [el('agent.state'), el('agent.type', undefined, { width: 8 }), el('agent.status'), el('agent.time')] }
  const agents = [
    { type: 'Explore', status: 'running', started: 1_000_000 - 65_000 },
    { type: 'Plan', status: 'completed', started: 1_000_000 - 90_000 },
    { type: 'Odd', status: 'running' },
  ]
  expect(blockRows(block('subagents', [row]), view({ agents }))!.map(text)).toEqual(['▸ Explore  running 1:05', '✓ Plan     completed', '▸ Odd      running'])
})

test('segments of a literal bar keep their styles, and the element style goes under them', () => {
  const bar = el('bar', undefined, { style: ['b'], segments: [{ text: '██', style: ['g'] }, { text: '░░', style: ['dim'] }] })
  expect(resolveLine({ key: 'l', elements: [bar] }, {})).toEqual([
    { text: '██', style: ['b', 'g'] },
    { text: '░░', style: ['b', 'dim'] },
  ])
})

test('a width pads on the right, or on the left with align right', () => {
  const l = line(el('a', undefined, { width: 5 }), el('b', undefined, { width: 5, align: 'right' }), el('text', '|'))
  expect(plain(resolveLine(l, { a: 'ab', b: 'cd' }))).toBe('ab       cd |')
  expect(resolveLine(l, { a: 'ab', b: 'cd' }).map(p => p.text)).toEqual(['ab', '   ', ' ', '   ', 'cd', ' ', '|'])
})

test('a pictograph takes two columns of a width, a joiner and a variation selector none', () => {
  const pad = (text: string) => plain(resolveLine(line(el('a', undefined, { width: 4 }), el('text', '|')), { a: text }))
  expect(pad('🔔')).toBe('🔔   |') // 2 columns + 2 pad + 1 space
  expect(pad('✔️')).toBe('✔️   |') // text symbol + VS16: 2 columns
  expect(pad('ab')).toBe('ab   |')
  expect(pad('👨‍👩')).toBe('👨‍👩 |') // two pictographs, one joiner: 4 columns, no pad
  expect(pad('⚡')).toBe('⚡   |') // drawn as an emoji without U+FE0F: 2 columns
  expect(pad('❄')).toBe('❄    |') // a text symbol: 1 column
  expect(pad('⏱️')).toBe('⏱️   |') // a text symbol made an emoji by U+FE0F: 2 columns
})

test('terminal control characters never reach the screen', () => {
  const l = line(el('text', 'a\u001b[2Jb'), el('step.text'))
  expect(plain(resolveLine(l, { 'step.text': 'x\u001b]8;;http://evil\u0007y\u009bz' }))).toBe('a[2Jb x]8;;http://evilyz')
})
