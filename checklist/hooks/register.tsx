import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Checklist, SessionRecord, Step, StepStatus } from '../types'
import { type Block, type Line, type Piece, loadLayout, printable, resolveLine, width } from './layout'

// ── Sessions board ────────────────────────────────────────────────────────────
// Each session writes one record to $.store, which every session on this Mac shares, and the
// pane re-reads all records on a timer (no event fires when another session writes).
const BOARD = 'session:'
const REFRESH_MS = 30_000
const SEEN_MS = 3 * REFRESH_MS // a record not touched this long belongs to a crashed session
const STALE_MS = 12 * 60 * 60_000 // the same for records without `seen`, from older versions
const NAME_MAX = 14

// A copy of each session's list in $.store (on disk), so the list comes back after /restart.
const SAVED = 'list:'
const KEEP_MS = 14 * 24 * 60 * 60_000 // lists of sessions untouched this long are dropped

const EMPTY: Checklist = { title: '', steps: [], updated: '' }

const agentStart = new Map<string, number>()
const running = new Set<string>() // agent turns running now, by agent id
let stopRefresh: (() => void) | undefined
let needsYou = false // a permission prompt is open in this session
let mainRunning = false // a turn of the main conversation is running
let headless = false // a -p or SDK run: nobody sees a pane or the board
let loaded: string | undefined // the session whose list is in the state
let mine: { key: string; record: SessionRecord } | undefined // this session's last published record

// Two sessions writing at once can make a write fail ("Lock file is already being held"):
// try once more, then give up rather than break the hook.
async function put($: EngineInterface, key: string, value: unknown) {
  try {
    await $.store.set(key, value)
  } catch {
    try {
      await $.clock.sleep(50)
      await $.store.set(key, value)
    } catch {}
  }
}

async function drop($: EngineInterface, key: string) {
  try {
    await $.store.delete(key)
  } catch {
    try {
      await $.clock.sleep(50)
      await $.store.delete(key)
    } catch {}
  }
}

async function save($: EngineInterface, value: Checklist) {
  await put($, SAVED + (await $.session.id()), { ...value, at: Date.now() })
}

async function saved($: EngineInterface, id: string): Promise<Checklist | undefined> {
  const s = (await $.store.get(SAVED + id)) as Partial<Checklist> | undefined
  if (!s || typeof s.title !== 'string' || !Array.isArray(s.steps) || s.steps.length === 0) return undefined
  return { title: s.title, steps: s.steps, updated: typeof s.updated === 'string' ? s.updated : '', ...(s.finish === true ? { finish: true } : {}) }
}

async function restore($: EngineInterface): Promise<Checklist | undefined> {
  const now = Date.now()
  for (const key of await $.store.keys()) {
    if (key.startsWith(BOARD)) {
      // A crashed session's record is hidden by `seen`; once it is this old it is removed too.
      const r = (await $.store.get(key)) as Partial<SessionRecord> | undefined
      if (now - (r?.seen ?? r?.at ?? 0) > STALE_MS) await drop($, key)
      continue
    }
    if (!key.startsWith(SAVED)) continue
    const old = (await $.store.get(key)) as { at?: number } | undefined
    if (!old?.at || now - old.at > KEEP_MS) await drop($, key)
  }
  return saved($, await $.session.id())
}

// After /clear or resume the process goes on under a new session id and no session.start fires:
// load that session's own list (or none) and put it on the board.
async function ensure($: EngineInterface) {
  const id = await $.session.id()
  if (id === loaded) return
  loaded = id
  const value = (await saved($, id)) ?? EMPTY
  await update($, list, () => value)
  await publish($, { step: stepOf(value), title: value.title, state: 'idle', agents: running.size })
}

// Step shown on the board: the running step's number, else how many are done.
export function stepOf(c: Checklist): string {
  if (c.steps.length === 0) return ''
  const running = c.steps.findIndex(s => s.status === 'running')
  const n = running >= 0 ? running + 1 : c.steps.filter(s => s.status === 'done').length
  return `step ${n}/${c.steps.length}`
}

export function ago(ms: number): string {
  const m = Math.floor(ms / 60_000)
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`
}

async function publish($: EngineInterface, patch: Partial<SessionRecord>) {
  if (headless) return
  const key = BOARD + (await $.session.id())
  const prev = (await $.store.get(key)) as SessionRecord | undefined
  const { context } = await $.session.usage()
  const ctx = context.window > 0 ? Math.round((100 * (context.tokens ?? 0)) / context.window) : 0
  const name = (await $.session.root()).split('/').pop() || 'session'
  const now = Date.now()
  const record: SessionRecord = { step: '', title: '', state: 'idle', agents: 0, ...prev, name, ctx, ...patch, at: now, seen: now }
  mine = { key, record }
  await put($, key, record)
  $.ui.invalidate('ui.render')
}

// The timer's light touch: only `seen` moves, `at` still dates the last state change.
async function touch($: EngineInterface) {
  const last = mine
  if (last) await put($, last.key, { ...last.record, seen: Date.now() })
}

async function tick($: EngineInterface) {
  await ensure($)
  await touch($)
  $.ui.invalidate('ui.render')
}

async function board($: EngineInterface): Promise<SessionRecord[]> {
  const now = Date.now()
  const rows: SessionRecord[] = []
  for (const key of await $.store.keys()) {
    if (!key.startsWith(BOARD)) continue
    const r = (await $.store.get(key)) as SessionRecord | undefined
    if (!r) continue
    if (typeof r.seen === 'number' ? now - r.seen <= SEEN_MS : now - r.at < STALE_MS) rows.push(r)
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name))
}

const PANE = 'checklist'
const TOOL = 'mcp__checklist__set'
const STATUSES: StepStatus[] = ['done', 'running', 'pending', 'failed']
// Change the tag when Checklist's fields change: it declines what an earlier version stored.
const list = atom({ plugin: 'checklist', key: 'list' } as const, EMPTY, {
  shape: 'checklist-3',
})

// Added to the system prompt of every request that offers the tool and has a surface to draw on.
const POLICY =
  'A Checklist pane beside the chat shows the person your task list. For any task with three or more steps, ' +
  `call ${TOOL} with title and steps once the plan is set. After that send only what changed, as ` +
  'changes: [{number, status}] (numbers start at 1), each time a step starts, finishes or fails. ' +
  'Send the whole list again only when steps are added, removed or reordered. Skip it for one-step answers and lookups. ' +
  'Put the call in the same message as other tool calls, never as a step of its own. ' +
  'With the last step add finish: true: running steps are then marked done when you finish answering, so send no ' +
  'final update (if you stop before the work is done, send finish: false).'

const MARK: Record<StepStatus, { sign: string; style: string[] }> = {
  done: { sign: '✓', style: ['g', 'dim'] },
  running: { sign: '▸', style: ['y'] },
  pending: { sign: '○', style: ['dim'] },
  failed: { sign: '✗', style: ['r'] },
}

// ── Drawing from the layout ───────────────────────────────────────────────────
// The sidebar and the band above the prompt draw the layout's blocks. In a built-in block (checklist,
// sessions, subagents) the first line of each row kind is the pattern for every row; later ones are samples.

export type AgentRow = { type: string; status: string; started?: number }
export type View = { list: Checklist; sessions: SessionRecord[]; agents: AgentRow[]; now: number }

const COLORS = new Set(['g', 'y', 'r', 'c', 'm', 'dim'])
const strip = (s?: string[]) => s?.filter(c => !COLORS.has(c))

// A row pattern gives up its colors: the row's state colors it.
function pattern(l: Line, widths: Record<string, number> = {}): Line {
  return {
    ...l,
    elements: l.elements.map(el => ({
      ...el,
      style: strip(el.style),
      segments: el.segments?.map(s => ({ ...s, style: strip(s.style) })),
      ...(widths[el.key] ? { width: Math.max(el.width ?? 0, widths[el.key]!) } : {}),
    })),
  }
}
const tint = (pieces: Piece[], base: string[]) => pieces.map(p => ({ text: p.text, style: [...p.style, ...base] }))

/** The rows one block draws (a row with no pieces is blank), or undefined when it has nothing to show. */
export function blockRows(b: Block, v: View): Piece[][] | undefined {
  const first = (key: string) => b.lines.find(l => l.key === key)
  if (b.key === 'sessions' && v.sessions.length === 0) return undefined
  if (b.key === 'subagents' && v.agents.length === 0) return undefined
  const rows: Piece[][] = []
  const count = b.key === 'checklist' ? v.list.steps.length : b.key === 'sessions' ? v.sessions.length : b.key === 'subagents' ? v.agents.length : undefined
  if (b.title) {
    const head: Piece[] = [{ text: b.title, style: ['b'] }]
    const badge = count === undefined ? (b.badge ?? '') : b.badge && count > 0 ? String(count) : ''
    if (badge) head.push({ text: ' ', style: [] }, { text: ` ${badge} `, style: ['tagel'] })
    rows.push(head)
  }

  if (b.key === 'checklist') {
    const c = v.list
    if (c.steps.length === 0) return [...rows, [{ text: 'No checklist yet.', style: ['dim'] }]]
    const done = c.steps.filter(s => s.status === 'done').length
    let drawn = false
    for (const l of b.lines) {
      if (l.key !== 'checklist.step') {
        rows.push(resolveLine(l, { 'checklist.title': c.title, 'checklist.done': `${done} of ${c.steps.length} done`, 'checklist.updated': c.updated ? `updated ${c.updated}` : '' }))
        continue
      }
      if (drawn) continue
      drawn = true
      const p = pattern(l)
      c.steps.forEach((s, i) => {
        const data = { 'step.mark': MARK[s.status].sign, 'step.num': `${i + 1}.`, 'step.text': s.step, 'step.when': s.when ? `(${s.when})` : '' }
        rows.push(tint(resolveLine(p, data), MARK[s.status].style))
        if (s.note) rows.push([{ text: `   ${s.note}`, style: ['dim'] }])
      })
    }
    return rows
  }

  if (b.key === 'sessions') {
    const row = first('session.row')
    const task = first('session.task')
    // By code point, so a name with an emoji is never cut inside it; the column is as wide as the widest name.
    const names = v.sessions.map(r => {
      const chars = [...r.name]
      return chars.length > NAME_MAX ? `${chars.slice(0, NAME_MAX - 1).join('')}…` : r.name
    })
    const p = row && pattern(row, { 'session.name': Math.max(0, ...names.map(width)) })
    v.sessions.forEach((r, i) => {
      const n = r.agents ?? 0
      const [sign, status, base] =
        r.state === 'working' ? ['▸', r.step || 'working', ['y']]
        : r.state === 'needs-you' ? ['●', 'waiting on you', ['r']]
        : n > 0 ? ['▸', `${n} agent${n === 1 ? '' : 's'} running`, ['y']]
        : ['○', `idle ${ago(v.now - r.at)}`, ['dim']]
      if (p) {
        const data = { 'session.state': sign, 'session.name': names[i], 'session.status': status, 'session.alert': r.state === 'needs-you' ? '🔔' : '', 'session.ctx': `${r.ctx}%` }
        rows.push(tint(resolveLine(p, data), base))
      }
      if (task && r.title) rows.push(tint(resolveLine(pattern(task), { 'session.task': r.title }), ['dim']))
    })
    return rows
  }

  if (b.key === 'subagents') {
    const row = first('subagent.row')
    if (!row) return rows
    const p = pattern(row)
    for (const a of v.agents) {
      const live = a.status === 'running' || a.status === 'pending' || a.status === 'waiting'
      const ms = live && a.started ? v.now - a.started : -1
      const time = ms >= 0 ? `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')}` : ''
      const [sign, base] = live ? ['▸', ['y']] : a.status === 'completed' ? ['✓', ['g']] : a.status === 'failed' ? ['✗', ['r']] : ['○', ['dim']]
      rows.push(tint(resolveLine(p, { 'agent.state': sign, 'agent.type': a.type, 'agent.status': a.status, 'agent.time': time }), base))
    }
    return rows
  }

  // A block of the person's own: its lines as they are; only literal elements have text here.
  for (const l of b.lines) rows.push(resolveLine(l, {}))
  return rows
}

async function view($: EngineInterface): Promise<View> {
  const agents = (await $.agent.list()).filter(a => a.status !== 'killed').slice(-6)
  return {
    list: await read($, list),
    sessions: await board($),
    agents: agents.map(a => ({ type: a.type, status: a.status, started: agentStart.get(a.id) })),
    now: Date.now(),
  }
}

// Style names to Text props; a later color wins.
function ink(style: string[]) {
  const p: { color?: string; dimColor?: boolean; bold?: boolean; underline?: boolean; inverse?: boolean } = {}
  for (const s of style) {
    if (s === 'g') p.color = 'success'
    else if (s === 'y') p.color = 'warning'
    else if (s === 'r') p.color = 'error'
    else if (s === 'c') p.color = 'cyan'
    else if (s === 'm') p.color = 'magenta'
    else if (s === 'dim') p.dimColor = true
    else if (s === 'b') p.bold = true
    else if (s === 'u') p.underline = true
    else if (s === 'tagel') p.inverse = true
  }
  return p
}

function draw(ui: ReturnType<EngineInterface['ui']['resolve']>, blocks: Block[], v: View) {
  const { Text } = ui
  const out = []
  for (const b of blocks) {
    const rows = blockRows(b, v)
    if (!rows?.length) continue // nothing to show: no blank row between blocks either
    if (out.length) out.push(<Text> </Text>)
    for (const r of rows)
      out.push(
        r.length ? (
          <Text>
            {r.map(p => (
              <Text {...ink(p.style)}>{printable(p.text)}</Text>
            ))}
          </Text>
        ) : (
          <Text> </Text>
        ),
      )
  }
  return out
}

// The pane holds the sidebar's blocks; a layout without any opens none. A pane that cannot open fails nothing.
async function openPane($: EngineInterface): Promise<boolean> {
  try {
    if ((await loadLayout($)).sidebar.length === 0) return false
    await $.ui.open({ id: PANE, title: 'Checklist' })
    return true
  } catch {
    return false
  }
}

// A whole list; without a title it keeps the current one.
function clean(current: Checklist, input: unknown): Checklist | string {
  const raw = (input ?? {}) as { title?: unknown; steps?: unknown; finish?: unknown }
  const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title : current.title
  if (!title.trim()) return 'title must be a non-empty string'
  if (!Array.isArray(raw.steps)) return 'steps must be an array'
  const steps: Step[] = []
  for (const [i, s] of raw.steps.entries()) {
    const one = (s ?? {}) as Record<string, unknown>
    if (typeof one.step !== 'string' || !one.step.trim()) return `steps[${i}].step must be a non-empty string`
    if (!STATUSES.includes(one.status as StepStatus)) return `steps[${i}].status must be one of ${STATUSES.join(', ')}`
    steps.push({
      step: one.step,
      status: one.status as StepStatus,
      ...(typeof one.when === 'string' && one.when ? { when: one.when } : {}),
      ...(typeof one.note === 'string' && one.note ? { note: one.note } : {}),
    })
  }
  return { title, steps, updated: stamp(), ...(raw.finish === true ? { finish: true } : {}) }
}

function stamp(): string {
  return new Date().toISOString().slice(11, 16) + ' UTC'
}

// A partial update: changes: [{number, status?, when?, note?}] against the current list (an empty
// when or note removes it). Costs a few dozen tokens where resending the whole list costs hundreds.
export function applyChanges(current: Checklist, input: unknown): Checklist | string {
  const raw = (input ?? {}) as { title?: unknown; changes?: unknown; finish?: unknown }
  if (!Array.isArray(raw.changes) || raw.changes.length === 0) return 'pass steps (the whole list) or changes (what changed)'
  if (current.steps.length === 0) return 'there is no checklist yet: pass title and steps first'
  const steps = current.steps.map(s => ({ ...s }))
  for (const [i, c] of raw.changes.entries()) {
    const one = (c ?? {}) as Record<string, unknown>
    const s = typeof one.number === 'number' && Number.isInteger(one.number) ? steps[one.number - 1] : undefined
    if (!s) return `changes[${i}].number must be a step number from 1 to ${steps.length}`
    if (one.status !== undefined) {
      if (!STATUSES.includes(one.status as StepStatus)) return `changes[${i}].status must be one of ${STATUSES.join(', ')}`
      s.status = one.status as StepStatus
    }
    if (typeof one.when === 'string') {
      if (one.when) s.when = one.when
      else delete s.when
    }
    if (typeof one.note === 'string') {
      if (one.note) s.note = one.note
      else delete s.note
    }
  }
  const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title : current.title
  const finish = typeof raw.finish === 'boolean' ? raw.finish : current.finish === true
  return { title, steps, updated: stamp(), ...(finish ? { finish: true } : {}) }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    headless = !e.isInteractive
    if (headless) return next(e)
    await $.tool.register({
      name: 'set',
      description:
        'Main conversation only: a subagent must not call this. Set or update the task checklist shown in the pane beside the chat. When a plan is made, pass title and steps (the whole list in order). Afterwards pass only changes: [{number, status}] as a step starts, finishes or fails (number starts at 1; status done, running, pending or failed; when = the time it finished or is expected; note = one short line).',
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'What the checklist is about' },
          changes: {
            type: 'array',
            description: 'Only what changed since the last call',
            items: {
              type: 'object',
              properties: {
                number: { type: 'integer', description: 'Step number, starting at 1' },
                status: { type: 'string', enum: STATUSES },
                when: { type: 'string' },
                note: { type: 'string' },
              },
              required: ['number'],
            },
          },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                step: { type: 'string' },
                status: { type: 'string', enum: STATUSES },
                when: { type: 'string', description: 'Time finished or expected, e.g. "22:05 UTC"' },
                note: { type: 'string' },
              },
              required: ['step', 'status'],
            },
          },
          finish: { type: 'boolean', description: 'Send with the last step: running steps are marked done when the turn ends' },
        },
        required: [],
      },
    })
    await $.command.register({ name: 'checklist', description: 'Show the task checklist pane' })
    stopRefresh?.()
    const timer = $.clock.every(REFRESH_MS, () => void tick($))
    stopRefresh = () => timer.cancel()
    // Open at every session start, restarts included: the pane holds the sessions board too.
    void openPane($)
    let current = await read($, list)
    if (current.steps.length === 0) {
      const saved = await restore($)
      if (saved) {
        await update($, list, () => saved)
        current = saved
      }
    }
    loaded = await $.session.id()
    await publish($, { step: stepOf(current), title: current.title, state: 'idle', agents: running.size })
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId) {
      const before = running.size
      running.add(e.agentId)
      if (!mainRunning && running.size !== before) await publish($, { agents: running.size })
    } else {
      mainRunning = true
      await ensure($)
      await publish($, { state: 'working' })
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId) {
      if (running.delete(e.agentId) && !mainRunning) await publish($, { agents: running.size })
      return done
    }
    mainRunning = false
    needsYou = false
    const patch: Partial<SessionRecord> = { state: 'idle', agents: running.size }
    // finish: true came with the last step, so the answer closes the running steps.
    const current = await read($, list)
    if (e.reason === 'answer' && current.finish && running.size === 0) {
      const value: Checklist = {
        title: current.title,
        steps: current.steps.map(s => (s.status === 'running' ? { ...s, status: 'done' as const } : s)),
        updated: stamp(),
      }
      await update($, list, () => value)
      await save($, value)
      patch.step = stepOf(value)
      patch.title = value.title
    }
    await publish($, patch)
    return done
  })

  // "Waiting on you" only while the main session really asks: a permission prompt is open.
  // Agents (agent_id set, e.g. inside a workflow) can't be answered, so they never count.
  on('classic.Notification', async ($, e, next) => {
    if (e.notification_type === 'permission_prompt' && !e.agent_id) {
      needsYou = true
      await publish($, { state: 'needs-you' })
    }
    return next(e)
  })

  // ... or a question dialog is open; it closes when the person answers.
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    const main = !(e as { agentId?: string }).agentId
    if (main) await publish($, { state: 'needs-you' })
    const answered = await next(e)
    if (main) await publish($, { state: 'working' })
    return answered
  })

  // The next tool call after a permission prompt means it was answered.
  on('tool.call', async ($, e, next) => {
    if (needsYou && !(e as { agentId?: string }).agentId) {
      needsYou = false
      await publish($, { state: 'working' })
    }
    return next(e)
  })

  // After /clear or resume the process goes on under a new session id: keep the timer, drop the list.
  on('session.end', async ($, e, next) => {
    mine = undefined
    if (e.reason === 'clear' || e.reason === 'resume') {
      await update($, list, () => EMPTY)
      loaded = undefined
    } else {
      stopRefresh?.()
    }
    await drop($, BOARD + e.sessionId)
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    const id = (started as { agentId?: string }).agentId
    if (id) agentStart.set(id, Date.now())
    return started
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!e.tools.includes(TOOL) || e.surfaces.length === 0) return composed
    return { sections: [...composed.sections, { id: 'checklist:policy', text: POLICY, scope: 'session' }] }
  })

  on('command.run', { command: 'checklist' }, async $ => {
    await ensure($)
    return { text: (await openPane($)) ? 'Checklist pane opened.' : 'The layout puts no block in the sidebar, so there is no pane to open.' }
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    if ((e as { agentId?: string }).agentId) return { result: 'The checklist belongs to the main conversation. Carry on without it.' }
    await ensure($)
    const current = await read($, list)
    const whole = Array.isArray((e as { steps?: unknown }).steps)
    const value = whole ? clean(current, e) : applyChanges(current, e)
    if (typeof value === 'string') return { result: `Checklist not changed: ${value}`, isError: true }
    await update($, list, () => value)
    await save($, value)
    await publish($, { step: stepOf(value), title: value.title })
    void openPane($)
    const done = value.steps.filter(s => s.status === 'done').length
    return { result: `Checklist updated: ${done} of ${value.steps.length} steps done.` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const rows = draw(ui, (await loadLayout($)).sidebar, await view($))
    return <ui.Box flexDirection="column">{rows.length ? rows : <ui.Text dimColor>Nothing to show yet.</ui.Text>}</ui.Box>
  })

  // The band above the prompt draws the layout's band blocks; it yields to a survey and passes when it has none.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (headless || e.props.hasSurvey) return next(e)
    const blocks = (await loadLayout($)).bandAbovePrompt
    if (blocks.length === 0) return next(e)
    const ui = $.ui.resolve(e)
    const rows = draw(ui, blocks, await view($))
    return rows.length ? <ui.Box flexDirection="column">{rows}</ui.Box> : next(e)
  })
}
