// Node-only: exercises the filesystem and fetch bounds of the public maintainer inventory checker.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  // Replay the October 8 pages against their own reviewed evidence. Live
  // contract refreshes must not change a historical parser reproduction.
  await mkdir(join(directory, "vercel"));
  await writeFile(join(directory, "vercel/drift.json"), await text("drift.json"));
  const setup = join(directory, "setup.md");
  await writeFile(setup, "https://mcp.vercel.com OAuth");
  const args = [
    join(root, "scripts/drift-check.mjs"),
    "--docs",
    "--provider-dir",
    directory,
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

  it.each(["incomplete.md", "unparseable.md"])(
    "INV-8 refuses %s instead of comparing a partial catalog",
    async (page) => {
      await mockPages(page);
      await expect(readVercelInventory(url)).rejects.toThrow(/unavailable\/incomplete.*deployments\.md.*expected 12/);
    },
  );

  it.each([
    "https://evil.example/docs/agent-resources/vercel-mcp/tools/deployments",
    "https://vercel.com.evil.example/docs/agent-resources/vercel-mcp/tools/deployments",
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

  it("INV-8 reports a whole previously known category disappearing as unavailable, never removals", async () => {
    const { directory, report } = await localReferences();
    await writeFile(join(directory, "tools.md"), (await text("tools.md")).replace(cachingLink, ""));
    const result = report().docs[0];
    expect(result.findings).toEqual([
      expect.objectContaining({
        kind: "unavailable",
        detail: expect.stringContaining("previously known category caching disappeared"),
      }),
    ]);
    expect(result.added).toBeUndefined();
    expect(result.removed).toBeUndefined();
    expect(result.documentedTools).toBeUndefined();
  });

  it("INV-10 reports advisory additions/removals and never records classifications", async () => {
    const { directory, args, report } = await localReferences();
    const evidence = join(directory, "vercel/drift.json");
    const before = await readFile(evidence, "utf8");
    const result = report();
    expect(result.docs[0]).toMatchObject({ documentedTools: 213, inventoryPages: 29, findings: [] });
    expect(result.docs[0].added).toHaveLength(174);
    expect(result.docs[0].added).toContain("artifact_query");
    expect(result.docs[0].removed).toEqual([
      "check_domain_availability_and_price",
      "deploy_to_vercel",
      "get_deployment_build_logs",
      "get_web_analytics",
    ]);
    expect(result.findings).toBe(178);
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
