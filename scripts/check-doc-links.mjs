import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  activeLines,
  markdownLinks,
  unescapeTarget,
} from "./markdown-links.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ignoredDirectories = new Set([
  ".claude",
  ".git",
  ".wrangler",
  "coverage",
  "dist",
  "node_modules",
]);
// Historical release notes quote the section-number syntax and documentation
// paths that existed when those releases shipped. They are records, not live
// documentation pointers, so neither stale-reference nor link checking applies.
const staleReferenceAllowlist = new Set(["CHANGELOG.md"]);
const historicalLinkAllowlist = new Set(["CHANGELOG.md"]);
const staleReferenceDirectoryPrefixes = ["src/", "documentation/", "examples/"];

// The ethos is deliberately terse — the cap is the point, not a formality.
const ethosLineLimit = 150;
// Raised from 700 when code-mode.md gained the emitted-output clauses (#270),
// and again from 800 when it gained the rendered-output clauses (#277): the
// contract grew two real surfaces, not prose. The pressure stays — a guide
// approaching this wall gets compressed before the wall moves again.
const guideLineLimit = 900;

function usage(message) {
  if (message) console.error(message);
  console.error(
    "usage: node scripts/check-doc-links.mjs [--root <path>] [--skip-structure]",
  );
  process.exit(2);
}

function parseArguments(argv) {
  let root = repositoryRoot;
  let checkStructure = true;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--root") {
      const value = argv[index + 1];
      if (!value) usage("--root requires a path");
      root = resolve(value);
      index += 1;
    } else if (argument === "--skip-structure") {
      checkStructure = false;
    } else {
      usage(`unknown argument: ${argument}`);
    }
  }
  return { root, checkStructure };
}

function displayPath(root, path) {
  const shown = relative(root, path) || ".";
  return shown.split(sep).join("/");
}

async function walkFiles(root, directory = root) {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        paths.push(...(await walkFiles(root, path)));
      }
    } else if (entry.isFile()) {
      paths.push(path);
    }
  }
  return paths;
}

function lineCount(source) {
  if (source.length === 0) return 0;
  return source.replace(/\r?\n$/, "").split(/\r?\n/).length;
}

function headingSlug(text) {
  return text
    .replace(/<[^>]*>/g, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*~]/g, "")
    .toLocaleLowerCase("en-US")
    .trim()
    .replace(/[^\p{L}\p{N}\p{M} _-]/gu, "")
    .replace(/\s/g, "-");
}

function headingsFor(source) {
  const emittedSlugs = new Set();
  return activeLines(source).flatMap(({ number, text }) => {
    const match = text.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (!match) return [];
    const baseSlug = headingSlug(match[2]);
    let slug = baseSlug;
    let suffix = 1;
    while (emittedSlugs.has(slug)) {
      slug = `${baseSlug}-${suffix}`;
      suffix += 1;
    }
    emittedSlugs.add(slug);
    return [
      {
        level: match[1].length,
        text: match[2],
        line: number,
        baseSlug,
        slug,
      },
    ];
  });
}

function decodeTargetPart(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

// A link into the repository on github.com is how packed Markdown points at a
// path the tarball does not ship (#378), so it is a local target wearing a URL:
// resolve it back to the checkout and hold it to the same existence check a
// relative link gets. `raw.` and `/raw/` are the image forms — the README hero
// is served from one — and resolve to the same file.
function repositoryPathFor(url) {
  if (url.hostname === "github.com") {
    return url.pathname.match(
      /^\/zackbart\/connecta\/(?:blob|tree|raw)\/main\/(.+)$/,
    )?.[1];
  }
  if (url.hostname === "raw.githubusercontent.com") {
    return url.pathname.match(/^\/zackbart\/connecta\/main\/(.+)$/)?.[1];
  }
  return undefined;
}

function resolveLocalTarget(root, sourcePath, rawTarget) {
  const target = unescapeTarget(rawTarget);
  if (
    target.startsWith("mailto:") ||
    target.startsWith("data:") ||
    target.startsWith("//")
  ) {
    return { external: true };
  }

  if (/^https?:/i.test(target)) {
    let url;
    try {
      url = new URL(target);
    } catch {
      return { malformed: true };
    }
    const repositoryPath = repositoryPathFor(url);
    if (repositoryPath === undefined) return { external: true };
    const decodedPath = decodeTargetPart(repositoryPath);
    const decodedFragment = decodeTargetPart(url.hash.slice(1));
    if (decodedPath === undefined || decodedFragment === undefined) {
      return { malformed: true };
    }
    return {
      path: resolve(root, decodedPath),
      fragment: decodedFragment || undefined,
    };
  }

  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("/")) {
    return { external: true };
  }

  const hash = target.indexOf("#");
  const rawPath = hash < 0 ? target : target.slice(0, hash);
  const rawFragment = hash < 0 ? "" : target.slice(hash + 1);
  const query = rawPath.indexOf("?");
  const pathPart = query < 0 ? rawPath : rawPath.slice(0, query);
  const decodedPath = decodeTargetPart(pathPart);
  const decodedFragment = decodeTargetPart(rawFragment);
  if (decodedPath === undefined || decodedFragment === undefined) {
    return { malformed: true };
  }
  return {
    path: decodedPath ? resolve(dirname(sourcePath), decodedPath) : sourcePath,
    fragment: decodedFragment || undefined,
  };
}

async function localTargetError(root, sourcePath, target, markdownCache) {
  const resolved = resolveLocalTarget(root, sourcePath, target);
  if (resolved.external) return undefined;
  if (resolved.malformed) return `malformed local target "${target}"`;

  let targetStats;
  try {
    targetStats = await stat(resolved.path);
  } catch {
    return `missing local target "${target}"`;
  }
  if (resolved.fragment) {
    if (!targetStats.isFile() || extname(resolved.path).toLowerCase() !== ".md") {
      return `fragment "#${resolved.fragment}" targets a non-Markdown path "${target}"`;
    }
    let document = markdownCache.get(resolved.path);
    if (!document) {
      document = await readFile(resolved.path, "utf8");
      markdownCache.set(resolved.path, document);
    }
    const anchors = new Set(headingsFor(document).map((heading) => heading.slug));
    if (!anchors.has(resolved.fragment)) {
      return `missing fragment "#${resolved.fragment}" in "${displayPath(
        root,
        resolved.path,
      )}" (target "${target}")`;
    }
  }
  return undefined;
}

function addError(errors, root, path, line, message) {
  errors.push({
    path: displayPath(root, path),
    line,
    message,
  });
}

async function checkLinks(root, markdownPaths, markdownCache, errors) {
  for (const path of markdownPaths) {
    if (historicalLinkAllowlist.has(displayPath(root, path))) continue;
    let source = markdownCache.get(path);
    if (!source) {
      source = await readFile(path, "utf8");
      markdownCache.set(path, source);
    }
    for (const { line, target } of markdownLinks(source)) {
      const message = await localTargetError(root, path, target, markdownCache);
      if (message) addError(errors, root, path, line, message);
    }
  }
}

async function checkStaleReferences(root, paths, errors) {
  const stalePattern =
    /(?:docs\/)?documentation\.md(?:#[A-Za-z0-9_/-]+|\s+§\s*\d+)|§\s*\d+/gi;
  for (const path of paths) {
    const shown = displayPath(root, path);
    if (
      staleReferenceAllowlist.has(shown) ||
      (shown !== "README.md" &&
        !staleReferenceDirectoryPrefixes.some((prefix) =>
          shown.startsWith(prefix),
        ))
    ) {
      continue;
    }
    const source = await readFile(path, "utf8");
    const lines =
      extname(path).toLowerCase() === ".md"
        ? activeLines(source)
        : source
            .split(/\r?\n/)
            .map((text, index) => ({ number: index + 1, text }));
    for (const { number, text } of lines) {
      for (const match of text.matchAll(stalePattern)) {
        addError(
          errors,
          root,
          path,
          number,
          `stale documentation reference "${match[0]}"`,
        );
      }
    }
  }
}

async function checkStructure(root, markdownCache, errors) {
  // The retired manual must stay retired: a resurrected docs/ directory is
  // drift back toward the pre-restructure shape, not a new document set.
  try {
    const retired = await stat(resolve(root, "docs"));
    if (retired.isDirectory()) {
      addError(
        errors,
        root,
        resolve(root, "docs"),
        1,
        'retired "docs/" directory exists; guides belong in "documentation/"',
      );
    }
  } catch {
    // absent, as it should be
  }

  for (const required of ["README.md", "ethos.md"]) {
    const path = resolve(root, required);
    try {
      const source = await readFile(path, "utf8");
      markdownCache.set(path, source);
    } catch {
      addError(errors, root, path, 1, `missing ${required}`);
    }
  }

  const ethosPath = resolve(root, "ethos.md");
  const ethos = markdownCache.get(ethosPath);
  if (ethos !== undefined && lineCount(ethos) >= ethosLineLimit) {
    addError(
      errors,
      root,
      ethosPath,
      1,
      `ethos.md has ${lineCount(ethos)} lines; expected fewer than ${ethosLineLimit} — terseness is the point`,
    );
  }

  const guidesDirectory = resolve(root, "documentation");
  let guideEntries;
  try {
    guideEntries = await readdir(guidesDirectory, { withFileTypes: true });
  } catch {
    addError(errors, root, guidesDirectory, 1, 'missing "documentation/" directory');
    return;
  }

  const guides = [];
  for (const entry of guideEntries) {
    const path = resolve(guidesDirectory, entry.name);
    if (!entry.isFile() || extname(entry.name).toLowerCase() !== ".md") {
      addError(
        errors,
        root,
        path,
        1,
        'non-Markdown entry in "documentation/"; guides are Markdown files only',
      );
      continue;
    }
    guides.push(path);
  }
  if (guides.length === 0) {
    addError(
      errors,
      root,
      guidesDirectory,
      1,
      '"documentation/" contains no guides',
    );
  }

  for (const path of guides) {
    let source = markdownCache.get(path);
    if (!source) {
      source = await readFile(path, "utf8");
      markdownCache.set(path, source);
    }
    if (lineCount(source) >= guideLineLimit) {
      addError(
        errors,
        root,
        path,
        1,
        `guide has ${lineCount(source)} lines; expected fewer than ${guideLineLimit}`,
      );
    }
    const headings = headingsFor(source);
    const duplicate = headings.find((heading) =>
      headings.some(
        (candidate) =>
          candidate.line < heading.line &&
          candidate.baseSlug === heading.baseSlug,
      ),
    );
    if (duplicate) {
      addError(
        errors,
        root,
        path,
        duplicate.line,
        `duplicate guide heading anchor "#${duplicate.baseSlug}"`,
      );
    }
  }
}

const { root, checkStructure: shouldCheckStructure } = parseArguments(
  process.argv.slice(2),
);
const paths = await walkFiles(root);
const markdownPaths = paths.filter(
  (path) => extname(path).toLowerCase() === ".md",
);
const markdownCache = new Map();
const errors = [];

await checkLinks(root, markdownPaths, markdownCache, errors);
await checkStaleReferences(root, paths, errors);
if (shouldCheckStructure) {
  await checkStructure(root, markdownCache, errors);
}

errors.sort(
  (left, right) =>
    left.path.localeCompare(right.path) ||
    left.line - right.line ||
    left.message.localeCompare(right.message),
);

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`${error.path}:${error.line}: ${error.message}`);
  }
  process.exitCode = 1;
} else {
  console.log(
    `documentation check passed (${markdownPaths.length} Markdown files${
      shouldCheckStructure ? ", structure verified" : ""
    })`,
  );
}
