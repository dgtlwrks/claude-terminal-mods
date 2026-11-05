#!/bin/zsh -f
# Tests for statusline.zsh. Run from anywhere: zsh statusline/test.zsh. Exits non-zero when a case fails.
# Each case runs the script with a throwaway HOME (so the real ~/.claude layout never leaks in), a fixed
# non-UTC time zone (so local-time output cannot pass by accident), and ANSI/OSC 8 stripped from the output.

zmodload zsh/datetime
here=${0:A:h}
script=$here/statusline.zsh
tmp=$(mktemp -d) || exit 1
trap 'rm -rf "$tmp"' EXIT

export HOME=$tmp/home TZ=Asia/Kolkata GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
mkdir -p $HOME/.claude
layout_file=$HOME/.claude/terminal-layout.json
ESC=$'\033'
fails=0 total=0

strip() { sed -E "s/${ESC}\[[0-9;]*m//g; s/${ESC}\]8;;[^${ESC}]*${ESC}\\\\//g"; }
run() { zsh -f $script <<< "$1"; }                # raw output
plain() { run "$1" | strip; }
check() {                                          # name, expected, actual
  (( total++ ))
  if [[ $2 == $3 ]]; then print -r -- "ok   $1"
  else (( fails++ )); print -r -- "FAIL $1"; print -r -- "  expected: ${(qq)2}"; print -r -- "  actual:   ${(qq)3}"; fi
}
local_time() { strftime "$1" $2; }                 # honours TZ

# --- Fixtures: a clean git repo at <tmp>/work/acme/shop and a plain directory ---
repo=$tmp/work/acme/shop
mkdir -p $repo $tmp/plain/acme/docs
git -C $repo init -q -b main
git -C $repo -c user.name=t -c user.email=t@example.com commit -q --allow-empty -m init
repo_cwd=...work/acme/shop
plain_cwd=...plain/acme/docs

# Input builder: args are jq filters applied to a full input pointing at $1.
full() {
  local dir=$1 exp=$(( EPOCHSECONDS + 19 * 60 + 45 )); shift   # 45 s of slack so "cold in 19m" survives a slow machine
  jq -nc --arg dir "$dir" --argjson exp "$exp" '{
    session_name: "Fix the login timeout", model: {display_name: "Opus 5.5"}, effort: {level: "xhigh"},
    workspace: {current_dir: $dir, repo: {owner: "acme", name: "shop"}},
    cost: {total_cost_usd: 4.88, total_duration_ms: 1228000, total_lines_added: 75, total_lines_removed: 8},
    context_window: {total_input_tokens: 226000, context_window_size: 1000000, used_percentage: 23},
    prompt_cache: {warm: true, hit_ratio: 0.97, expires_at: $exp},
    rate_limits: {five_hour: {used_percentage: 12, resets_at: 1767268800}, seven_day: {used_percentage: 26, resets_at: 1767528000}},
    pr: {number: 42, url: "https://github.com/acme/shop/pull/42", review_state: "approved"}
  }'"${*:+ | $*}"
}
h5=$(local_time %H:%M 1767268800) wk=$(local_time '%a %H:%M' 1767528000)

# (a) default layout, full input, clean git repo
out=$(plain "$(full $repo)")
check "a: default layout, row 1" "[Opus 5.5 · xhigh] 📁 $repo_cwd | 🌿 main 👍 +75 −8" "${out%%$'\n'*}"
check "a: default layout, rows 2 and 3" \
  "██░░░░░░░░ 23% 226k/1M | \$4.88 | ⏱️ 20m 28s | 5h 12% ↻$h5 | wk 26% ↻$wk
💬 Fix the login timeout | ⚡ cache warm 97% hit, cold in 19m | 🔗 acme/shop | PR #42 approved" "${out#*$'\n'}"
check "a: 5h and week times are local (not UTC)" "↻17:30" "↻$h5"

# dirty repo gets the other mark
touch $repo/new.txt
check "a: dirty repo" "[Opus 5.5 · xhigh] 📁 $repo_cwd | 🌿 main 👎 +75 −8" "$(plain "$(full $repo)" | head -n 1)"
rm $repo/new.txt

# detached HEAD falls back to the short SHA
git -C $repo -c user.name=t -c user.email=t@example.com commit -q --allow-empty -m two
sha=$(git -C $repo rev-parse --short HEAD)
git -C $repo checkout -q --detach
check "a: detached HEAD shows short SHA" "[Opus 5.5 · xhigh] 📁 $repo_cwd | 🌿 $sha 👍 +75 −8" "$(plain "$(full $repo)" | head -n 1)"
git -C $repo checkout -q main

# styles: natural level colours, and the element's own style winning over them
raw=$(run "$(full $repo '.context_window.used_percentage = 95')")
[[ $raw == *"${ESC}[31m█████████░${ESC}[0m"* ]] && r=yes || r=no
check "a: ctx.bar natural style is red at 95%" yes $r
raw=$(run "$(full $repo)")
[[ $raw == *"${ESC}[32m██░░░░░░░░${ESC}[0m"* ]] && r=yes || r=no
check "a: ctx.bar natural style is green at 23%" yes $r
raw=$(run "$(full $repo '.prompt_cache.warm = false')")
[[ $raw == *"${ESC}[2m❄ cache cold${ESC}[0m"* ]] && r=yes || r=no
check "a: cold cache is dim" yes $r
[[ $raw == *"${ESC}]8;;https://github.com/acme/shop${ESC}\\acme/shop${ESC}]8;;${ESC}\\"* ]] && r=yes || r=no
check "a: repo is an OSC 8 link" yes $r
check "a: cold cache text" "💬 Fix the login timeout | ❄ cache cold | 🔗 acme/shop | PR #42 approved" "$(plain "$(full $repo '.prompt_cache.warm = false')" | tail -n 1)"

# (b) effort absent
check "b: no effort" "[Opus 5.5] 📁 $repo_cwd | 🌿 main 👍 +75 −8" "$(plain "$(full $repo 'del(.effort)')" | head -n 1)"

# (c) no repo, session, pr or cache: third row omitted
out=$(plain "$(full $repo 'del(.session_name, .workspace.repo, .pr, .prompt_cache)')")
check "c: third row omitted" 2 "$(print -r -- "$out" | wc -l | tr -d ' ')"

# (d) no rate limits: no trailing separator
check "d: no rate limits" "██░░░░░░░░ 23% 226k/1M | \$4.88 | ⏱️ 20m 28s" "$(plain "$(full $repo 'del(.rate_limits)')" | sed -n 2p)"
check "d: only the week limit" "██░░░░░░░░ 23% 226k/1M | \$4.88 | ⏱️ 20m 28s | wk 26% ↻$wk" "$(plain "$(full $repo 'del(.rate_limits.five_hour)')" | sed -n 2p)"

# (g) directory outside git: no branch, no mark, no dangling separator
check "g: non-git directory" "[Opus 5.5 · xhigh] 📁 $plain_cwd +75 −8" "$(plain "$(full $tmp/plain/acme/docs)" | head -n 1)"
check "g: non-git, no diff" "[Opus 5.5 · xhigh] 📁 $plain_cwd" "$(plain "$(full $tmp/plain/acme/docs 'del(.cost.total_lines_added, .cost.total_lines_removed)')" | head -n 1)"

# (e) custom layout: reordered, a literal emoji, a spaceBefore, a right-aligned width, ignored sample text, own style
cat > $layout_file <<'EOF'
{"format":"claude-terminal-layout","version":1,"statusLine":[
  {"key":"l1","elements":[
    {"key":"cost","text":"IGNORED"},
    {"key":"emoji","text":"🔥"},
    {"key":"model","text":"IGNORED","spaceBefore":3},
    {"key":"effort","width":8,"align":"right","style":["b","c"]},
    {"key":"sep","text":"/"},
    {"key":"duration"}]},
  {"key":"l2","elements":[
    {"key":"emoji","text":"🧪"},
    {"key":"not.in.the.catalog","text":"IGNORED"},
    {"key":"sep","text":"|"},
    {"key":"text","text":"tail"}]},
  {"key":"l3","elements":[]}
]}
EOF
out=$(run "$(full $repo)")
check "e: custom layout" "\$4.88 🔥   Opus 5.5    xhigh / 20m 28s" "$(print -r -- "$out" | head -n 1 | strip)"
[[ $out == *"${ESC}[1;36m xhigh"* || $out == *"   ${ESC}[1;36mxhigh${ESC}[0m"* ]] && r=yes || r=no
check "e: element style overrides, padding stays unstyled" yes $r
check "e: unknown data key drops its emoji; a sep with no data run is not drawn" "tail" "$(print -r -- "$out" | strip | sed -n 2p)"
check "e: row count" 2 "$(print -r -- "$out" | wc -l | tr -d ' ')"

# cache.hit and cache.cold: warm shows both; cold drops cache.hit together with the icon before it
cat > $layout_file <<'EOF'
{"format":"claude-terminal-layout","version":1,"statusLine":[
  {"key":"l1","elements":[{"key":"emoji","text":"⚡"},{"key":"cache.hit"},{"key":"sep","text":"·"},{"key":"cache.cold"}]}]}
EOF
check "e: cache.hit and cache.cold, warm" "⚡ cache warm 97% hit · cold in 19m" "$(plain "$(full $repo)")"
check "e: cache.hit and cache.cold, cold" "cache cold" "$(plain "$(full $repo '.prompt_cache.warm = false')")"
check "e: cache.hit and cache.cold, no cache data" "" "$(plain "$(full $repo 'del(.prompt_cache)')")"
[[ $(run "$(full $repo '.prompt_cache.warm = false')") == *"${ESC}[2mcache cold${ESC}[0m"* ]] && r=yes || r=no
check "e: cache.cold is dim when cold" yes $r

# a blank-width data element keeps its cells and the first drawn element has no leading space
cat > $layout_file <<'EOF'
{"format":"claude-terminal-layout","version":1,"statusLine":[
  {"key":"l1","elements":[{"key":"session.name","width":4},{"key":"repo","width":3},{"key":"text","text":"x"}]}]}
EOF
check "e: blank width cells" "         x" "$(plain "$(full $repo 'del(.session_name, .workspace.repo)')")"

# (f) invalid layout files fall back to the default
for bad in 'not json at all' '{"format":"claude-terminal-layout","version":2,"statusLine":[]}' '{"format":"other","version":1,"statusLine":[]}'; do
  print -r -- "$bad" > $layout_file
  check "f: fallback for ${bad[1,30]}" "[Opus 5.5 · xhigh] 📁 $repo_cwd | 🌿 main 👍 +75 −8" "$(plain "$(full $repo)" | head -n 1)"
done
rm $layout_file
check "f: no file in HOME uses the default" "[Opus 5.5 · xhigh] 📁 $repo_cwd | 🌿 main 👍 +75 −8" "$(plain "$(full $repo)" | head -n 1)"

# formatting edge cases through the default layout
fmt() { plain "$(full $repo "$1")" | sed -n 2p; }
check "fmt: 1.2M window, tokens under 1k" "██░░░░░░░░ 23% 500/1.2M | \$4.88 | ⏱️ 20m 28s | 5h 12% ↻$h5 | wk 26% ↻$wk" \
  "$(fmt '.context_window.total_input_tokens = 500 | .context_window.context_window_size = 1200000')"
check "fmt: hours, cents, 100% context" "██████████ 100% 226k/1M | \$0.05 | ⏱️ 2h 5m | 5h 12% ↻$h5 | wk 26% ↻$wk" \
  "$(fmt '.context_window.used_percentage = 100 | .cost.total_cost_usd = 0.05 | .cost.total_duration_ms = 7500000')"
check "fmt: no window size drops the tokens" "██░░░░░░░░ 23% | \$4.88 | ⏱️ 20m 28s | 5h 12% ↻$h5 | wk 26% ↻$wk" \
  "$(fmt 'del(.context_window.context_window_size)')"
check "fmt: control characters are stripped" "💬 bad[31m name | ⚡ cache warm 97% hit, cold in 19m | 🔗 acme/shop | PR #42 approved" \
  "$(plain "$(full $repo '.session_name = "bad\u001b[31m name\n"')" | sed -n 3p)"
check "fmt: PR without review state or URL" "💬 Fix the login timeout | ⚡ cache warm 97% hit, cold in 19m | 🔗 acme/shop | PR #7" \
  "$(plain "$(full $repo '.pr = {number: 7}')" | sed -n 3p)"

# garbage on stdin must not print a traceback
check "empty stdin prints nothing" "" "$(zsh -f $script < /dev/null 2>&1)"

print -- "$(( total - fails )) of $total passed"
(( fails == 0 ))
