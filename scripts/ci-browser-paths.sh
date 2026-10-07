#!/usr/bin/env bash
set -euo pipefail

# Read git diff --no-renames --name-only -z. Skip Chromium only when every
# changed path is known to be unrelated; new inputs run browser tests by default.
browser=false
while IFS= read -r -d '' path; do
  case "$path" in
    src/providers/*|test/providers/*|test/*-provider.test.ts|test/*-provider.node.test.ts|test/provider-conventions.test.ts|test/provider-conventions.node.test.ts|test/provider-registry.test.ts|test/provider-registry.node.test.ts|test/google-workspace-delegation.test.ts|test/google-workspace-delegation.node.test.ts|scripts/drift/*|scripts/drift-check.mjs|documentation/*|decisions/*|spec/*|*.md|.changes/*|eval/*)
      ;;
    *)
      browser=true
      break
      ;;
  esac
done
echo "$browser"
