# Layout format, version 1

The layout is one JSON file, `~/.claude/terminal-layout.json`. The editor at https://dgtlwrks.github.io/claude-terminal-mods/ writes it. [layouts/default.json](layouts/default.json) is the default and a full example.

The code that reads it is `checklist/hooks/layout.ts` (the same file is in `cockpit/hooks/`). A file that is missing, not JSON, or not `format: "claude-terminal-layout"` with `version: 1` is ignored and the shipped default is used. Unknown style names are dropped.

## Shape

```json
{
  "format": "claude-terminal-layout",
  "version": 1,
  "sidebar": [],
  "bandAbovePrompt": [],
  "turnSummary": [],
  "statusLine": [],
  "parked": {}
}
```

| Field | Type | Drawn by | Notes |
| --- | --- | --- | --- |
| `format` | `"claude-terminal-layout"` | | Required. |
| `version` | `1` | | Required. |
| `sidebar` | list of Block | checklist | The pane beside the chat. An empty list opens no pane. |
| `bandAbovePrompt` | list of Block | checklist | The band above the prompt. It yields to Claude Code's surveys. |
| `turnSummary` | list of Line | cockpit | The line under each answer. Plain text: styles are not drawn. |
| `statusLine` | list of Line | `statusline/statusline.zsh` | The status line. |
| `parked` | object | nobody | Where the editor keeps blocks, lines and elements you took off the canvas. Ignored. |

### Block

| Field | Type | Meaning |
| --- | --- | --- |
| `key` | string | `checklist`, `sessions` or `subagents` for the built-in blocks; any other key is your own block. |
| `title` | string | Heading drawn in bold. |
| `badge` | string, optional | In a built-in block: any value shows a live count next to the title, hidden at 0. In your own block: the badge text. |
| `lines` | list of Line | |

### Line

| Field | Type | Meaning |
| --- | --- | --- |
| `key` | string | In a built-in block, the line's kind (see the catalog). Elsewhere a free name. |
| `elements` | list of Element | Drawn left to right. |

### Element

| Field | Type | Meaning |
| --- | --- | --- |
| `key` | string | A literal key or a data key. |
| `text` | string, optional | Text of a literal. For a data key it is only the sample the editor shows. |
| `segments` | list of `{ text, style? }`, optional | Several styled pieces in one element, for example a bar. |
| `style` | list of style names, optional | Applied to the whole element. |
| `spaceBefore` | number, optional | Spaces before the element. Default 1. 0 to 12. |
| `width` | number, optional | Minimum width in columns. 0 to 40. Pads with spaces. |
| `align` | `"right"`, optional | Pad on the left instead of the right. |

Styles: `g` green, `y` yellow, `r` red, `c` cyan, `m` magenta, `dim`, `b` bold, `u` underline, `tagel` inverse, `spacer`.

Literal keys carry their own `text`: `text`, `sep`, `emoji`, `mark`, `spacer`, `badge`, `rule`, `bar`, `spark`, `meter`. Every other key is data: the surface fills it in, or skips it.

## Minimal example

```json
{
  "format": "claude-terminal-layout",
  "version": 1,
  "sidebar": [
    {
      "key": "checklist",
      "title": "Checklist",
      "lines": [
        { "key": "checklist.title", "elements": [{ "key": "checklist.title", "text": "Sample", "style": ["b"] }] },
        {
          "key": "checklist.step",
          "elements": [
            { "key": "step.mark", "text": "✓" },
            { "key": "step.num", "text": "1." },
            { "key": "step.text", "text": "Sample step" }
          ]
        }
      ]
    }
  ],
  "bandAbovePrompt": [],
  "turnSummary": [
    {
      "key": "turn.summary",
      "elements": [
        { "key": "mark", "text": "↳" },
        { "key": "turn.time", "text": "1m 52s" },
        { "key": "sep", "text": "·" },
        { "key": "turn.tools", "text": "7 tool calls" }
      ]
    }
  ],
  "statusLine": [
    {
      "key": "status.1",
      "elements": [
        { "key": "model", "text": "Opus 5.5", "style": ["c"] },
        { "key": "sep", "text": "|" },
        { "key": "ctx.pct", "text": "23%" }
      ]
    }
  ]
}
```

## How a line is drawn

These rules come from `resolveLine` in `checklist/hooks/layout.ts`. A data element whose value is empty has nothing to show.

- An empty data element without a `width` is left out, together with the `emoji` and `mark` elements right before it and one separator before those.
- An empty data element with a `width` stays as blank columns, so columns keep their place.
- A separator (`sep`) shows only between two runs that each still hold data.
- The first element drawn has no space before it.
- Every other element gets `spaceBefore` spaces first (default 1).

In `turnSummary` the line is turned into plain text and trailing spaces are cut; lines that end up empty are left out.

## Built-in blocks

In a built-in block, the first line of a row kind is the pattern for every row. Later lines of that kind are samples for the editor and are not drawn. A pattern gives up its colors (`g y r c m dim`); the row's state colors it. `b`, `u` and `tagel` stay.

| Block key | Row line key | Row colors from state |
| --- | --- | --- |
| `checklist` | `checklist.step` | done green and dim, running yellow, pending dim, failed red |
| `sessions` | `session.row`, and `session.task` for the task under it | working yellow, needs you red, idle dim |
| `subagents` | `subagent.row` | running yellow, completed green, failed red, other dim |

The `sessions` and `subagents` blocks are not drawn while they have no rows. A `checklist` block with no steps shows "No checklist yet." The `session.name` column is as wide as the longest name (14 characters at most).

Your own block (any other key) draws its lines as written. Only literal elements have text there.

## Catalog

The `text` in the examples is what the editor shows as a sample. Real values come from the surface.

### statusLine

Drawn by `statusline/statusline.zsh`.

| Key | Shows | Example |
| --- | --- | --- |
| `model` | model name | `Opus 5.5` |
| `effort` | effort level | `xhigh` |
| `cwd` | working folder | `...projects/acme/shop` |
| `branch` | git branch | `main` |
| `git.mark` | git state mark | `👍` |
| `diff.add` | lines added | `+75` |
| `diff.del` | lines removed | `−8` |
| `ctx.bar` | bar of the context window used (use `segments`) | `██░░░░░░░░` |
| `ctx.pct` | context window used | `23%` |
| `ctx.tokens` | context tokens used and window size | `226k/1M` |
| `cost` | session cost | `$4.88` |
| `duration` | session duration | `20m 28s` |
| `limit.5h` | 5-hour usage limit used | `5h 12%` |
| `limit.5h.reset` | when it resets | `↻14:00` |
| `limit.week` | weekly usage limit used | `wk 26%` |
| `limit.week.reset` | when it resets | `↻Mon 14:00` |
| `session.name` | session name | `Fix the login timeout` |
| `cache` | prompt-cache state | `⚡ cache warm 97% hit, cold in 19m` |
| `repo` | repository | `acme/shop` |
| `pr` | pull request and its state | `PR #42 approved` |

### turnSummary

Drawn by cockpit under each answer. Plain text: styles are not drawn.

| Key | Shows | Example |
| --- | --- | --- |
| `turn.out` | output tokens | `2.1k out` |
| `turn.in` | input tokens (new, cache reads and cache writes) | `1.2M in` |
| `turn.cache` | share of input read from cache | `97% from cache` |
| `turn.time` | duration of the turn | `1m 52s` |
| `turn.tools` | tool calls in the turn | `7 tool calls` |
| `turn.blocked` | calls the git guard refused; empty at 0 | `1 blocked` |

### sidebar and bandAbovePrompt

Drawn by checklist.

Block `checklist`:

| Key | Shows | Example |
| --- | --- | --- |
| `checklist.title` | title of the list | `Fix the login timeout` |
| `checklist.done` | steps done | `4 of 5 done` |
| `checklist.updated` | time of the last update | `updated 16:58 UTC` |
| `step.mark` | step state mark | `✓` |
| `step.num` | step number | `1.` |
| `step.text` | step text | `Read the session module` |
| `step.when` | when the step finished, in parentheses | `(16:40 UTC)` |

Lines `checklist.title` and `checklist.progress` are drawn once; `checklist.step` is the row pattern.

Block `sessions` (row `session.row`, line `session.task`):

| Key | Shows | Example |
| --- | --- | --- |
| `session.state` | state mark | `●` |
| `session.name` | session name | `api` |
| `session.status` | `waiting on you`, the current step, `N agents running`, or `idle 14m` | `waiting on you` |
| `session.alert` | `🔔` when the session needs you | `🔔` |
| `session.ctx` | context window used | `61%` |
| `session.task` | the session's task title | `Fix the login timeout` |

Block `subagents` (row `subagent.row`):

| Key | Shows | Example |
| --- | --- | --- |
| `agent.state` | state mark | `▸` |
| `agent.type` | agent type | `Explore` |
| `agent.status` | status | `running` |
| `agent.time` | running time while live | `0:42` |

Any other block key is your own block: add lines with literal elements only.

## Fixed parts

These are not in the layout: the transcript, the prompt, the mode line, and the engine's own duration line ("✱ ... for 1m 52s").
