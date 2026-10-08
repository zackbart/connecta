// Node-only: exercises the filesystem and fetch bounds of the public maintainer inventory checker.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import recording from "./inventory-fixtures/recording.json";
const inventoryModule = new URL("../../../scripts/vercel-inventory.mjs", import.meta.url).href;
const { readVercelInventory } = (await import(inventoryModule)) as {
  readVercelInventory(source: string): Promise<{ names: string[]; pages: number }>;
};

const root = fileURLToPath(new URL("../../../", import.meta.url));
const fixtures = fileURLToPath(new URL("./inventory-fixtures/", import.meta.url));
const url = "https://vercel.com/docs/agent-resources/vercel-mcp/tools.md";
const temporary: string[] = [];
const text = (name: string) => readFile(join(fixtures, name), "utf8");
const cachingLink = "[Caching\n6 tools](/docs/agent-resources/vercel-mcp/tools/caching)";
const teamsLink = "[Teams and Users\n8 tools](/docs/agent-resources/vercel-mcp/tools/teams)";

// Only negative/format-variation tests mutate these recorded response bodies.
async function mixedIndex() {
  return (
    (await text("tools.md"))
      .replace(cachingLink, "[Caching\n6 tools][CACHE]")
      .replace(
        teamsLink,
        '<a href="/docs/agent-resources/vercel-mcp/tools/teams"><span>Teams and Users</span><br>8 tools</a>',
      ) + '\n[cache]: </docs/agent-resources/vercel-mcp/tools/caching> "Caching"\n'
  );
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function mockPages(deployment = "deployments.md") {
  const pages = new Map(
    await Promise.all(recording.pages.map(async (page) => [page.url, await text(page.file)] as const)),
  );
  pages.set(url.replace("tools.md", "tools/deployments.md"), await text(deployment));
  const fetcher = vi.fn(
    async (source: URL) => new Response(pages.get(String(source)), { status: pages.has(String(source)) ? 200 : 404 }),
  );
  vi.stubGlobal("fetch", fetcher);
  return { pages, fetcher };
}

async function localReferences() {
  const directory = await mkdtemp(join(tmpdir(), "connecta-vercel-inventory-"));
  temporary.push(directory);
  await Promise.all(recording.pages.map(async (page) => writeFile(join(directory, page.file), await text(page.file))));
  const setup = join(directory, "setup.md");
  await writeFile(setup, "https://mcp.vercel.com OAuth");
  const args = [
    join(root, "scripts/drift-check.mjs"),
    "--docs",
    "--provider",
    "vercel",
    "--tool-reference",
    `vercel=${join(directory, "tools.md")}`,
    "--setup-reference",
    `vercel=${setup}`,
    "--json",
    "--record",
  ];
  const report = () => JSON.parse(execFileSync(process.execPath, args, { encoding: "utf8" }));
  return { directory, args, report };
}

describe("Vercel public inventory", () => {
  it("INV-8 reads the complete recorded 213-tool union across 29 pages offline", async () => {
    expect(recording.retrievedAt).toMatch(/^2026-10-08T/);
    expect(recording.pages).toHaveLength(29);
    expect(recording.expectedNames).toHaveLength(213);
    for (const page of recording.pages) {
      expect(page.url).toBe(page.file === "tools.md" ? url : url.replace("tools.md", `tools/${page.file}`));
      expect(
        createHash("sha256")
          .update(await text(page.file))
          .digest("hex"),
      ).toBe(page.sha256);
    }
    expect(await readVercelInventory(join(fixtures, "tools.md"))).toEqual({
      names: recording.expectedNames,
      pages: 29,
    });
    const { fetcher } = await mockPages();
    expect(await readVercelInventory(url)).toEqual({ names: recording.expectedNames, pages: 29 });
    expect(fetcher).toHaveBeenCalledTimes(29);
    for (const [source, init] of fetcher.mock.calls as unknown as [URL, RequestInit][]) {
      expect(source.origin).toBe("https://vercel.com");
      expect(source.pathname.endsWith(".md")).toBe(true);
      expect(init).toMatchObject({ redirect: "error", credentials: "omit", signal: expect.any(AbortSignal) });
      expect(init.headers).not.toHaveProperty("Authorization");
    }
    expect(recording.expectedNames).not.toContain("projectId");
  });

  it("INV-8 consumes mixed inline/reference/HTML links and fetches repeated categories once", async () => {
    const { pages, fetcher } = await mockPages();
    pages.set(
      url,
      (await mixedIndex()).replace(
        "\n\n---",
        '\n[Deployments repeated\n12 tools](https://vercel.com/docs/agent-resources/vercel-mcp/tools/deployments.md#tools "Repeat")\n\n---',
      ),
    );
    expect(await readVercelInventory(url)).toEqual({ names: recording.expectedNames, pages: 29 });
    expect(fetcher).toHaveBeenCalledTimes(29);
  });

  it.each(["collapsed", "shortcut"])("INV-8 consumes %s category references", async (form) => {
    const { pages } = await mockPages();
    const label = "Caching\n6 tools";
    pages.set(
      url,
      (await text("tools.md")).replace(cachingLink, `[${label}]${form === "collapsed" ? "[]" : ""}\n`) +
        "\n[Caching 6 tools]: /docs/agent-resources/vercel-mcp/tools/caching\n",
    );
    expect(await readVercelInventory(url)).toEqual({ names: recording.expectedNames, pages: 29 });
  });

  it.each(["reference", "HTML"])("INV-5 confines %s category destinations to Vercel", async (form) => {
    const target = "https://evil.example/docs/agent-resources/vercel-mcp/tools/caching";
    const landing =
      (await text("tools.md")).replace(
        cachingLink,
        form === "reference" ? "[Caching\n6 tools][cache]" : `<a href="${target}">Caching\n6 tools</a>`,
      ) + `\n[cache]: ${target}\n`;
    const fetcher = vi.fn(async () => new Response(landing));
    vi.stubGlobal("fetch", fetcher);
    await expect(readVercelInventory(url)).rejects.toThrow("invalid category reference");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(["Caching", "Caching 6 tools and 6 tools"])(
    "INV-8 refuses ambiguous category counts in %s",
    async (label) => {
      const { pages } = await mockPages();
      pages.set(
        url,
        (await text("tools.md")).replace(cachingLink, `[${label}](/docs/agent-resources/vercel-mcp/tools/caching)`),
      );
      await expect(readVercelInventory(url)).rejects.toThrow("must have exactly one published tool count");
    },
  );

  it.each(["incomplete.md", "unparseable.md"])(
    "INV-8 refuses %s instead of comparing a partial catalog",
    async (page) => {
      await mockPages(page);
      await expect(readVercelInventory(url)).rejects.toThrow(/unavailable\/incomplete.*deployments\.md.*expected 12/);
    },
  );

  it("INV-8 reports the unreachable category URL and retry guidance", async () => {
    const { pages } = await mockPages();
    const failure = JSON.parse(await text("unavailable.json"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (source: URL) =>
        String(source).endsWith("teams.md")
          ? new Response(failure.body, { status: failure.status })
          : new Response(pages.get(String(source))),
      ),
    );
    await expect(readVercelInventory(url)).rejects.toThrow(/teams\.md: HTTP 503.*Retry the public references/);
  });

  it("INV-8 never accepts the frequently-used table without category references", async () => {
    const landing = (await text("tools.md")).split("## Tools by category")[0];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(landing)),
    );
    await expect(readVercelInventory(url)).rejects.toThrow("a landing-page table is incomplete");
  });

  it.each([
    "https://evil.example/docs/agent-resources/vercel-mcp/tools/deployments",
    "https://vercel.com.evil.example/docs/agent-resources/vercel-mcp/tools/deployments",
    "https://user:password@vercel.com/docs/agent-resources/vercel-mcp/tools/deployments",
    "/docs/agent-resources/vercel-mcp/tools/deployments/list_deployments",
    "/docs/agent-resources/vercel-mcp/tools/../../other",
  ])("INV-5 refuses unsafe category link %s before following it", async (target) => {
    const landing = (await text("tools.md")).replace(
      "](/docs/agent-resources/vercel-mcp/tools/deployments)",
      `](${target})`,
    );
    const fetcher = vi.fn(async () => new Response(landing));
    vi.stubGlobal("fetch", fetcher);
    await expect(readVercelInventory(url)).rejects.toThrow("invalid category reference");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("INV-8 refuses conflicting counts, duplicate headings and missing table tools", async () => {
    const { pages } = await mockPages();
    pages.set(
      url,
      (await text("tools.md")).replace(
        "\n\n---",
        "\n[Deployments repeated\n13 tools](/docs/agent-resources/vercel-mcp/tools/deployments)\n\n---",
      ),
    );
    await expect(readVercelInventory(url)).rejects.toThrow("conflicting published tool counts");
    pages.set(url, await text("tools.md"));
    const deploymentUrl = url.replace("tools.md", "tools/deployments.md");
    pages.set(deploymentUrl, (await text("deployments.md")).replace("## `get_deployment`", "## `list_deployments`"));
    await expect(readVercelInventory(url)).rejects.toThrow("expected 12 unique tool headings");
    pages.set(deploymentUrl, await text("deployments.md"));
    pages.set(url, (await text("tools.md")).replace("[`list_deployments`]", "[`missing_tool`]"));
    await expect(readVercelInventory(url)).rejects.toThrow("landing-page tool missing_tool is absent");
  });

  it("INV-8 bounds page count and streamed page bytes", async () => {
    const landing =
      "## Tools by category\n" +
      Array.from(
        { length: 32 },
        (_, i) => `[Category ${i}\n1 tool](/docs/agent-resources/vercel-mcp/tools/category-${i})`,
      ).join("\n");
    const fetcher = vi.fn(async () => new Response(landing));
    vi.stubGlobal("fetch", fetcher);
    await expect(readVercelInventory(url)).rejects.toThrow("exceeds 32 pages");
    expect(fetcher).toHaveBeenCalledTimes(1);
    const { pages } = await mockPages();
    pages.set(url.replace("tools.md", "tools/teams.md"), "x".repeat(512 * 1024 + 1));
    await expect(readVercelInventory(url)).rejects.toThrow("page exceeds 524288 bytes");
  });

  it.each(["unknown syntax", "split HTML count", "unresolved reference", "conflicting definition"])(
    "INV-8 reports %s on a mixed-format index without comparing additions/removals",
    async (failure) => {
      const { directory, report, args } = await localReferences();
      let landing = await mixedIndex();
      if (failure === "unknown syntax")
        landing = landing.replace(
          "[Caching\n6 tools][CACHE]",
          '<category href="/docs/agent-resources/vercel-mcp/tools/caching">Caching\n6 tools</category>',
        );
      if (failure === "split HTML count")
        landing = landing.replace(
          "[Caching\n6 tools][CACHE]",
          "<category>Caching <span>6</span><span>tools</span></category>",
        );
      if (failure === "unresolved reference") landing = landing.replace("[CACHE]", "[MISSING]");
      if (failure === "conflicting definition")
        landing += "\n[CACHE]: /docs/agent-resources/vercel-mcp/tools/projects\n";
      await writeFile(join(directory, "tools.md"), landing);
      const result = report().docs[0];
      expect(result.findings).toEqual([
        expect.objectContaining({ kind: "unavailable", detail: expect.stringContaining("unavailable/incomplete") }),
      ]);
      expect(result.added).toBeUndefined();
      expect(result.removed).toBeUndefined();
      expect(result.documentedTools).toBeUndefined();
      expect(spawnSync(process.execPath, [...args, "--strict"]).status).toBe(1);
      await expect(readVercelInventory(join(directory, "tools.md"))).rejects.toThrow(
        failure === "unknown syntax" || failure === "split HTML count"
          ? "unconsumed published category tool count"
          : failure === "unresolved reference"
            ? "unresolved category reference"
            : "conflicting category reference definition",
      );
    },
  );

  it.each([
    ["thematic break", (landing: string) => landing.replace("[Toolbar\n6 tools]", "\n\n---\n\n[Toolbar\n6 tools]")],
    [
      "emphasized autolink count",
      (landing: string) =>
        landing.replace(cachingLink, `Caching <${url.replace("tools.md", "tools/caching")}>\n**6** tools`),
    ],
    [
      "entity autolink count",
      (landing: string) =>
        landing.replace(cachingLink, `Caching <${url.replace("tools.md", "tools/caching")}>\n&#54; tools`),
    ],
    ["unused conflicting definitions", (landing: string) => landing + "\n[help]: /docs/help\n[HELP]: /docs/support\n"],
  ] as const)("INV-8 reconciles the round-2 %s reproduction before CLI drift comparison", async (_, mutate) => {
    const { directory, report } = await localReferences();
    await writeFile(join(directory, "tools.md"), mutate(await text("tools.md")));
    const result = report().docs[0];
    if (result.findings.some((finding: { kind: string }) => finding.kind === "unavailable")) {
      expect(result.findings).toEqual([
        expect.objectContaining({ kind: "unavailable", detail: expect.stringContaining("unavailable/incomplete") }),
      ]);
      expect(result.added).toBeUndefined();
      expect(result.removed).toBeUndefined();
      expect(result.documentedTools).toBeUndefined();
    } else {
      expect(await readVercelInventory(join(directory, "tools.md"))).toEqual({
        names: recording.expectedNames,
        pages: 29,
      });
      expect(result).toMatchObject({ documentedTools: 213, inventoryPages: 29, findings: [] });
      expect(result.added).toHaveLength(178);
      expect(result.added).toContain("artifact_query");
      expect(result.removed).toEqual([
        "check_domain_availability_and_price",
        "deploy_to_vercel",
        "get_deployment_build_logs",
        "get_web_analytics",
      ]);
    }
  });

  it("INV-8 ignores unrelated unused conflicts while retaining categories in unused definitions", async () => {
    const { pages, fetcher } = await mockPages();
    const landing = await text("tools.md");
    pages.set(url, landing + "\n[help]: /docs/help\n[HELP]: /docs/support\n");
    expect(await readVercelInventory(url)).toEqual({ names: recording.expectedNames, pages: 29 });
    pages.set(url, landing + "\n[unused]: /docs/agent-resources/vercel-mcp/tools/new-category\n");
    fetcher.mockClear();
    await expect(readVercelInventory(url)).rejects.toThrow("unconsumed category destination");
    expect(fetcher).toHaveBeenCalledTimes(1);
    pages.set(url, landing.replace(cachingLink, "") + "\n[unused]: /docs/agent-resources/vercel-mcp/tools/caching\n");
    await expect(readVercelInventory(url)).rejects.toThrow("unconsumed category destination");
  });

  it("INV-8 rejects tool-heading-like content even when the recognized heading count still matches", async () => {
    const { pages } = await mockPages();
    const category = url.replace("tools.md", "tools/caching.md");
    for (const heading of [
      "### `new_tool`",
      "## **new_tool**",
      "## <code>new_tool</code>",
      "## `new_tool` extra text",
      "## new_tool",
      "## newTool",
      "<h2>new_tool</h2>",
    ]) {
      pages.set(category, (await text("caching.md")) + `\n${heading}\n`);
      await expect(readVercelInventory(url)).rejects.toThrow("unconsumed tool-heading-like content");
    }
  });

  it("INV-8 formatting mutation combinations yield the exact recorded union or explicit unavailable, never a partial inventory", async () => {
    const { pages } = await mockPages();
    const landing = await text("tools.md");
    const entry = /\[([^\]]+)\]\((\/docs\/agent-resources\/vercel-mcp\/tools\/[a-z0-9-]+)\)/g;
    const entries = [...landing.matchAll(entry)];
    expect(entries).toHaveLength(28);
    // Exhaust the power set of six independent harmless formatting mutations.
    // Every combination also retains all original category paths and counts.
    for (let mask = 0; mask < 64; mask++) {
      let definitions = "";
      let transformed = entries.map(([original, originalLabel, path], i) => {
        if (originalLabel === undefined || path === undefined) throw new Error("missing category entry captures");
        const label = mask & 2 ? originalLabel.replace(/(\d+) tools?/, "**$1** tools") : originalLabel;
        let value = original.replace(originalLabel, label);
        if (mask & 4 && i % 3 === 0) value = `${label} <https://vercel.com${path}>`;
        if (mask & 8 && i % 3 === 1) {
          value = `[${label}][category-${i}]`;
          definitions += `\n[category-${i}]: ${path}\n`;
        }
        if (mask & 16 && i % 3 === 2) value = `<a href="${path}">${label.replace("\n", "<br>")}</a>`;
        return value;
      });
      if (mask & 32) transformed = transformed.reverse();
      const mutated =
        landing.replace(
          entries.map(([original]) => original).join(""),
          transformed.join(mask & 1 ? "\n\n---\n\n" : "\n"),
        ) + definitions;
      expect(mutated).not.toBe(landing);
      pages.set(url, mutated);
      try {
        const inventory = await readVercelInventory(url);
        expect(inventory, `mutation mask ${mask}`).toEqual({ names: recording.expectedNames, pages: 29 });
      } catch (error) {
        // Rethrow assertion errors: a partial success must fail this test.
        if (!(error instanceof Error) || !error.message.includes("Vercel inventory unavailable/incomplete"))
          throw error;
        expect(error.message, `mutation mask ${mask}`).toMatch(/unconsumed.*(?:count|destination)/);
      }
    }
  });

  it("INV-10 reports advisory additions/removals and never records classifications", async () => {
    const { directory, args, report } = await localReferences();
    const evidence = join(root, "src/providers/vercel/drift.json");
    const before = await readFile(evidence, "utf8");
    const result = report();
    expect(result.docs[0]).toMatchObject({ documentedTools: 213, inventoryPages: 29, findings: [] });
    expect(result.docs[0].added).toHaveLength(178);
    expect(result.docs[0].added).toContain("artifact_query");
    expect(result.docs[0].removed).toEqual([
      "check_domain_availability_and_price",
      "deploy_to_vercel",
      "get_deployment_build_logs",
      "get_web_analytics",
    ]);
    expect(result.findings).toBe(182);
    expect(spawnSync(process.execPath, [...args, "--strict"]).status).toBe(1);
    await rm(join(directory, "teams.md"));
    const incomplete = report();
    expect(incomplete.docs[0].findings).toEqual([expect.objectContaining({ kind: "unavailable" })]);
    expect(incomplete.docs[0].added).toBeUndefined();
    expect(incomplete.docs[0].removed).toBeUndefined();
    expect(await readFile(evidence, "utf8")).toBe(before);
    await writeFile(join(directory, "tools.md"), "x".repeat(512 * 1024 + 1));
    await expect(readVercelInventory(join(directory, "tools.md"))).rejects.toThrow("page exceeds 524288 bytes");
  });
});
