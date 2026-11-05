# claude-terminal-mods

Two Claude Code mods and a status line script that draw your terminal from one file, `~/.claude/terminal-layout.json`.
You make that file in a drag-and-drop editor: pick what each line shows, in what order, in what color.
The mods draw a task checklist pane, a board of your sessions, the line under each answer, and the status line.

**Editor:** https://dgtlwrks.github.io/claude-terminal-mods/

## Requirements

- Claude Code with function hooks. This is an early-access feature: the engine's generated types say "EARLY ACCESS: this surface may change between releases without notice." Tested with Claude Code 2.1.301. Third-party guides say mods need 2.1.280 or newer, plus the environment variable `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` unless the feature is rolled out to your account. That variable name appears in the 2.1.301 binary; whether you need it depends on your account. Function hooks are not in Anthropic's public docs yet (third-party statement).
- macOS for the session board and the banners (the cockpit uses `osascript`).
- `zsh` and `jq` for the status line (`jq` ships with macOS 15 and newer).

## Quick start

1. Clone the repo: `git clone https://github.com/dgtlwrks/claude-terminal-mods.git`
2. Open the editor, build your layout, and export the JSON.
3. Start Claude Code inside the clone and say: "set up this repo with my layout". Give it the path to the exported file, or paste the JSON.
   The project skill `terminal-layout-setup` (in `.claude/skills/`) then copies the layout to `~/.claude/terminal-layout.json`, installs both plugins, and shows you the change to `~/.claude/settings.json` before it applies it.
4. Restart Claude Code.

To do it by hand, follow [SETUP.md](SETUP.md).

## What the mods do

### checklist (command `/checklist`)

| Part | What it does |
| --- | --- |
| Checklist | The model keeps a task list through the tool `mcp__checklist__set`. The pane beside the chat shows it. |
| Sessions board | Every Claude Code session on this Mac, shared through the plugin store: state, name, status, context use, current task. |
| Subagents | The subagents of this session with state, type, status and running time. |
| Band above the prompt | Draws the `bandAbovePrompt` blocks of your layout. It steps aside while Claude Code shows a survey. |

The pane draws the blocks in `sidebar`. A layout with an empty `sidebar` opens no pane.

### cockpit (command `/mods-usage`)

| Part | What it does |
| --- | --- |
| Git guard | Refuses destructive git forms in shared worktrees, with the reason. See the list below. |
| Summary line | The line under each answer, drawn from your layout's `turnSummary` (tokens out and in, cache share, time, tool calls, blocked calls). Plain text: styles are not drawn. |
| Folded test output | A passing run of `node --test`, bun, `claude plugin test` or pytest shows as one line. A failing run shows in full. |
| macOS banners | A banner when a permission prompt or a question needs you, and when a piece of work longer than 30 seconds finishes or stops with an error. |
| `/mods-usage` | How many requests and checklist updates the session made, what the checklist costs in tokens, and how often the guard refused. |

The banners use the engine's `classic.Notification` event. `claude plugin validate` reports that this event does not run for plugins you install where an organization manages Claude Code, unless the organization lists the plugin in managed settings.

The guard refuses these `git` forms (the exact rules are in `cockpit/hooks/guard.ts`):

| Command | Refused when |
| --- | --- |
| `add` | it stages everything: `.`, `..`, `*`, `:/`, `--all`, `-A`, `--update`, `-u` |
| `commit` | it uses `-a` or `--all` |
| `stash` | no message is given (`push`/`save` without `-m`), or for `pop`, `clear`, and `drop`/`apply` without a named entry |
| `push` | it forces: `--force`, `-f`, `--force-with-lease`, `+ref` |
| `reset` | it uses `--hard` |
| `clean` | it forces, unless it is a dry run |
| `restore`, `checkout` | the path is `.`, `..`, `:/` or `*`; `checkout` also refuses `--force` |
| `switch` | it uses `--discard-changes` or `--force` |

It reads Bash commands like a shell: quoted text and heredoc bodies are data, and commands inside `$( )` are checked. It does not see git run by an alias, a script, `eval` or `sh -c '...'`. A command it cannot parse and that mentions git is refused.

### Status line

`statusline/statusline.zsh` is run by Claude Code as the `statusLine` command and draws the `statusLine` lines of your layout. See [SETUP.md](SETUP.md) for the settings entry.

## The layout file

One JSON file, format `claude-terminal-layout`, version 1, with four sections:

| Section | Drawn by |
| --- | --- |
| `sidebar` | checklist, in the pane beside the chat |
| `bandAbovePrompt` | checklist, above the prompt |
| `turnSummary` | cockpit, under each answer |
| `statusLine` | `statusline/statusline.zsh` |

If `~/.claude/terminal-layout.json` is missing or invalid, the plugins use the default in [layouts/default.json](layouts/default.json). The full format and the list of elements are in [LAYOUT.md](LAYOUT.md).

## Development

- `scripts/sync.sh` writes `layouts/default.json` and `checklist/hooks/layout.ts` into both plugins. Each plugin installs on its own and cannot import from the repo root.
- `scripts/check.sh` fails when a copy has drifted, then runs every test.
- `claude plugin test checklist` and `claude plugin test cockpit` run one plugin's tests.
- `claude plugin validate .` checks the marketplace manifest; run it on `checklist` and `cockpit` for the plugin manifests and hooks.

## License

MIT. See [LICENSE](LICENSE).
