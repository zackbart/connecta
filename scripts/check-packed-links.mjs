// The packed-Markdown link policy, enforced (#378).
//
// A relative link in shipped Markdown is a promise about the tarball, and the
// tarball is built output rather than a checkout: it carries no `eval/`, no
// `test/`, no `scripts/`, and no `assets/`. A reader who installed the package
// and followed one of those pointers landed nowhere, and nothing failed,
// because the gate that read these links only looked at `documentation/`
// targets. So:
//
//   Every relative link in packed Markdown must resolve to a path the tarball
//   carries. A target that is repository-only — evidence directories, test
//   files, maintainer scripts, the README hero — is written as an absolute
//   `https://github.com/zackbart/connecta/blob/main/...` URL (or the
//   `raw.githubusercontent.com` form for an image), which resolves for a
//   reader outside the repository and which `check:docs` resolves back to the
//   checkout, so it still fails when the file it cites moves.
//
// The rule is deliberately about links, not about contents: shipping `eval/`
// or `test/` to satisfy it would undo the trim of #346, and the citations that
// make the guides verifiable stay exactly where they are.
//
// The packed path list comes from `npm pack`, so this script is given one
// rather than guessing it from `package.json` "files".

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { markdownLinks, unescapeTarget } from "./markdown-links.mjs";

// Release notes quote the paths that existed when they shipped; they are a
// record, not a live pointer, which is why `check:docs` exempts them too.
const recordOnly = new Set(["CHANGELOG.md"]);

function usage(message) {
  if (message) console.error(message);
  console.error(
    "usage: node scripts/check-packed-links.mjs --root <path> --files <path>",
  );
  process.exit(2);
}

/**
 * Every packed-Markdown link that neither ships nor resolves for an outside
 * reader, as `{ path, line, message }` records.
 */
async function packedLinkErrors(root, packedPaths) {
  const packed = new Set(packedPaths);
  const errors = [];
  for (const packedPath of [...packed].sort()) {
    if (!packedPath.endsWith(".md") || recordOnly.has(packedPath)) continue;
    const source = await readFile(resolve(root, packedPath), "utf8");
    const from = dirname(packedPath);
    for (const { line, target } of markdownLinks(source)) {
      const resolvedTarget = unescapeTarget(target);
      // An absolute URL is somebody else's promise to keep; `check:docs`
      // audits the ones that point back into this repository.
      if (
        /^[a-z][a-z0-9+.-]*:/i.test(resolvedTarget) ||
        resolvedTarget.startsWith("/")
      ) {
        continue;
      }
      const [withoutFragment] = resolvedTarget.split("#");
      const [relativePath] = withoutFragment.split("?");
      // A bare fragment points inside the file that carries it.
      if (!relativePath) continue;
      const resolvedPath = join(from, relativePath).split("\\").join("/");
      // A trailing slash points at the directory, which the tarball carries so
      // long as anything under it ships.
      const carried = resolvedPath.endsWith("/")
        ? [...packed].some((candidate) => candidate.startsWith(resolvedPath))
        : packed.has(resolvedPath);
      if (carried) continue;
      errors.push({
        path: packedPath,
        line,
        message:
          `relative link "${target}" resolves to ${resolvedPath}, which the ` +
          "tarball does not carry; ship the target or cite it as " +
          `https://github.com/zackbart/connecta/blob/main/${
            resolvedPath.replace(/\/$/, "")
          }`,
      });
    }
  }
  return errors;
}

let root;
let files;
const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index += 1) {
  const argument = argv[index];
  if (argument === "--root" || argument === "--files") {
    const value = argv[index + 1];
    if (!value) usage(`${argument} requires a path`);
    if (argument === "--root") root = resolve(value);
    else files = resolve(value);
    index += 1;
  } else {
    usage(`unknown argument: ${argument}`);
  }
}
if (!root || !files) usage("--root and --files are both required");

const packedPaths = (await readFile(files, "utf8"))
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean);
const errors = await packedLinkErrors(root, packedPaths);
if (errors.length > 0) {
  for (const error of errors) {
    console.error(`${error.path}:${error.line}: ${error.message}`);
  }
  process.exitCode = 1;
} else {
  console.log(`packed link check passed (${packedPaths.length} packed paths)`);
}
