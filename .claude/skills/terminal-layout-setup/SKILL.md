---
name: terminal-layout-setup
description: Set up this repo with a person's terminal layout JSON. Use when the person says "set up this repo with my layout", "install this with my layout json", "install the mods with my layout", or gives a terminal-layout JSON (a path or pasted text) and wants the checklist and cockpit plugins and the status line installed.
---

# Set up claude-terminal-mods with a layout

You are in a clone of claude-terminal-mods. Goal: the person's layout is at `~/.claude/terminal-layout.json`, the plugins `checklist` and `cockpit` are installed from this clone, and the status line points at this clone's `statusline/statusline.zsh`.

Rules:
- Run each step yourself, one at a time, and report what you did.
- Touch only the files named below. Never change any other setting in `~/.claude/settings.json`.
- Ask before overwriting or editing any file that already exists.
- The mods are an early-access Claude Code feature. Say so once.

## 1. Check the clone

- `pwd` must be the clone: `.claude-plugin/marketplace.json`, `checklist/`, `cockpit/` and `statusline/statusline.zsh` exist. If not, stop and ask the person to start Claude Code in the clone. Remember the absolute path as CLONE.
- `jq --version` and `zsh --version` must work. If one is missing, say the status line needs it (jq ships with macOS 15 and newer) and continue with the rest if the person agrees.

## 2. Get the layout

- The person gives a file path or pastes JSON. If neither, ask once. If they have none, offer `layouts/default.json` from the clone.
- Pasted JSON: write it to a file in a scratch folder (not inside the clone) first.
- Validate:

  ```sh
  jq -e '.format == "claude-terminal-layout" and .version == 1 and (.sidebar|type=="array") and (.bandAbovePrompt|type=="array") and (.turnSummary|type=="array") and (.statusLine|type=="array")' FILE
  ```

  If this prints `true`, go on. If it fails, say which part is wrong (format, version, or a missing section) and stop. The spec is `LAYOUT.md`.
- Tell the person in one line what the layout contains: how many blocks in `sidebar` and `bandAbovePrompt`, how many lines in `turnSummary` and `statusLine`. An empty `sidebar` means no pane.

## 3. Put it in place

- If `~/.claude/terminal-layout.json` exists, tell the person and ask before replacing it. If they agree, back it up first: `cp ~/.claude/terminal-layout.json ~/.claude/terminal-layout.json.bak`.
- Then `cp FILE ~/.claude/terminal-layout.json`.

## 4. Install the plugins

```sh
claude plugin marketplace add CLONE
claude plugin install checklist@claude-terminal-mods
claude plugin install cockpit@claude-terminal-mods
claude plugin list
```

- If the marketplace is already added from another path, or a plugin is already installed, show the output and ask what to do. Do not remove anything on your own.
- `claude plugin list` must show both with `Status: enabled`.

## 5. Status line and env var

Read `~/.claude/settings.json` (it may not exist). Show the person the exact change as a diff, using the absolute CLONE path:

```json
"statusLine": { "type": "command", "command": "/bin/zsh -f CLONE/statusline/statusline.zsh" }
```

- If a `statusLine` entry already exists, show it and say this replaces it.
- Also offer this entry, and say why: Claude Code may need the function-hooks switch on their account (the variable name is in Claude Code 2.1.301; third-party guides say it is needed until the feature reaches the account; tested with 2.1.301):

  ```json
  "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" }
  ```

  Add it to an existing `env` object; do not replace the object. If the person is unsure, suggest to add it only if the pane does not appear after the restart.
- Wait for the person to agree to each part.
- Back up first: `cp ~/.claude/settings.json ~/.claude/settings.json.bak`.
- Apply only the agreed keys, keeping every other key as it is. With jq, for example: `jq --arg cmd "/bin/zsh -f CLONE/statusline/statusline.zsh" '.statusLine = {type: "command", command: $cmd}' ~/.claude/settings.json > TMP && mv TMP ~/.claude/settings.json`. Use the Edit tool instead if the file has comments or jq fails. Check that the result is valid JSON.

## 6. Finish

Tell the person:

1. Quit and restart Claude Code (a new session in any folder).
2. What to look for: the Checklist pane opens beside the chat (`/checklist` opens it again), the summary line appears under an answer, the status line shows the layout's `statusLine` lines, `/mods-usage` prints counters.
3. If no pane appears: add the `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` entry if not yet done, restart, and check `claude plugin list`.
4. To change the layout later: export a new file from https://dgtlwrks.github.io/claude-terminal-mods/ and copy it over `~/.claude/terminal-layout.json`.
5. To undo: `SETUP.md` in the clone has the uninstall steps; the `.bak` files are the backups made here.

Do not claim the pane or status line works until the person has restarted and confirmed it.
