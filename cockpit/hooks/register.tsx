import type { EngineInterface, Register } from 'claude-code'
import { refusal } from './guard'
import { loadLayout, plain, resolveLine } from './layout'

export { refusal }

// ── Folded test output ────────────────────────────────────────────────────────
// Summary lines of the test runners these projects use: node --test (TAP and spec), bun and
// `claude plugin test`, pytest. Output is folded only when the run reports no failures.

export function testSummary(stdout: string): { passed: number; failed: number; skipped: number } | null {
  const num = (re: RegExp) => {
    const m = stdout.match(re)
    return m ? Number(m[1]) : null
  }
  const lines: [RegExp, RegExp, RegExp][] = [
    [/^# pass (\d+)$/m, /^# fail (\d+)$/m, /^# skipped (\d+)$/m],
    [/^ℹ pass (\d+)$/m, /^ℹ fail (\d+)$/m, /^ℹ skipped (\d+)$/m],
    [/^\s*(\d+) pass$/m, /^\s*(\d+) fail$/m, /^\s*(\d+) skip$/m],
  ]
  for (const [p, f, s] of lines) {
    const passed = num(p)
    const failed = num(f)
    if (passed !== null && failed !== null) return { passed, failed, skipped: num(s) ?? 0 }
  }
  const py = stdout.match(/^=+ (.*\d+ passed.*) =+$/m)?.[1]
  if (py) {
    const n = (re: RegExp) => Number(py.match(re)?.[1] ?? 0)
    return { passed: n(/(\d+) passed/), failed: n(/(\d+) failed/), skipped: n(/(\d+) skipped/) }
  }
  return null
}

// ── Turn summary and alerts ───────────────────────────────────────────────────

const ALERT_AFTER_MS = 30_000 // a piece of work this long means you probably looked away

let toolCalls = 0 // main conversation only, this turn
let blocked = 0 // main conversation only, this turn
let workStart = 0 // first main turn of the current piece of work, 0 when none
const running = new Set<string>() // turn ids of the agent turns still running

export function count(n: number): string {
  return n >= 999_950 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`
}

export function duration(ms: number): string {
  const s = Math.round(ms / 1000)
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`
}

// Everything a request read: new input, cache reads and cache writes.
function inputOf(u: { input_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }): number {
  return u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
}

// Claude Code's own notifications that mean the person is actually being asked something now.
// Notifications an agent raises (agent_id set, e.g. agents inside a workflow) never alert: nobody can answer those.
export const ALERT_FOR: Record<string, string> = {
  permission_prompt: 'needs your permission',
}

// A macOS banner with a sound. Apple Terminal ignores the notification sequence $.ui.notify writes.
// Named after the session's project root, not the working folder (a workflow agent's is a wf_... folder).
// A missed banner never fails the hook that raised it.
async function alert($: EngineInterface, what: string) {
  try {
    const name = (await $.session.root()).split('/').pop() || 'Claude'
    const text = `${name} ${what}`.replace(/["\\]/g, '')
    await $.process.run(['osascript', '-e', `display notification "${text}" with title "Claude Code" sound name "Glass"`])
  } catch {
    // nothing to do: the banner is a courtesy
  }
}

// ── Mods usage ────────────────────────────────────────────────────────────────
// What the checklist tool costs, counted from the model's own responses (turn.step), and how often the guard
// refuses. A checklist update sent alone is a response whose only tool call is the checklist: the request after
// it exists only because of it, and it reads the whole conversation again.
// Kept per session in this mod's $.store under usage:<session id>, so /restart and later sessions add up.

const CHECKLIST = 'mcp__checklist__set'
const USAGE = 'usage:'

export type ModUsage = {
  requests: number
  checklistCalls: number
  loneCalls: number
  loneReread: number
  denies: number
}

const EMPTY: ModUsage = { requests: 0, checklistCalls: 0, loneCalls: 0, loneReread: 0, denies: 0 }
let usage: ModUsage = { ...EMPTY }
let loaded = '' // the session id the counters in `usage` belong to, '' when none
const alone = new Map<string, string>() // loop (agent id or 'main') -> turn whose last response was a lone update

export function report(mine: ModUsage, all: ModUsage[]): string {
  const sum = (k: keyof ModUsage) => all.reduce((n, u) => n + u[k], 0)
  const col = (s: string) => s.padStart(14)
  const row = (label: string, k: keyof ModUsage) => label.padEnd(34) + col(count(mine[k])) + col(count(sum(k)))
  return [
    'Mods, counted from the requests and the guard',
    ''.padEnd(34) + col('this session') + col('all sessions'),
    row('requests', 'requests'),
    row('checklist updates', 'checklistCalls'),
    row('  sent alone', 'loneCalls'),
    row('  tokens re-read because of those', 'loneReread'),
    row('guard refusals', 'denies'),
    '',
    'The checklist tool and its policy add about 620 tokens to every request, read from cache.',
  ].join('\n')
}

// Loads the counters of the current session unless they are the ones in memory.
async function load($: EngineInterface): Promise<string> {
  const id = await $.session.id()
  if (id !== loaded) {
    usage = { ...EMPTY, ...((await $.store.get(USAGE + id)) as Partial<ModUsage> | undefined) }
    loaded = id
  }
  return id
}

// A write can reject when two sessions write at once; the next save carries the same counts.
async function save($: EngineInterface) {
  if (!loaded) return
  try {
    await $.store.set(USAGE + loaded, usage)
  } catch {
    // the line under the answer matters more than the counters
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await load($)
    await $.command.register({ name: 'mods-usage', description: 'Show how many tokens the self-made mods cost' })
    return next(e)
  })

  on('command.run', { command: 'mods-usage' }, async $ => {
    const id = await load($)
    const all: ModUsage[] = [usage]
    for (const key of await $.store.keys()) {
      if (key.startsWith(USAGE) && key !== USAGE + id) all.push({ ...EMPTY, ...((await $.store.get(key)) as Partial<ModUsage>) })
    }
    return { text: report(usage, all) }
  })

  on('session.end', async ($, e, next) => {
    // After /clear or resume the process goes on under a new session id; the old conversation must not count again.
    if (loaded === e.sessionId) await save($)
    usage = { ...EMPTY }
    loaded = ''
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const loop = e.agentId ?? 'main'
    const afterAlone = alone.get(loop) === e.turnId
    alone.delete(loop)
    const res = yield* next(e)
    usage.requests += 1
    if (afterAlone) {
      usage.loneCalls += 1
      usage.loneReread += res.usage ? inputOf(res.usage) : 0
    }
    const updates = res.toolUses.filter(t => t.name === CHECKLIST).length
    usage.checklistCalls += updates
    if (updates > 0 && updates === res.toolUses.length) alone.set(loop, e.turnId)
    return res
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId) {
      running.add(e.turnId)
    } else {
      toolCalls = 0
      blocked = 0
      if (!workStart) workStart = await $.clock.now()
      await load($)
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (!e.agentId) toolCalls += 1
    if (e.tool === 'Bash') {
      const reason = refusal(e.command)
      if (reason) {
        usage.denies += 1
        if (!e.agentId) blocked += 1
        return { deny: reason }
      }
    }
    if (e.tool === 'AskUserQuestion' && !e.agentId) await alert($, 'has a question for you')
    return next(e)
  }).catch(async (_$, e, next) => {
    // The guard fails closed: a check that broke refuses the command instead of letting it through.
    if (next.called) return next(e)
    if (e.tool === 'Bash') return { deny: 'guard: the check failed, so this command was not run' }
    return next(e)
  })

  on('classic.Notification', async ($, e, next) => {
    const what = ALERT_FOR[e.notification_type]
    if (what && !e.agent_id) await alert($, what)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    alone.delete(e.agentId ?? 'main')
    if (e.agentId) running.delete(e.turnId)
    const done = await next(e)
    if (e.agentId) return done
    // The piece of work is over when the main turn ends with no agent still running, interrupted or not.
    const over = running.size === 0
    let total = 0
    if (over) {
      const now = await $.clock.now()
      total = now - (workStart || now - e.durationMs)
      workStart = 0
    }
    if (e.isAborted) return done
    const read = e.usage ? inputOf(e.usage) : 0
    const data: Record<string, string> = {
      'turn.out': e.usage ? `${count(e.usage.output_tokens)} out` : '',
      'turn.in': e.usage ? `${count(read)} in` : '',
      'turn.cache': e.usage ? `${read > 0 ? Math.round((e.usage.cache_read_input_tokens / read) * 100) : 0}% from cache` : '',
      'turn.time': duration(e.durationMs),
      'turn.tools': `${toolCalls} tool call${toolCalls === 1 ? '' : 's'}`,
      'turn.blocked': blocked > 0 ? `${blocked} blocked` : '',
    }
    // The alert is for the whole piece of work: it waits while an agent is still running.
    if (over && total >= ALERT_AFTER_MS) await alert($, `${e.reason === 'error' ? 'stopped with an error' : 'finished'} (${duration(total)})`)
    await save($)
    // The line is text the engine draws under the answer, so the layout's styles do not reach it.
    const text = (await loadLayout($)).turnSummary
      .map(l => plain(resolveLine(l, data)))
      .filter(Boolean)
      .join('\n')
    return text ? { ...done, text } : done
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (e.props.tool !== 'Bash' || e.props.isErrored) return next(e)
    const summary = testSummary((e.props.output as { stdout?: string } | undefined)?.stdout ?? '')
    if (!summary || summary.failed > 0) return next(e)
    const { Text } = $.ui.resolve(e)
    const skipped = summary.skipped > 0 ? ` · ${summary.skipped} skipped` : ''
    return <Text dimColor>✓ {summary.passed} passed · 0 failed{skipped}</Text>
  })
}
