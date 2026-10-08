// Public documentation evidence only. Nothing here changes runtime classification.
import { open } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const landingUrl = new URL("https://vercel.com/docs/agent-resources/vercel-mcp/tools.md");
const categoryRoot = landingUrl.pathname.slice(0, -3) + "/";
const maxPages = 32;
const maxPageBytes = 512 * 1024;
const toolName = /^[A-Za-z](?:[A-Za-z0-9_-]*[A-Za-z0-9])?$/;

async function readPage(source, signal) {
  if (!/^https?:\/\//.test(source)) {
    const file = await open(source, "r");
    try {
      const bytes = Buffer.alloc(maxPageBytes + 1);
      let size = 0;
      while (size < bytes.length) {
        signal.throwIfAborted();
        const { bytesRead } = await file.read(bytes, size, bytes.length - size, size);
        if (bytesRead === 0) break;
        size += bytesRead;
      }
      if (size > maxPageBytes) throw new Error(`page exceeds ${maxPageBytes} bytes`);
      return bytes.subarray(0, size).toString("utf8");
    } finally {
      await file.close();
    }
  }
  const url = new URL(source);
  if (url.origin !== landingUrl.origin || !url.pathname.startsWith("/docs/"))
    throw new Error("reference must stay on https://vercel.com/docs/");
  const response = await fetch(url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    redirect: "error",
    credentials: "omit",
    headers: { "User-Agent": "connecta-drift-check (+https://github.com/zackbart/connecta)" },
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`HTTP ${response.status}`);
  }
  if (!response.body) throw new Error("empty response body");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxPageBytes) throw new Error(`page exceeds ${maxPageBytes} bytes`);
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

// Count evidence and destination discovery deliberately use independent passes.
// Link parsing may reject a new presentation, but cannot hide a category from the
// completeness gate. Scan the entire document, including unused definitions and
// tool-page URLs, rather than trusting a heading/list/divider boundary.
function plainText(text) {
  return text
    .replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (_, value) => {
      const code = value[0].toLowerCase() === "x" ? parseInt(value.slice(1), 16) : Number(value);
      return code <= 0x10ffff ? String.fromCodePoint(code) : " ";
    })
    .replace(/&nbsp;/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/[*_`]/g, "")
    .trim();
}

function categoryUrl(target, allowTool = false) {
  const url = new URL(target, landingUrl);
  const path = url.pathname.replace(/\.md$/, "").replace(/\/$/, "");
  const suffix = path.slice(categoryRoot.length);
  const parts = suffix.split("/");
  if (
    url.origin !== landingUrl.origin ||
    url.username ||
    url.password ||
    !path.startsWith(categoryRoot) ||
    !/^[a-z0-9-]+$/.test(parts[0]) ||
    !(parts.length === 1 || (allowTool && parts.length === 2 && toolName.test(parts[1])))
  )
    throw new Error(`invalid category reference ${target}; expected a Vercel MCP category on ${landingUrl.origin}`);
  url.pathname = categoryRoot + parts[0] + ".md";
  url.search = "";
  url.hash = "";
  return url.href;
}

function categories(markdown) {
  const destinations = new Set();
  const categoryPath = /(?:https?:\/\/[^\s<>"'()[\]`]+)?\/docs\/agent-resources\/vercel-mcp\/tools\/[^\s<>"'()[\]`]*/g;
  for (const [target] of markdown.matchAll(categoryPath)) destinations.add(categoryUrl(target, true));
  if (destinations.size === 0) throw new Error("no category destinations; a landing-page table is incomplete");
  if (destinations.size + 1 > maxPages)
    throw new Error(`reference exceeds ${maxPages} pages including the landing page`);

  const referenceId = (label) => label.trim().replace(/\s+/g, " ").toLowerCase();
  const definition = /^[ \t]{0,3}\[([^\]\n]+)\]:[ \t]*(?:<([^<>\s]+)>|(\S+))[^\n]*$/gm;
  const references = new Map();
  for (const [, label, angleTarget, target] of markdown.matchAll(definition)) {
    const id = referenceId(label);
    const targets = references.get(id) ?? new Set();
    targets.add(angleTarget ?? target);
    references.set(id, targets);
  }
  const content = markdown.replace(definition, "");
  const countPattern = /\b(\d+)\s+tools?\b/gi;
  const link =
    /<a\b([^>]*)>([\s\S]*?)<\/a\s*>|\[([^\]]+)\](?:\(\s*(?:<([^<>\s]+)>|([^\s)]+))(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)|\[([^\]]*)\])?/gi;
  const pages = new Map();
  const consumed = [];
  for (const match of content.matchAll(link)) {
    const [, attributes, htmlLabel, markdownLabel, angleTarget, inlineTarget, reference] = match;
    const label = plainText(htmlLabel ?? markdownLabel);
    const counts = [...label.matchAll(countPattern)];
    const href = attributes?.match(/(?:^|\s)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i);
    let target = htmlLabel !== undefined ? (href?.[1] ?? href?.[2] ?? href?.[3]) : (angleTarget ?? inlineTarget);
    if (htmlLabel === undefined && target === undefined) {
      const targets = references.get(referenceId(reference || markdownLabel));
      // Unused, unrelated conflicting definitions cannot affect the inventory.
      // A used reference with a category destination or count still fails closed.
      if (targets?.size > 1 && (counts.length || [...targets].some((value) => value.includes(categoryRoot))))
        throw new Error(`conflicting category reference definition ${reference || markdownLabel}`);
      target = targets?.values().next().value;
    }
    if (counts.length === 0 && !target?.includes(categoryRoot)) continue;
    // Individual tool links are coverage evidence, not advertised category entries.
    if (counts.length === 0 && target?.includes(categoryRoot)) {
      const suffix = new URL(target, landingUrl).pathname
        .slice(categoryRoot.length)
        .replace(/\.md$/, "")
        .replace(/\/$/, "");
      if (suffix.includes("/")) continue;
    }
    if (target === undefined) throw new Error(`unresolved category reference ${label}`);
    const url = categoryUrl(target);
    if (counts.length !== 1 || Number(counts[0][1]) < 1)
      throw new Error(`category ${target} must have exactly one published tool count`);
    const count = Number(counts[0][1]);
    if (pages.has(url) && pages.get(url) !== count)
      throw new Error(`category ${url} has conflicting published tool counts`);
    pages.set(url, count);
    consumed.push([match.index, match.index + match[0].length]);
  }
  // Erase only entries whose destination and count were reconciled. Unknown
  // syntax leaves either a URL without count evidence or a residual count.
  let residual = content;
  for (const [start, end] of consumed.reverse()) residual = residual.slice(0, start) + residual.slice(end);
  if ([...plainText(residual).matchAll(countPattern)].length)
    throw new Error("unconsumed published category tool count; review the category index/parser");
  for (const url of destinations) {
    if (!pages.has(url))
      throw new Error(
        `unconsumed category destination ${url}; missing published tool count evidence; a landing-page table is incomplete`,
      );
  }
  for (const url of pages.keys()) {
    if (!destinations.has(url)) throw new Error(`category ${url} was not discovered in the raw index`);
  }
  return pages;
}

/** Every published category must parse completely before any names are compared. */
export async function readVercelInventory(source) {
  const signal = AbortSignal.timeout(60_000);
  let page = source;
  try {
    const landing = await readPage(source, signal);
    const pages = categories(landing);
    const names = new Set();
    const remote = /^https?:\/\//.test(source);
    for (const [url, count] of pages) {
      signal.throwIfAborted();
      // Local overrides mirror the category .md files beside the landing fixture.
      page = remote ? url : resolve(dirname(source), new URL(url).pathname.split("/").at(-1));
      const markdown = await readPage(page, signal);
      const headings = [...markdown.matchAll(/^## `([^`]+)`\s*$/gm)].map((match) => match[1]);
      const remaining = markdown.replace(/^## `([^`]+)`\s*$/gm, "");
      const unknownHeadings = [...remaining.matchAll(/^#{1,6}[ \t]+(.+)$/gm)].map((match) => plainText(match[1]));
      if (
        /^#{1,6}[ \t]+(?:`|\*\*|__|<code\b)/im.test(remaining) ||
        /<h[1-6]\b/i.test(remaining) ||
        unknownHeadings.some((heading) => /^[a-z]/.test(heading) && toolName.test(heading))
      )
        throw new Error("unconsumed tool-heading-like content; review the category reference/parser");
      if (
        headings.some((name) => !toolName.test(name)) ||
        new Set(headings).size !== count ||
        headings.length !== count
      )
        throw new Error(
          `expected ${count} unique tool headings, found ${headings.length}; review the category reference/parser`,
        );
      for (const name of headings) names.add(name);
    }
    // Frequently-used table entries are evidence of coverage, never the catalog.
    const frequent = [...landing.matchAll(/^\|\s*\[`([^`]+)`\]\([^\n]+/gm)].map((match) => match[1]);
    for (const name of frequent) {
      if (!names.has(name)) throw new Error(`landing-page tool ${name} is absent from category references`);
    }
    return { names: [...names].sort(), pages: pages.size + 1 };
  } catch (error) {
    throw new Error(
      `Vercel inventory unavailable/incomplete at ${page}: ${error.message}. Retry the public references; do not infer added/removed tools from partial pages.`,
    );
  }
}
