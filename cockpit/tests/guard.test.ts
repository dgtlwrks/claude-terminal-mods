import { describe, expect, test } from 'claude-code/testing'

import { commands, refusal } from '../hooks/guard'

// Each test states what SHOULD happen. A failing test = a confirmed bug or gap in the live mod.
describe('AUDIT guard: destructive commands that should be blocked', () => {
  const shouldBlock = [
    'git push -uf origin main',
    'git push -fu origin main',
    '(cd js && git add .)',
    '(git add .)',
    '{ git add .; }',
    'git stash clear',
    'git stash drop',
    'git add -u',
    'git add --update',
    'git add -Av',
    'git add ./',
    'git add ..',
    'git commit -am "wip"',
    'git commit -a -m "wip"',
    'git commit --all -m "wip"',
    'sudo git add .',
    'command git add .',
    'env FOO=1 git add .',
    'time git reset --hard',
    'git checkout -f main',
    'git switch --discard-changes main',
    'git stash apply',
    'if true; then git add .; fi',
    'git clean -xfd',
    'git  add   .',
    'git add "."',
    'git add . 2>&1',
    'git checkout HEAD -- .',
    'git checkout .',
  ]
  for (const c of shouldBlock) test(`should block: ${c}`, () => expect(refusal(c)).not.toBe(null))
})

describe('AUDIT guard: harmless commands that should be allowed', () => {
  const shouldAllow = [
    'git commit -m "note; git add . is blocked from now on"',
    'git commit -m "docs: never run\ngit stash\nwithout a tag"',
    `git commit -m "$(cat <<'EOF'\nGuard notes\n\ngit reset --hard is refused\nEOF\n)"`,
    `cat > notes.md <<'EOF'\nRules:\ngit stash pop is not allowed here\nEOF`,
    'git clean -n',
    'git clean -nfd',
    'git clean --dry-run -fd',
    'git stash push -mwip-tag',
    'git stash drop stash@{2}',
    'git stash apply 3f2a91c',
    'git push origin --delete old-branch',
    'git branch -D old-branch',
    'git worktree remove ../wt',
    'git log --oneline | head -5',
    'grep -rn "git add ." docs/',
    'echo "do not run git reset --hard"',
    'git add js/a.mjs js/b.mjs',
    'git restore --staged js/a.mjs',
    'git add -p js/a.mjs',
    'git push --force-if-includes origin main',
  ]
  for (const c of shouldAllow) test(`should allow: ${c.replace(/\n/g, '\\n')}`, () => expect(refusal(c)).toBe(null))
})

describe('guard: reader and rules beyond the audit list', () => {
  const shouldBlock = [
    'cat <<-EOF\n\tnotes\n\tEOF\ngit add .',
    'grep -c x <<< "git add ."\ngit reset --hard',
    'cat <<<git; git add .',
    'echo $(git add .)',
    'echo "$(git add .)"',
    'cat <(git stash)',
    'echo `git stash pop`',
    'git add . &>/dev/null',
    'git add . | cat',
    'git stash drop 2>/dev/null',
    'git stash save wip',
    'git stash -u',
    'git stash push -- js/a.mjs',
    'git stash drop -q',
    'git stash apply --index',
    'git -c core.pager=cat --no-pager stash',
    'git --git-dir=.git --work-tree . add .',
    'sudo -u me git add .',
    'nice -n 5 git push -f',
    'time -p git reset --hard',
    'FOO=1 BAR=2 git add .',
    'while true; do git stash pop; done',
    '! git add -A',
    '/usr/bin/git add .',
    '\\git add .',
    'git add \\\n  .',
    "echo $'it\\'s'; git add .",
    'echo a#b; git add .',
    'cat <<EOF\ngit add .',
    'echo $((1 << 2))\ngit add .',
    'git commit -va -m wip',
    'git commit -a',
    'git push --force-with-lease=main:abc123 origin main',
    'git push origin +refs/heads/x:refs/heads/x',
    'git clean --force',
    'git clean -df -e node_modules',
    'git restore -- ./',
    'git restore "*"',
    'git checkout --force main',
    'git checkout -- ..',
    'git switch -f main',
    'git switch --force main',
    'git add --all js/',
  ]
  const shouldAllow = [
    'cat <<-EOF\n\tgit add .\n\tEOF\necho done',
    'cat << "EOF"\ngit stash clear\nEOF',
    'cat <<EOF >notes.md\ngit push -f\nEOF',
    'cat <<A <<B\ngit add .\nA\ngit stash\nB',
    'git stash push --message=x',
    'git stash push --message x',
    'git stash push -um wip',
    'git stash -m wip',
    'git stash show -p stash@{1}',
    'git stash branch fix stash@{0}',
    'git commit --amend -m x',
    'git commit -mfix-a-bug',
    'git commit -ma',
    'git commit -m "$(git status --short)"',
    'echo "\\$(git add .)"',
    "echo '$(git add .)'",
    '# git add .',
    'echo ok # git add .; git reset --hard',
    'git checkout -b feature',
    'git checkout -bfix',
    'git switch -c feature',
    'git push -u origin main',
    'git push --no-force-with-lease origin main',
    'git clean -fdn',
    'git reset --soft HEAD~1 2>&1',
    'command -v git',
    'gitk --all',
    'printf "%s\\n" "git stash pop" > notes.txt',
  ]
  for (const c of shouldBlock) test(`blocks: ${c.replace(/\n/g, '\\n')}`, () => expect(refusal(c)).not.toBe(null))
  for (const c of shouldAllow) test(`allows: ${c.replace(/\n/g, '\\n')}`, () => expect(refusal(c)).toBe(null))

  test('guard reader keeps stash@{2} as one word and splits on a lone { or }', () => {
    expect(commands('git stash drop stash@{2}')).toEqual([['git', 'stash', 'drop', 'stash@{2}']])
    expect(commands('{ git add .; } && echo "{"')).toEqual([['git', 'add', '.'], ['echo', '{']])
  })

  test('guard message names the git command from git on, quotes removed', () => {
    expect(refusal('(cd js && git add .)')).toBe('guard: "git add ." blocked: stage only the paths you own')
    expect(refusal('sudo git commit -am "wip"')).toBe('guard: "git commit -am wip" blocked: stage only the paths you own')
    expect(refusal('git stash clear')).toBe('guard: "git stash clear" blocked: it deletes every session\'s stashes')
    expect(refusal('git stash drop')).toBe(
      'guard: "git stash drop" blocked: the stash stack is shared by every worktree: name your own entry (stash@{n} or its sha)',
    )
    expect(refusal('git checkout -f main')).toBe(
      'guard: "git checkout -f main" blocked: it discards uncommitted work, other sessions\' included',
    )
  })

  test('guard reads a 100 KB heredoc in well under a second', () => {
    const body = 'git add . && git reset --hard; git stash pop\n'.repeat(2300)
    const started = Date.now()
    expect(refusal(`git commit -F- <<'EOF'\n${body}EOF\ngit status`)).toBe(null)
    expect(refusal(`cat <<'EOF'\n${body}EOF\ngit add .`)).not.toBe(null)
    expect(Date.now() - started < 500).toBe(true)
  })

  test('guard reads 100 KB of heredoc-like shifts and quotes in well under a second', () => {
    const text = `${'echo $((1 << 2)) "a" \'b\' x=1\n'.repeat(3500)}git add .`
    const started = Date.now()
    expect(refusal(text)).not.toBe(null)
    expect(Date.now() - started < 500).toBe(true)
  })

  test('guard never throws and never lets a deeply nested git command through', () => {
    expect(refusal(`echo ${'"$('.repeat(20000)}git add .`)).not.toBe(null)
  })
})

// git takes abbreviated long options and --opt=value; a macOS disk ignores the case of git and its subcommands.
describe('guard: spellings git accepts for the same destructive command', () => {
  const blocked = [
    'git reset --har',
    'git reset --hard=HEAD',
    'git push --force-w origin main',
    'git push --force-with-lease=main origin main',
    'git push --forc origin main',
    'git add --al',
    'git commit --al -m x',
    'git switch --discard main',
    'GIT reset --hard',
    '/usr/bin/Git reset --hard',
    'git RESET --hard',
  ]
  for (const c of blocked) test(`refuses: ${c}`, () => expect(refusal(c)).not.toBe(null))
  const allowed = ['git reset --soft HEAD~1', 'git push --follow-tags origin main', 'git commit --amend -m x', 'git switch --detach main', 'GIT status']
  for (const c of allowed) test(`allows: ${c}`, () => expect(refusal(c)).toBe(null))
})
