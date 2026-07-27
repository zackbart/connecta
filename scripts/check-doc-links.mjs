import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ignoredDirectories = new Set([
  ".git",
  ".wrangler",
  "coverage",
  "dist",
  "node_modules",
]);
// Historical release notes quote the section-number syntax that existed when
// those releases shipped. They are records, not live documentation pointers.
const staleReferenceAllowlist = new Set(["CHANGELOG.md"]);
const staleReferenceDirectoryPrefixes = ["src/", "docs/", "examples/"];

const legacySections = [
  {
    heading: "1. What connecta is & why",
    anchor: "1-what-connecta-is--why",
    href: "./architecture.md#what-connecta-is--why",
  },
  {
    heading: "2. Architecture",
    anchor: "2-architecture",
    href: "./architecture.md#architecture",
  },
  {
    heading: "3. Meta-tools reference",
    anchor: "3-meta-tools-reference",
    href: "./meta-tools.md#meta-tools-reference",
  },
  {
    heading: "4. Connectors",
    anchor: "4-connectors",
    href: "./connectors.md#connectors",
  },
  {
    heading: "5. Inbound auth",
    anchor: "5-inbound-auth",
    href: "./auth.md#inbound-auth",
  },
  {
    heading: "6. Downstream OAuth",
    anchor: "6-downstream-oauth",
    href: "./connectors.md#downstream-oauth",
  },
  {
    heading: "7. Storage",
    anchor: "7-storage",
    href: "./storage-and-credentials.md#storage",
  },
  {
    heading: "8. Running it",
    anchor: "8-running-it",
    href: "./operations.md#running-it",
  },
  {
    heading: "9. Setting up Clerk (walkthrough)",
    anchor: "9-setting-up-clerk-walkthrough",
    href: "./auth.md#setting-up-clerk-walkthrough",
  },
  {
    heading: "10. Deployment architecture",
    anchor: "10-deployment-architecture",
    href: "./operations.md#deployment-architecture",
  },
  {
    heading: "11. Testing & development",
    anchor: "11-testing--development",
    href: "./operations.md#testing--development",
  },
  {
    heading: "12. Troubleshooting",
    anchor: "12-troubleshooting",
    href: "./operations.md#troubleshooting",
  },
  {
    heading: "13. Code mode (`execute_code`)",
    anchor: "13-code-mode-execute_code",
    href: "./code-mode.md#code-mode-execute_code",
  },
  {
    heading: "14. Status UI",
    anchor: "14-status-ui",
    href: "./operator-ui.md#status-ui",
  },
  {
    heading: "15. Activity history",
    anchor: "15-activity-history",
    href: "./operator-ui.md#activity-history",
  },
  {
    heading: "16. Toolkits (scoped views)",
    anchor: "16-toolkits-scoped-views",
    href: "./toolkits.md#toolkits-scoped-views",
  },
  {
    heading: "17. Credential health (proactive liveness checks)",
    anchor: "17-credential-health-proactive-liveness-checks",
    href:
      "./storage-and-credentials.md#credential-health-proactive-liveness-checks",
  },
];

const canonicalDocuments = [
  "docs/architecture.md",
  "docs/meta-tools.md",
  "docs/connectors.md",
  "docs/auth.md",
  "docs/storage-and-credentials.md",
  "docs/operations.md",
  "docs/code-mode.md",
  "docs/operator-ui.md",
  "docs/toolkits.md",
];

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

function activeLines(source) {
  const lines = source.split(/\r?\n/);
  const active = [];
  let fence;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
    if (marker) {
      if (!fence) {
        fence = { character: marker[1][0], length: marker[1].length };
      } else if (
        marker[1][0] === fence.character &&
        marker[1].length >= fence.length &&
        marker[2].trim() === ""
      ) {
        fence = undefined;
      }
      continue;
    }
    if (!fence) active.push({ number: index + 1, text: line });
  }
  return active;
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

function markdownTargets(line) {
  const targets = [];
  const definition = line.match(
    /^\s{0,3}\[[^\]]+\]:\s*(?:<([^>]+)>|(\S+))/,
  );
  if (definition) {
    targets.push(definition[1] ?? definition[2]);
  }

  let cursor = 0;
  while (cursor < line.length) {
    const open = line.indexOf("](", cursor);
    if (open < 0) break;
    let index = open + 2;
    while (/\s/.test(line[index] ?? "")) index += 1;
    if (line[index] === "<") {
      const close = line.indexOf(">", index + 1);
      if (close >= 0) {
        targets.push(line.slice(index + 1, close));
        cursor = close + 1;
        continue;
      }
    }

    const start = index;
    let depth = 0;
    let escaped = false;
    while (index < line.length) {
      const character = line[index];
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === "(") {
        depth += 1;
      } else if (character === ")") {
        if (depth === 0) break;
        depth -= 1;
      } else if (/\s/.test(character) && depth === 0) {
        break;
      }
      index += 1;
    }
    if (index > start) targets.push(line.slice(start, index));
    cursor = Math.max(index + 1, open + 2);
  }
  return targets;
}

function decodeTargetPart(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function resolveLocalTarget(root, sourcePath, rawTarget) {
  const target = rawTarget.replace(/\\([\\()])/g, "$1");
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
    if (url.hostname !== "github.com") return { external: true };
    const match = url.pathname.match(
      /^\/zackbart\/connecta\/(?:blob|tree)\/main\/(.+)$/,
    );
    if (!match) return { external: true };
    const decodedPath = decodeTargetPart(match[1]);
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
    let source = markdownCache.get(path);
    if (!source) {
      source = await readFile(path, "utf8");
      markdownCache.set(path, source);
    }
    for (const { number, text } of activeLines(source)) {
      for (const target of markdownTargets(text)) {
        const message = await localTargetError(
          root,
          path,
          target,
          markdownCache,
        );
        if (message) addError(errors, root, path, number, message);
      }
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
  const landingPath = resolve(root, "docs/documentation.md");
  let landing;
  try {
    landing = await readFile(landingPath, "utf8");
    markdownCache.set(landingPath, landing);
  } catch {
    addError(
      errors,
      root,
      landingPath,
      1,
      "missing compatibility index",
    );
    return;
  }

  if (lineCount(landing) >= 200) {
    addError(
      errors,
      root,
      landingPath,
      1,
      `compatibility index has ${lineCount(landing)} lines; expected fewer than 200`,
    );
  }

  const landingHeadings = headingsFor(landing);
  const levelTwoHeadings = landingHeadings.filter(
    (heading) => heading.level === 2,
  );
  if (levelTwoHeadings.length !== legacySections.length) {
    addError(
      errors,
      root,
      landingPath,
      1,
      `compatibility index has ${levelTwoHeadings.length} level-two headings; expected ${legacySections.length}`,
    );
  }

  const active = activeLines(landing);
  for (const section of legacySections) {
    const matches = levelTwoHeadings.filter(
      (heading) => heading.text === section.heading,
    );
    if (matches.length !== 1) {
      addError(
        errors,
        root,
        landingPath,
        matches[0]?.line ?? 1,
        `legacy heading "${section.heading}" appears ${matches.length} times; expected once`,
      );
      continue;
    }
    if (matches[0].slug !== section.anchor) {
      addError(
        errors,
        root,
        landingPath,
        matches[0].line,
        `legacy heading "${section.heading}" generates "#${matches[0].slug}", expected "#${section.anchor}"`,
      );
    }
    const nextHeading = levelTwoHeadings.find(
      (heading) => heading.line > matches[0].line,
    );
    const targets = active
      .filter(
        ({ number }) =>
          number > matches[0].line &&
          (!nextHeading || number < nextHeading.line),
      )
      .flatMap(({ text }) => markdownTargets(text));
    if (!targets.includes(section.href)) {
      addError(
        errors,
        root,
        landingPath,
        matches[0].line,
        `legacy heading "${section.heading}" must point to "${section.href}"`,
      );
    }
  }

  for (const document of canonicalDocuments) {
    const path = resolve(root, document);
    let source;
    try {
      source = await readFile(path, "utf8");
      markdownCache.set(path, source);
    } catch {
      addError(errors, root, path, 1, "missing canonical document");
      continue;
    }
    if (lineCount(source) >= 700) {
      addError(
        errors,
        root,
        path,
        1,
        `canonical document has ${lineCount(source)} lines; expected fewer than 700`,
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
        `duplicate canonical heading anchor "#${duplicate.baseSlug}"`,
      );
    }
    for (const section of legacySections) {
      const legacy = headings.find(
        (heading) =>
          heading.level === 2 && heading.text === section.heading,
      );
      if (legacy) {
        addError(
          errors,
          root,
          path,
          legacy.line,
          `canonical document retained numbered legacy heading "${section.heading}"`,
        );
      }
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
      shouldCheckStructure ? `, ${legacySections.length} legacy anchors` : ""
    })`,
  );
}
