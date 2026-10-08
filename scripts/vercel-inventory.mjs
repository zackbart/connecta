// Public documentation evidence only. Nothing here changes runtime classification.
import { open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Parser, HtmlRenderer } from "commonmark";

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

// Parse Markdown context once. Code examples never become links or headings.
// Tool names in real headings retain their visible code-span label, while code
// spans in prose are discarded before category discovery.
function evidence(markdown) {
  const document = new Parser().parse(markdown);
  const lines = markdown.split("\n");
  const walker = document.walker();
  const discard = [];
  const headings = [];
  const linkedTools = [];
  let event;
  while ((event = walker.next())) {
    if (!event.entering) continue;
    const node = event.node;
    if (
      node.type === "link" &&
      node.firstChild?.type === "code" &&
      node.firstChild.next === null &&
      toolName.test(node.firstChild.literal)
    ) {
      linkedTools.push(node.firstChild.literal);
    }
    if (node.type === "code_block") {
      for (let i = node.sourcepos[0][0] - 1; i < node.sourcepos[1][0]; i++) lines[i] = "";
      discard.push(node);
    } else if (node.type === "code") {
      discard.push(node);
    } else if ((node.type === "html_block" || node.type === "html_inline") && node.literal.startsWith("<!--")) {
      if (node.sourcepos) for (let i = node.sourcepos[0][0] - 1; i < node.sourcepos[1][0]; i++) lines[i] = "";
      discard.push(node);
    } else if (node.type === "heading") {
      // Only the vendor's standalone H2 code label is a tool declaration.
      // Other tool-like headings require review rather than a partial union.
      const child = node.firstChild;
      if (node.level === 2 && child?.type === "code" && child.next === null) headings.push(child.literal);
      else {
        const label = new HtmlRenderer().render(node);
        const text = plainText(label);
        if (
          (toolName.test(text) && (text.includes("_") || /^[a-z]/.test(text) || text === text.toUpperCase())) ||
          /<(?:code|strong|h[1-6][^>]*>\s*<code)\b/i.test(label)
        )
          throw new Error("unconsumed tool-heading-like content; review the category reference/parser");
      }
    } else if ((node.type === "html_block" || node.type === "html_inline") && /<h[1-6]\b/i.test(node.literal)) {
      throw new Error("unconsumed tool-heading-like content; review the category reference/parser");
    }
  }
  for (const node of discard) node.unlink();
  const definitions = [
    ...lines.join("\n").matchAll(/^[ \t]{0,3}\[([^\]\n]+)\]:[ \t]*(?:<([^<>\s]+)>|(\S+))[^\n]*$/gm),
  ].filter((match) => {
    // A raw definition-like line inside a multiline code span is not a
    // definition. Ask CommonMark to resolve a probe instead of guessing.
    const probe = new Parser().parse(`${markdown}\n\n[connecta-reference-probe][${match[1]}]`).lastChild?.firstChild;
    return probe?.type === "link" && probe.firstChild?.literal === "connecta-reference-probe";
  });
  return { html: new HtmlRenderer().render(document), definitions, headings, linkedTools };
}

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

function categories({ html, definitions }) {
  // Discovery is independent of count spelling and includes unused definitions.
  // Resolve relative URLs before deciding whether they name a category.
  const destinations = new Set();
  const discovery = html + "\n" + definitions.map((match) => match[2] ?? match[3]).join("\n");
  for (const [target] of discovery.matchAll(/https?:\/\/[^\s<>"'()[\]`]+|(?:\/|\.\.?\/)[^\s<>"'()[\]`]+/g)) {
    if (new URL(target, landingUrl).pathname.startsWith(categoryRoot)) destinations.add(categoryUrl(target, true));
  }
  if (destinations.size === 0) throw new Error("no category destinations; a landing-page table is incomplete");
  if (destinations.size + 1 > maxPages)
    throw new Error(`reference exceeds ${maxPages} pages including the landing page`);

  const references = new Map();
  for (const [, label, angleTarget, target] of definitions) {
    const id = label.trim().replace(/\s+/g, " ").toLowerCase();
    const targets = references.get(id) ?? new Set();
    targets.add(angleTarget ?? target);
    references.set(id, targets);
  }
  const pages = new Map();
  for (const [, attributes, label] of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    const target = attributes.match(/(?:^|\s)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i);
    const href = target?.[1] ?? target?.[2] ?? target?.[3];
    const counts = [...plainText(label).matchAll(/\b(\d+)\s+tools?\b/gi)];
    if (!href) continue;
    if (!new URL(href, landingUrl).pathname.startsWith(categoryRoot)) {
      if (counts.length) categoryUrl(href);
      continue;
    }
    const url = categoryUrl(href, counts.length === 0);
    // Individual tool links identify categories but are not count evidence.
    const path = new URL(href, landingUrl).pathname.replace(/\.md$/, "").replace(/\/$/, "");
    if (path.slice(categoryRoot.length).includes("/")) continue;
    for (const [id, targets] of references) {
      if (targets.size > 1 && targets.has(href)) throw new Error(`conflicting category reference definition ${id}`);
    }
    if (counts.length !== 1 || Number(counts[0][1]) < 1)
      throw new Error(
        `category ${href} must have exactly one published tool count; count must be inside its own category link`,
      );
    const count = Number(counts[0][1]);
    if (pages.has(url) && pages.get(url) !== count)
      throw new Error(`category ${url} has conflicting published tool counts`);
    pages.set(url, count);
  }
  for (const url of destinations) {
    if (!pages.has(url))
      throw new Error(
        `unconsumed category destination ${url}; missing published tool count evidence; a landing-page table is incomplete; review the category index/parser`,
      );
  }
  return pages;
}

/** Every published category must parse completely before any names are compared. */
export async function readVercelInventory(source, knownCategories = {}) {
  const signal = AbortSignal.timeout(60_000);
  let page = source;
  try {
    const landing = await readPage(source, signal);
    const index = evidence(landing);
    const pages = categories(index);
    for (const category of Object.keys(knownCategories)) {
      if (!pages.has(categoryUrl(`./tools/${category}`)))
        throw new Error(
          `previously known category ${category} disappeared from the index; needs review, not tool removals`,
        );
    }
    const names = new Set();
    const remote = /^https?:\/\//.test(source);
    for (const [url, count] of pages) {
      signal.throwIfAborted();
      // Local overrides mirror the category .md files beside the landing fixture.
      page = remote ? url : resolve(dirname(source), new URL(url).pathname.split("/").at(-1));
      const markdown = await readPage(page, signal);
      const { headings } = evidence(markdown);
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
    for (const name of index.linkedTools) {
      if (!names.has(name)) throw new Error(`landing-page tool ${name} is absent from category references`);
    }
    return { names: [...names].sort(), pages: pages.size + 1 };
  } catch (error) {
    throw new Error(
      `Vercel inventory unavailable/incomplete at ${page}: ${error.message}. Retry the public references; do not infer added/removed tools from partial pages.`,
    );
  }
}
