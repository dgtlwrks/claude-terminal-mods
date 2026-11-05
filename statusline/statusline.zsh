#!/bin/zsh -f
# Status line drawn from a layout file. Claude Code runs this with the status line JSON on stdin.
# The layout is ~/.claude/terminal-layout.json when that is a version 1 layout, else layouts/default.json
# in this repo. Only its statusLine rows are used. Layout resolution and formatting live in statusline.jq;
# this script only gathers what jq cannot: the directory text (zsh prompt expansion) and git state.

export GIT_OPTIONAL_LOCKS=0
here=${0:A:h}

input=$(cat)

# Element keys the layout uses. jq -e fails (exit 4) when the file is not a version 1 layout or not valid JSON,
# which is the same test as '.format=="claude-terminal-layout" and .version==1'.
layout_keys() {
  jq -er 'select(.format == "claude-terminal-layout" and .version == 1)
    | [(.statusLine | arrays)[] | objects | (.elements | arrays)[] | objects | .key | strings] | unique | join(" ")' "$1" 2>/dev/null
}
layout=$HOME/.claude/terminal-layout.json
if ! keys=$(layout_keys "$layout"); then
  layout=$here/../layouts/default.json
  keys=$(layout_keys "$layout") || exit 0
fi

dir=$(jq -r '.workspace.current_dir // .cwd // ""' <<< "$input" 2>/dev/null)
[[ -n $dir && -d $dir ]] && cd "$dir" 2>/dev/null

# Directory: zsh's own prompt expansion, three trailing components and "..." when there are more.
cwd=$(print -rP -- '%4(c:...:)%3c')

# Git only when the layout shows it: status can be slow in a large repo.
ref='' mark=''
if [[ " $keys " == *" branch "* || " $keys " == *" git.mark "* ]]; then
  # Branch, else tag, else short SHA (oh-my-zsh git_prompt_info order).
  ref=$(git symbolic-ref --short -q HEAD 2>/dev/null) \
    || ref=$(git describe --tags --exact-match HEAD 2>/dev/null) \
    || ref=$(git rev-parse --short HEAD 2>/dev/null)
  if [[ -n $ref && " $keys " == *" git.mark "* ]]; then
    [[ -n $(git status --porcelain --ignore-submodules=dirty 2>/dev/null) ]] && mark='👎' || mark='👍'
  fi
fi

jq -r --arg cwd "$cwd" --arg branch "$ref" --arg mark "$mark" --slurpfile layout "$layout" \
  -f "$here/statusline.jq" <<< "$input" 2>/dev/null
