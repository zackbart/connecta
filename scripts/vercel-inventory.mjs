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

function categories(markdown) {
  const section = markdown.match(/^## Tools by category[ \t]*\r?\n([\s\S]*?)(?=^## |^---[ \t]*$|(?![\s\S]))/m)?.[1];
  if (!section) throw new Error("missing Tools by category section; a landing-page table is incomplete");
  const links = [...section.matchAll(/\[([^\]]+)\]\(([^\s)]+)\)/g)];
  if (links.length === 0) throw new Error("Tools by category contains no category links");
  const pages = new Map();
  for (const [, label, target] of links) {
    const url = new URL(target, landingUrl);
    const path = url.pathname.replace(/\.md$/, "").replace(/\/$/, "");
    if (
      url.origin !== landingUrl.origin ||
      url.username ||
      url.password ||
      !path.startsWith(categoryRoot) ||
      !/^[a-z0-9-]+$/.test(path.slice(categoryRoot.length))
    )
      throw new Error(`invalid category reference ${target}; expected a Vercel MCP category on ${landingUrl.origin}`);
    const count = label.match(/\b(\d+) tools?\s*$/)?.[1];
    if (count === undefined || Number(count) < 1) throw new Error(`category ${target} has no published tool count`);
    url.pathname = path + ".md";
    url.search = "";
    url.hash = "";
    if (pages.has(url.href) && pages.get(url.href) !== Number(count))
      throw new Error(`category ${url.href} has conflicting published tool counts`);
    pages.set(url.href, Number(count));
    if (pages.size + 1 > maxPages) throw new Error(`reference exceeds ${maxPages} pages including the landing page`);
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
