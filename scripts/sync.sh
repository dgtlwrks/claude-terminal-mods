#!/bin/sh
# Copies what both plugins need into each of them: they install on their own and cannot reach the repo root.
# Sources: layouts/default.json (written into each plugin as hooks/default-layout.ts) and checklist/hooks/layout.ts.
set -eu
cd "$(dirname "$0")/.."
for p in checklist cockpit; do
  { echo '// Written by scripts/sync.sh from layouts/default.json. Edit that file, not this one.'; printf 'export default '; cat layouts/default.json; } > "$p/hooks/default-layout.ts"
done
cp checklist/hooks/layout.ts cockpit/hooks/layout.ts
rm -f checklist/default-layout.json cockpit/default-layout.json
mkdir -p docs
{ echo '// Written by scripts/sync.sh from layouts/default.json. Edit that file, not this one.'; printf 'window.DEFAULT_LAYOUT = '; cat layouts/default.json; printf ';'; } > docs/default-layout.js
echo "synced default-layout.ts and layout.ts into checklist/ and cockpit/"
