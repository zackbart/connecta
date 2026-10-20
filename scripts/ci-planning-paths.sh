#!/usr/bin/env bash
set -euo pipefail

# Read git diff --no-renames --name-only -z. A pull request is planning-only when
# every changed path is a decision record or a changelog fragment; CI then skips
# the test, build and browser jobs while static checks still validate it. Shipped
# documentation is not planning: it needs build and package validation. An empty
# diff runs everything.
planning=false
while IFS= read -r -d '' path; do
  case "$path" in
    decisions/*|.changes/*)
      planning=true
      ;;
    *)
      planning=false
      break
      ;;
  esac
done
echo "$planning"
