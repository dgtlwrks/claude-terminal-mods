// ── Git guard ─────────────────────────────────────────────────────────────────
// Git rules for worktrees that share one repository and one stash stack, enforced on every Bash call.
// The command text is read like a shell in one linear pass: heredoc bodies and quoted text are data,
// a new command starts after ; & | && || newline ( ) ` and a lone { or }, redirections are dropped,
// and the commands inside $( ) are read too, quoted or not. Not seen: git run by an alias, a script,
// eval or sh -c '...'; a backtick inside double quotes; a $( ) inside a heredoc body (the shell runs
// it when the end word is unquoted). A `case` pattern's ) inside a quoted $( ) ends that $( ) early.

type Heredoc = { end: string, dash: boolean }

const GLOBAL_OPTS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace'])
const SHELL_WORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!'])
// Wrappers: their own -x options and VAR=value words come before the command (time takes -p)
// Commands that run the command after them, past options and values of their own (a user, a duration, a count).
const WRAPPERS = new Set([
  'sudo', 'doas', 'env', 'command', 'exec', 'nohup', 'nice', 'builtin', 'time', 'noglob', 'nocorrect',
  'timeout', 'gtimeout', 'stdbuf', 'caffeinate', 'xargs', 'watch', 'chronic',
])
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/
const WIDE_PATHS = new Set(['.', './', '..', '../', ':/', '*'])

const OWN = 'stage only the paths you own'
const DISCARD = "it discards uncommitted work, other sessions' included"
const STASH = 'the stash stack is shared by every worktree: use git stash push -u -m <tag>, then git stash apply <sha>'
const UNCHECKED = 'guard: this command could not be checked, so it was not run'

// Line text (for <<-, without its leading tabs) -> start offsets of the lines holding it.
function lineIndex(text: string, dash: boolean): Map<string, number[]> {
  const index = new Map<string, number[]>()
  let start = 0
  while (start <= text.length) {
    let stop = text.indexOf('\n', start)
    if (stop < 0) stop = text.length
    let from = start
    if (dash) while (from < stop && text[from] === '\t') from++
    const line = text.slice(from, stop)
    const starts = index.get(line)
    if (starts) starts.push(start)
    else index.set(line, [start])
    start = stop + 1
  }
  return index
}

// The commands of a shell text, in order, each as its words with quotes removed.
export function commands(text: string): string[][] {
  const out: string[][] = []
  let i = 0
  let plain: Map<string, number[]> | undefined
  let tabbed: Map<string, number[]> | undefined

  // Offset just past the end line of a heredoc whose body starts at line start `from`, or -1 without one.
  const bodyEnd = (doc: Heredoc, from: number): number => {
    const index = doc.dash ? (tabbed ??= lineIndex(text, true)) : (plain ??= lineIndex(text, false))
    const starts = index.get(doc.end) ?? []
    let lo = 0
    let hi = starts.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if ((starts[mid] ?? 0) < from) lo = mid + 1
      else hi = mid
    }
    const start = starts[lo]
    if (start === undefined) return -1
    const stop = text.indexOf('\n', start)
    return stop < 0 ? text.length : stop + 1
  }

  // $'...' from i (just past the '): a backslash escapes the next character. Moves i past the closing '.
  const ansi = (): string => {
    let s = ''
    while (i < text.length && text.charAt(i) !== "'") {
      if (text.charAt(i) === '\\') i++
      s += text.charAt(i)
      i++
    }
    i++
    return s
  }

  // "..." from i (just past the opening "), reading the commands of each $( ) in it. Moves i past the closing ".
  const double = (): string => {
    let s = ''
    while (i < text.length) {
      const c = text.charAt(i)
      if (c === '"') {
        i++
        return s
      }
      if (c === '\\') {
        // In double quotes a backslash escapes only $ ` " \ and a newline; before anything else it stays, as in
        // the shell (env -S then reads "git\_reset" as git reset).
        const next = text.charAt(i + 1)
        if (next !== '\n') s += '$`"\\'.includes(next) ? next : `\\${next}`
        i += 2
      } else if (c === '$' && text.charAt(i + 1) === '(') {
        const start = i
        i += 2
        read(true)
        s += text.slice(start, i)
      } else {
        s += c
        i++
      }
    }
    return s
  }

  // Commands from i to the end of the text or, when `sub`, to the ) that closes a quoted $(.
  const read = (sub: boolean): void => {
    let cmd: string[] = []
    let word = ''
    let inWord = false
    let quoted = false
    let target = 0 // the next word is: 1 a redirection target, 2 a heredoc end word, 3 a <<- end word
    let depth = 0
    let docs: Heredoc[] = []
    const add = (s: string, quote: boolean) => {
      word += s
      inWord = true
      if (quote) quoted = true
    }
    // A redirection target is dropped; a lone unquoted { or } starts a new command.
    const endWord = () => {
      if (!inWord) return
      if (target > 1) docs.push({ end: word, dash: target === 3 })
      else if (target === 0 && !quoted && (word === '{' || word === '}')) {
        if (cmd.length) out.push(cmd)
        cmd = []
      } else if (target === 0) cmd.push(word)
      target = 0
      word = ''
      inWord = false
      quoted = false
    }
    const endCommand = () => {
      endWord()
      if (cmd.length) out.push(cmd)
      cmd = []
      target = 0
    }
    while (i < text.length) {
      const c = text.charAt(i)
      const next = text.charAt(i + 1)
      if (c === '\\') {
        if (next !== '\n') add(next, true) // a backslash-newline joins the lines
        i += 2
      } else if (c === "'") {
        const close = text.indexOf("'", i + 1)
        const stop = close < 0 ? text.length : close
        add(text.slice(i + 1, stop), true)
        i = stop + 1
      } else if (c === '$' && next === "'") {
        i += 2
        add(ansi(), true)
      } else if (c === '"') {
        i++
        add(double(), true)
      } else if (c === '#' && !inWord) {
        const stop = text.indexOf('\n', i)
        i = stop < 0 ? text.length : stop
      } else if (c === ' ' || c === '\t') {
        endWord()
        i++
      } else if (c === '\n') {
        endCommand()
        i++
        // The heredoc bodies follow this line. One without its end line is read as commands.
        for (const doc of docs) {
          const stop = bodyEnd(doc, i)
          if (stop < 0) break
          i = stop
        }
        docs = []
      } else if (c === ';' || c === '`' || c === '(' || c === ')' || c === '|' || (c === '&' && next !== '>')) {
        endCommand()
        i++
        if (c === '(') depth++
        if (c === ')') {
          if (sub && depth === 0) return
          if (depth > 0) depth--
        }
      } else if (c === '<' || c === '>' || c === '&') {
        if (!quoted && /^[0-9]+$/.test(word)) {
          word = '' // the fd of 2> or 2>&1
          inWord = false
        }
        endWord()
        const op = text.slice(i, i + 3)
        if (next === '(') {
          i++ // <( ) and >( ): the ( starts a command
        } else if (op === '<<<' || op === '<<-') {
          target = op === '<<<' ? 1 : 3
          i += 3
        } else if (op.startsWith('<<')) {
          target = 2
          i += 2
        } else {
          target = 1
          i += next === '>' || next === '&' || next === '|' ? 2 : 1
        }
      } else {
        add(c, false)
        i++
      }
    }
    endCommand()
  }

  read(false)
  return out
}

// macOS file systems ignore case, so GIT and /usr/bin/Git run git too.
const isGit = (w: string) => {
  const n = w.toLowerCase()
  return n === 'git' || n.endsWith('/git')
}

// The command's words from each `git` on: one list for a git command, none when it is not git.
// After a wrapper, rather than knowing each one's options, every word that is git counts: alone, glued to an
// option (env -Sgit), or inside a string the wrapper splits (env -S 'git add .'). sudo -u git git ... gives two.
function gitWords(words: string[]): string[][] {
  let i = 0
  while (i < words.length && (ASSIGNMENT.test(words[i] ?? '') || SHELL_WORDS.has(words[i] ?? ''))) i++
  if (isGit(words[i] ?? '')) return [words.slice(i)]
  // /usr/bin/timeout and TIMEOUT are the same wrapper.
  if (!WRAPPERS.has((words[i] ?? '').toLowerCase().split('/').pop() ?? '')) return []
  const found: string[][] = []
  for (let j = i + 1; j < words.length; j++) {
    // Split the word the way env -S does (quotes dropped, \_ \t \n as spaces) and take every git in it; a git that
    // is only mentioned inside another command's argument is refused too, which errs on the safe side.
    const word = words[j] ?? ''
    // env -S expands ${NAME}: what it becomes is unknown here, so the check fails closed (refused if git is named).
    if (word.includes('${')) throw new Error('a wrapper word with ${...} cannot be checked')
    const parts = word.replace(/\\[_tn]/g, ' ').replace(/['"\\]/g, '').split(/\s+/).filter(Boolean)
    parts.forEach((part, k) => {
      // Only the word git sits in may carry the wrapper's option (env -Sgit); git's own arguments stay as written.
      const name = part.replace(/^-[A-Za-z]*S/, '').replace(/^--[A-Za-z-]+=/, '')
      if (isGit(name)) found.push([name, ...parts.slice(k + 1), ...words.slice(j + 1)])
    })
  }
  return found
}

// A short-option group (one -, letters only) holding `letter` before any of `stops`, the options that
// take the rest of the group as their value.
function flag(word: string, letter: string, stops = ''): boolean {
  if (!/^-[A-Za-z]+$/.test(word)) return false
  for (const c of word.slice(1)) {
    if (c === letter) return true
    if (stops.includes(c)) return false
  }
  return false
}

// A stash message: -m x, -mx (also in a group such as -um x), --message x or --message=x.
function tagged(args: string[]): boolean {
  return args.some((a, k) => {
    if (a.startsWith('--message=')) return true
    if (a === '--message') return k + 1 < args.length
    const m = a.indexOf('m')
    if (m < 0 || !/^-[A-Za-z]*$/.test(a.slice(0, m))) return false
    return m + 1 < a.length || k + 1 < args.length
  })
}

// push and save need a message, pop and clear are refused, drop and apply need a named entry.
function stash(args: string[]): string | null {
  const verb = args[0]
  if (verb === undefined || verb.startsWith('-')) return tagged(args) ? null : STASH
  if (verb === 'push' || verb === 'save') return tagged(args.slice(1)) ? null : STASH
  if (verb === 'pop') return STASH
  if (verb === 'clear') return "it deletes every session's stashes"
  if (verb === 'drop' || verb === 'apply') {
    return args.slice(1).some(a => !a.startsWith('-'))
      ? null
      : 'the stash stack is shared by every worktree: name your own entry (stash@{n} or its sha)'
  }
  return null
}

// Why a git command (its words from `git` on) is refused, or null.
function why(words: string[]): string | null {
  let i = 1
  while ((words[i] ?? '').startsWith('-')) i += GLOBAL_OPTS_WITH_VALUE.has(words[i] ?? '') ? 2 : 1
  // On a case-insensitive disk `git RESET` can still reach git-reset.
  const sub = words[i]?.toLowerCase()
  const args = words.slice(i + 1)
  // git takes --opt=value and any unambiguous prefix of a long option (--har for --hard): all name the option.
  const names = (a: string, x: string) => {
    const w = a.split('=')[0] ?? ''
    return w === x || (w.length >= 3 && w.startsWith('--') && x.startsWith(w))
  }
  const has = (...xs: string[]) => args.some(a => xs.some(x => names(a, x)))
  const group = (letter: string, stops = '') => args.some(a => flag(a, letter, stops))
  const wide = (paths: string[]) => paths.some(a => WIDE_PATHS.has(a))
  switch (sub) {
    case 'add':
      return wide(args) || has('--all', '--update') || group('A') || group('u') ? OWN : null
    case 'commit':
      return has('--all') || group('a', 'mFCct') ? OWN : null
    case 'stash':
      return stash(args)
    case 'push':
      return has('--force', '--force-with-lease') || group('f', 'o') || args.some(a => a.startsWith('+'))
        ? 'push without force'
        : null
    case 'reset':
      return has('--hard') ? DISCARD : null
    case 'clean':
      return (has('--force') || group('f', 'e')) && !has('--dry-run') && !group('n', 'e')
        ? 'it deletes untracked files that may belong to another session'
        : null
    case 'restore':
      return wide(args) ? 'restore only the paths you own' : null
    case 'checkout':
      if (wide(args.includes('--') ? args.slice(args.indexOf('--') + 1) : args)) return 'restore only the paths you own'
      return has('--force') || group('f', 'bB') ? DISCARD : null
    case 'switch':
      return has('--discard-changes', '--force') || group('f', 'cC') ? DISCARD : null
    default:
      return null
  }
}

export function refusal(command: string): string | null {
  try {
    for (const words of commands(command)) {
      for (const git of gitWords(words)) {
        const reason = why(git)
        if (reason) return `guard: "${git.join(' ')}" blocked: ${reason}`
      }
    }
    return null
  } catch {
    return /\bgit\b/i.test(command) ? UNCHECKED : null
  }
}
