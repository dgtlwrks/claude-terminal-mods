export type StepStatus = 'done' | 'running' | 'pending' | 'failed'
export type Step = { step: string; status: StepStatus; when?: string; note?: string }
// finish: sent with the last step; running steps are marked done when the main turn ends.
export type Checklist = { title: string; steps: Step[]; updated: string; finish?: boolean }
// One session's row on the sessions board, kept in $.store under `session:<session id>`.
// state: working = a turn is running; needs-you = a permission prompt or question is open; idle = done.
// agents: agent turns running. at: last state change. seen: last sign of life (the timer refreshes it).
export type SessionRecord = {
  name: string
  title: string
  step: string
  ctx: number
  state: 'working' | 'needs-you' | 'idle'
  agents: number
  at: number
  seen: number
}

declare module 'claude-code' {
  interface PluginState {
    checklist: { list: Shaped<Checklist> }
  }
}
