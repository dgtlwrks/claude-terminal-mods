import { describe, expect, test } from 'claude-code/testing'

import { refusal } from '../hooks/guard'

// Command shapes taken from real sessions: long multi-line commands, files written through heredocs,
// the git housekeeping the instructions ask for.
describe('guard on real command shapes', () => {
  const allowed: [string, string][] = [
    [
      'a test file that lists git commands, written through a heredoc, then a test run',
      "cat > tests/x.test.ts <<'EOF'\nconst blocked = [\n  'git push -uf origin main',\n  'git commit -m \"note; git add . is blocked from now on\"',\n  'git stash clear',\n]\nEOF\ncd /tmp/x && claude plugin test ./cockpit 2>&1 | tail -5",
    ],
    ['staging named paths in another folder', 'git -C /Users/me/src/mods add .gitignore .claude-plugin checklist cockpit'],
    ['a commit with two message paragraphs', 'git -C "$M" commit -q -m "Baseline before the fixes" -m "Co-Authored-By: Someone <someone@example.com>"'],
    ['creating and pushing a private repository', 'gh repo create me/claude-mods --private --source /Users/me/src/mods --push'],
    ['a python script that mentions git', "python3 - <<'EOF'\nimport subprocess\nprint('git add . would be refused')\nEOF"],
    ['removing a dead worktree and branch', 'git worktree prune && git worktree remove ../wt && git branch -D old && git push origin --delete old'],
    ['a tagged stash, then list, apply and drop by name', "git stash push -u -m \"tag-123\" && git stash list --format='%H %gs' && git stash apply 3f2a91c && git stash drop stash@{1}"],
    ['a commit limited to named paths', 'git commit -m "wip" -- js/a.mjs js/b.mjs'],
    ['new branches', 'git checkout -b feature && git switch -c other && git checkout main'],
    ['unstaging one file', 'git restore --staged --worktree js/a.mjs'],
    ['a dry-run clean', 'git clean -fdn'],
    ['a subshell that only reads', 'echo "a" && (git status; git diff --stat) | head -20'],
    ['a loop adding named files', 'for f in a.mjs b.mjs; do git add "$f"; done'],
    ['amending without staging everything', 'git commit --amend --no-edit'],
    ['a first push with upstream', 'git push -u origin feature'],
    ['a plain refspec push', 'git push origin main:main'],
    ['an empty command', ''],
    ['whitespace only', '  \n\t '],
    ['a doc line in a commit message heredoc', "git commit -m \"$(cat <<'EOF'\nGuard: refuse git reset --hard and git stash pop\n\nCo-Authored-By: Someone <someone@example.com>\nEOF\n)\""],
  ]
  const blocked: [string, string][] = [
    ['staging everything', 'git add -A'],
    ['staging everything after --', 'git add -- .'],
    ['forcing ignored files in from the top', 'git add -f .'],
    ['commit that stages every tracked change', 'git commit -am "wip"'],
    ['force push with lease', 'git push --force-with-lease origin main'],
    ['hard reset to the remote', 'git fetch origin && git reset --hard origin/main'],
    ['clean with force', 'git clean -fdx'],
    ['a destructive command after a heredoc', "cat > notes.md <<'EOF'\nnotes\nEOF\ngit stash clear"],
    ['a destructive command inside a subshell after cd', '(cd /tmp/repo && git checkout -- .)'],
    ['a destructive command behind env and sudo', 'sudo env GIT_DIR=/x git reset --hard'],
    ['an absolute path to git', '/usr/bin/git stash pop'],
  ]
  for (const [name, c] of allowed) test(`allows: ${name}`, () => expect(refusal(c)).toBe(null))
  for (const [name, c] of blocked) test(`blocks: ${name}`, () => expect(refusal(c)).not.toBe(null))

  test('a command that is not text is refused, not run', () => {
    expect(() => refusal(undefined as never)).not.toThrow()
  })
})
