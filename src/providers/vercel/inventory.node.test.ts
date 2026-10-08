// Node-only: exercises the filesystem and fetch bounds of the public maintainer inventory checker.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
const inventoryModule = new URL("../../../scripts/vercel-inventory.mjs", import.meta.url).href;
const { readVercelInventory } = (await import(inventoryModule)) as {
  readVercelInventory(source: string): Promise<{ names: string[]; pages: number }>;
};

const root = fileURLToPath(new URL("../../../", import.meta.url));
const fixtures = fileURLToPath(new URL("./inventory-fixtures/", import.meta.url));
const url = "https://vercel.com/docs/agent-resources/vercel-mcp/tools.md";
const temporary: string[] = [];
const text = (name: string) => readFile(join(fixtures, name), "utf8");

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function mockPages(deployment = "deployments.md") {
  const pages = new Map([
    [url, await text("tools.md")],
    [url.replace("tools.md", "tools/deployments.md"), await text(deployment)],
    [url.replace("tools.md", "tools/teams.md"), await text("teams.md")],
  ]);
  const fetcher = vi.fn(async (source: URL) => new Response(pages.get(String(source)), { status: 200 }));
  vi.stubGlobal("fetch", fetcher);
  return { pages, fetcher };
}

describe("Vercel public inventory", () => {
  it("INV-8 traverses categories once and covers table entries without collecting parameter names", async () => {
    const { fetcher } = await mockPages();
    expect(await readVercelInventory(url)).toEqual({
      names: ["cancel_deployment", "list_deployments", "list_teams"],
      pages: 3,
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
    for (const [source, init] of fetcher.mock.calls as unknown as [URL, RequestInit][]) {
      expect(source.origin).toBe("https://vercel.com");
      expect(source.pathname.endsWith(".md")).toBe(true);
      expect(init).toMatchObject({ redirect: "error", credentials: "omit", signal: expect.any(AbortSignal) });
      expect(init.headers).not.toHaveProperty("Authorization");
    }
  });

  it.each(["incomplete.md", "unparseable.md"])(
    "INV-8 refuses %s instead of comparing a partial catalog",
    async (page) => {
      await mockPages(page);
      await expect(readVercelInventory(url)).rejects.toThrow(/unavailable\/incomplete.*deployments\.md.*expected 2/);
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
    pages.set(url, (await text("tools.md")).replace("Deployments repeated\n2 tools", "Deployments repeated\n3 tools"));
    await expect(readVercelInventory(url)).rejects.toThrow("conflicting published tool counts");
    pages.set(url, await text("tools.md"));
    pages.set(url.replace("tools.md", "tools/deployments.md"), "## `list_deployments`\n## `list_deployments`\n");
    await expect(readVercelInventory(url)).rejects.toThrow("expected 2 unique tool headings");
    pages.set(url.replace("tools.md", "tools/deployments.md"), await text("deployments.md"));
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

  it("INV-10 reports additions/removals, makes strict findings actionable and never records classifications", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connecta-vercel-inventory-"));
    temporary.push(directory);
    const landing = join(directory, "tools.md");
    await writeFile(landing, await text("tools.md"));
    await writeFile(join(directory, "deployments.md"), await text("deployments.md"));
    await writeFile(join(directory, "teams.md"), await text("teams.md"));
    const setup = join(directory, "setup.md");
    await writeFile(setup, "https://mcp.vercel.com OAuth");
    const args = [
      join(root, "scripts/drift-check.mjs"),
      "--docs",
      "--provider",
      "vercel",
      "--tool-reference",
      `vercel=${landing}`,
      "--setup-reference",
      `vercel=${setup}`,
      "--json",
      "--record",
    ];
    const evidence = join(root, "src/providers/vercel/drift.json");
    const before = await readFile(evidence, "utf8");
    const report = JSON.parse(execFileSync(process.execPath, args, { encoding: "utf8" }));
    expect(report.docs[0]).toMatchObject({ documentedTools: 3, inventoryPages: 3, added: [], findings: [] });
    expect(report.docs[0].removed).toContain("get_project");
    expect(report.findings).toBe(report.docs[0].removed.length);
    expect(spawnSync(process.execPath, [...args, "--strict"]).status).toBe(1);
    await writeFile(join(directory, "teams.md"), "## `new_tool`\n");
    expect(JSON.parse(execFileSync(process.execPath, args, { encoding: "utf8" })).docs[0].added).toEqual(["new_tool"]);
    await rm(join(directory, "teams.md"));
    const incomplete = JSON.parse(execFileSync(process.execPath, args, { encoding: "utf8" }));
    expect(incomplete.docs[0].findings).toEqual([expect.objectContaining({ kind: "unavailable" })]);
    expect(incomplete.docs[0].added).toBeUndefined();
    expect(incomplete.docs[0].removed).toBeUndefined();
    expect(await readFile(evidence, "utf8")).toBe(before);
    await writeFile(join(directory, "tools.md"), "x".repeat(512 * 1024 + 1));
    await expect(readVercelInventory(landing)).rejects.toThrow("page exceeds 524288 bytes");
  });
});
