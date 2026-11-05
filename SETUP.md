# Manual setup

These steps do what the `terminal-layout-setup` skill does. Replace `/path/to/claude-terminal-mods` with the folder of your clone. Do not move or delete the clone afterwards: the plugins and the status line script are read from it (`claude plugin list` shows the path under "Read from").

Mods are an early-access Claude Code feature. Tested with Claude Code 2.1.301. See the requirements in [README.md](README.md).

## 1. Back up your settings

```sh
cp ~/.claude/settings.json ~/.claude/settings.json.bak
```

If `~/.claude/terminal-layout.json` already exists, back it up too:

```sh
cp ~/.claude/terminal-layout.json ~/.claude/terminal-layout.json.bak
```

## 2. Put your layout in place

Export your layout from https://dgtlwrks.github.io/claude-terminal-mods/ and copy it:

```sh
cp /path/to/exported-layout.json ~/.claude/terminal-layout.json
```

Check that it is a version 1 layout:

```sh
jq -e '.format == "claude-terminal-layout" and .version == 1' ~/.claude/terminal-layout.json
```

`true` means the file is valid. Without a valid file the plugins draw the default in `layouts/default.json`. To start from the default, copy that file instead.

## 3. Add the marketplace and install both plugins

```sh
claude plugin marketplace add /path/to/claude-terminal-mods
claude plugin install checklist@claude-terminal-mods
claude plugin install cockpit@claude-terminal-mods
```

Check:

```sh
claude plugin list
```

Both plugins should show `Status: enabled`. Both commands install at user scope by default; `--scope project` or `--scope local` are the other choices (see `claude plugin install --help`).

## 4. Turn on the status line

Add this to `~/.claude/settings.json`, merging it with what is already there:

```json
{
  "statusLine": {
    "type": "command",
    "command": "/bin/zsh -f /path/to/claude-terminal-mods/statusline/statusline.zsh"
  }
}
```

Use the absolute path of your clone. The script needs `zsh` and `jq`; `jq --version` tells you if `jq` is installed.

If you already have a `statusLine` entry, this replaces it. Keep the old value somewhere (the backup from step 1 has it).

## 5. Function hooks switch (if the mods do not load)

If the pane never appears after step 6, Claude Code may need the function-hooks switch on your account. Add this to `~/.claude/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1"
  }
}
```

The variable name is in the Claude Code 2.1.301 binary. Third-party guides say it is needed until the feature is rolled out to your account. The value `1` is the usual way to turn such a switch on; it was not tested here.

## 6. Restart and check

Quit Claude Code and start it again. Then:

- The checklist pane opens beside the chat. `/checklist` opens it again.
- Ask Claude for a task with several steps. The checklist fills in.
- After an answer, the summary line from `turnSummary` appears under it.
- The status line shows the lines from `statusLine`.
- `/mods-usage` prints the counters.
- `git add .` through Claude's Bash tool is refused by the guard.

## Change the layout later

Export a new file from the editor and copy it over `~/.claude/terminal-layout.json`. The plugins read the file on each draw, so the pane and the summary line follow. Whether the status line follows on the next refresh is up to `statusline.zsh`.

## Update

The plugins are read from your clone, so pulling is enough:

```sh
cd /path/to/claude-terminal-mods && git pull
```

Changes take effect at the next Claude Code session start, or after `/reload-plugins`. `claude plugin update checklist@claude-terminal-mods` reports "nothing to update" for a plugin read from a folder.

## Uninstall and revert

```sh
claude plugin uninstall checklist@claude-terminal-mods
claude plugin uninstall cockpit@claude-terminal-mods
claude plugin marketplace remove claude-terminal-mods
```

Then:

1. Remove the `statusLine` entry (and the `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` line, if you added it) from `~/.claude/settings.json`, or restore the backup: `cp ~/.claude/settings.json.bak ~/.claude/settings.json`.
2. Delete `~/.claude/terminal-layout.json`, or restore `~/.claude/terminal-layout.json.bak`.
3. Restart Claude Code.
