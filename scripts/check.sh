#!/bin/sh
# Fails when a copy made by scripts/sync.sh has drifted from its source, then runs every test.
set -eu
cd "$(dirname "$0")/.."
status=0
for p in checklist cockpit; do
  if ! { echo '// Written by scripts/sync.sh from layouts/default.json. Edit that file, not this one.'; printf 'export default '; cat layouts/default.json; } | cmp -s - "$p/hooks/default-layout.ts"; then
    echo "out of sync: $p/hooks/default-layout.ts (run scripts/sync.sh)"; status=1
  fi
done
{ echo '// Written by scripts/sync.sh from layouts/default.json. Edit that file, not this one.'; printf 'window.DEFAULT_LAYOUT = '; cat layouts/default.json; printf ';'; } | cmp -s - docs/default-layout.js || { echo "out of sync: docs/default-layout.js (run scripts/sync.sh)"; status=1; }
cmp -s checklist/hooks/layout.ts cockpit/hooks/layout.ts || { echo "out of sync: cockpit/hooks/layout.ts (run scripts/sync.sh)"; status=1; }
[ "$status" -eq 0 ] || exit 1
claude plugin test checklist
claude plugin test cockpit
zsh statusline/test.zsh
