#!/usr/bin/env bash
set -euo pipefail

# Read git diff --no-renames --name-only -z. Pull requests audit dependencies
# only when the root dependency graph changes; upstream advisories reach the
# nightly Security workflow and the publish gate instead.
security=false
while IFS= read -r -d '' path; do
  case "$path" in
    package.json|package-lock.json)
      security=true
      break
      ;;
  esac
done
echo "$security"
