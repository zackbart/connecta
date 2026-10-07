#!/usr/bin/env bash
set -euo pipefail

# Read git diff --no-renames --name-only -z. Pull requests audit dependencies
# when dependency-resolution inputs change. There are no workspaces today,
# but CI installs the Node template in package/Docker smoke and publishes
# examples. Match nested inputs too, including future workspace manifests;
# upstream advisories reach the nightly workflow and publish gate.
security=false
while IFS= read -r -d '' path; do
  case "$path" in
    package.json|*/package.json|package-lock.json|*/package-lock.json|npm-shrinkwrap.json|*/npm-shrinkwrap.json|.npmrc|*/.npmrc)
      security=true
      break
      ;;
  esac
done
echo "$security"
