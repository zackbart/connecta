#!/usr/bin/env node
// Delete every emitted declaration no `exports[*].types` target can reach.
//
// `tsc` writes a .d.ts beside every .js, but only the ones reachable from the
// exports map are API; the rest (the MCP route handlers, the catalog service,
// the generated operator UI bundle, every src/runtime/ module) describe
// internals nobody can import by a public path. Shipping them anyway invites
// deep imports that pin internals, and gives Effect types a place to sit in the
// tarball where no reachability check would look. So the build removes them,
// using the same walker scripts/check-declarations.mjs checks with, and
// `check-declarations.mjs --dist .` then fails on anything left over.
//
// src/runtime/ declarations go unconditionally. If one of them was reachable,
// the published types now reference a missing file, and the --dist check says
// so — the fix is in the source, not here.

import { readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  declarationEntries,
  declarationRoots,
  diskReader,
  listDeclarations,
  reachableDeclarations,
} from "./check-declarations.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const entries = declarationEntries(manifest);
const { reachable } = reachableDeclarations(entries, diskReader(root));

let kept = 0;
let pruned = 0;
for (const dir of declarationRoots(entries)) {
  for (const file of listDeclarations(root, dir)) {
    const internal = file.startsWith(`${dir}/runtime/`);
    if (reachable.has(file) && !internal) {
      kept += 1;
      continue;
    }
    rmSync(join(root, file));
    pruned += 1;
  }
}
console.log(
  `prune-declarations: kept ${kept}, removed ${pruned} unreachable declaration(s)`,
);
