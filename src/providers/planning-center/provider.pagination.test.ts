import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installOwnedTransport } from "../../../test/fixtures/owned-transport.js";
import { connectorContext } from "../../../test/fixtures/misc.js";
import { memoryStorage } from "../../storage/memory.js";
import { ContinuationBinding, setViewService } from "../../runtime/call.js";
import { planningCenter } from "./index.js";
import { PCO_INDEX, PCO_NAMED } from "./api.js";
import { PLANNING_CENTER_APPS, type PlanningCenterExcludableApp } from "./lib/constants.js";

describe("Planning Center exact totals and exclusion discovery", () => {
  const realFetch = globalThis.fetch;
  let documents: unknown[], sent: URL[];
  const storage = memoryStorage();
  const context = () => ({
    ...connectorContext(storage),
    credential: {
      get: async () => null,
      getAll: async () => ({ applicationId: "fixture-app", secret: "fixture-secret" }),
    },
  });
  const connector = (excludeApps: readonly PlanningCenterExcludableApp[] = []) =>
    planningCenter("church", { purpose: "Staff operations", excludeApps });
  beforeEach(() => {
    installOwnedTransport();
    documents = [];
    sent = [];
    globalThis.fetch = (async (input) => {
      sent.push(new URL(String(input)));
      return Response.json(documents.shift() ?? { data: [] });
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("INV-3 INV-5: keeps vendor totals distinct from emitted rows and opaque first/middle/terminal continuations", async () => {
    for (const [tool, path, type] of [
      ["search_people", "/people/v2/people", "Person"],
      ["list_groups", "/groups/v2/groups", "Group"],
      ["list_service_types", "/services/v2/service_types", "ServiceType"],
      ["list_donations", "/giving/v2/donations", "Donation"],
    ]) {
      const client = connector(),
        ctx = context();
      const data = [{ id: "1", type, attributes: { name: "Alice", first_name: "Alice" } }];
      documents.push(
        { data: [...data, { malformed: true }], meta: { total_count: 57, count: 2, next: { offset: 2 } } },
        { data, meta: { total_count: 57, count: 1, next: { offset: 3 } } },
        { data, meta: { total_count: 57, count: 1 } },
      );
      const first = (await client.callTool(tool!, { limit: 2, fields: ["id"] }, ctx)) as any;
      expect(first).toMatchObject({ items: [{ id: "1" }], page: { total: 57, hasMore: true } });
      expect(first.page.nextCursor).not.toBe("2");
      const middle = (await client.callTool(tool!, { limit: 2, cursor: first.page.nextCursor }, ctx)) as any;
      expect(middle.page).toMatchObject({ total: 57, hasMore: true });
      const terminal = (await client.callTool(tool!, { limit: 2, cursor: middle.page.nextCursor }, ctx)) as any;
      expect(terminal.page).toEqual({ total: 57, hasMore: false });
      expect(sent.at(-1)?.searchParams.get("offset")).toBe("3");
      documents.push(
        { data, meta: { total_count: 57, count: 1, next: { offset: 2 } } },
        { data, meta: { total_count: 57, count: 1 } },
      );
      const raw = (await client.callTool("pco_api_read", { path, fields: ["data"] }, ctx)) as any;
      expect(raw.page).toMatchObject({ total: 57, hasMore: true, param: "offset", in: "query" });
      expect(raw.data).not.toHaveProperty("meta");
      const end = (await client.callTool(
        "pco_api_read",
        { path, fields: ["data"], query: { offset: raw.page.nextCursor } },
        ctx,
      )) as any;
      expect(end.page).toMatchObject({ total: 57, hasMore: false });
    }
  });

  it("INV-3: omits missing/malformed optional totals while preserving otherwise valid pages", async () => {
    for (const value of [undefined, null, "12", -1, 0.5, Number.MAX_SAFE_INTEGER + 1, {}, []]) {
      const meta = { ...(value === undefined ? {} : { total_count: value }), next: { offset: 1 } };
      documents.push({ data: [], meta }, { data: [], meta });
      const client = connector(),
        ctx = context();
      const named = (await client.callTool("search_people", {}, ctx)) as any;
      const raw = (await client.callTool("pco_api_read", { path: "/people/v2/people" }, ctx)) as any;
      for (const result of [named, raw]) {
        expect(result.page.hasMore).toBe(true);
        expect(result.page.nextCursor).toBeTypeOf("string");
        expect(result.page).not.toHaveProperty("total");
      }
    }
    documents.push({ data: [], meta: { total_count: 0 } });
    expect(await connector().callTool("search_people", {}, context())).toMatchObject({
      items: [],
      page: { total: 0, hasMore: false },
    });
  });

  it("INV-3: keeps bounded composed-section truncation distinct from the vendor collection total", async () => {
    documents.push(
      { data: { id: "1", type: "Plan", attributes: { title: "Service" } } },
      {
        data: [{ id: "2", type: "Item", attributes: { title: "Song", sequence: 1 } }],
        meta: { total_count: 120, next: { offset: 100 } },
      },
      { data: [], meta: { total_count: 200, next: { offset: 100 } } },
    );
    const client = connector(),
      ctx = context();
    const bounded = (await client.callTool("get_plan", { serviceTypeId: "1", planId: "1" }, ctx)) as any;
    expect(bounded.items).toHaveLength(1);
    expect(bounded.truncated).toEqual(["items[]", "teamMembers[]"]);
    expect(bounded).not.toHaveProperty("page");
    documents.push({
      data: [{ id: "2", type: "Item", attributes: { title: "Song" } }],
      meta: { total_count: 120, next: { offset: 100 } },
    });
    const page = (await client.callTool(
      "pco_api_read",
      { path: "/services/v2/service_types/1/plans/1/items" },
      ctx,
    )) as any;
    expect(page.data.data).toHaveLength(1);
    expect(page.page).toMatchObject({ total: 120, hasMore: true });
  });

  const apps = PLANNING_CENTER_APPS.filter((app): app is PlanningCenterExcludableApp => app !== "people");
  type ExclusionCase = [string, readonly PlanningCenterExcludableApp[], readonly PlanningCenterExcludableApp[]];
  const exclusionCases: ExclusionCase[] = [
    ...apps.map((app) => [app, [app], [app]] as ExclusionCase),
    ["services and giving", ["services", "giving"], ["services", "giving"]],
    ["groups, calendar and webhooks", ["groups", "calendar", "webhooks"], ["groups", "calendar", "webhooks"]],
    ...apps.map((app) => [`all exclusions: ${app}`, apps, [app]] as ExclusionCase),
  ];
  it.each(exclusionCases)(
    "INV-4: removes %s tool suggestions from actual guides and discovery while refusing hatch access",
    async (_label, excluded, inspectApps) => {
      const full = connector();
      const fullNames = new Set(full.staticTools!.map((t) => t.name));
      const limited = connector(excluded),
        names = new Set(limited.staticTools!.map((t) => t.name));
      const removed = [...fullNames].filter((name) => !names.has(name));
      const usageGuide = limited.usageGuide!;
      const guide = typeof usageGuide === "string" ? usageGuide : usageGuide.content;
      for (const name of removed) expect(guide, `${excluded}: ${name}`).not.toContain(`\`${name}\``);
      expect(guide).not.toMatch(/<!-- when:/);
      for (const app of inspectApps) {
        const unavailable = Object.entries(PCO_NAMED).filter(([key]) => key.startsWith(`GET /${app}/`));
        for (const [key, tool] of unavailable) {
          const [method, path] = key.split(" ");
          const details = (await limited.callTool("pco_api_details", { method, path }, context())) as any;
          expect(details).not.toHaveProperty("named", tool);
        }
        const path = PCO_INDEX.ops.find((op) => op.method === "GET" && op.path.startsWith(`/${app}/`))!.path;
        const found = (await limited.callTool("pco_api_search", { query: path }, context())) as any;
        expect(found.operations.some((op: any) => removed.includes(op.named))).toBe(false);
        const literal = path.replace(/\{[^}]+\}/g, "1");
        await expect(limited.callTool("pco_api_read", { path: literal }, context())).rejects.toBeDefined();
      }
      expect(sent).toEqual([]);
      for (const tool of limited.staticTools!)
        for (const name of removed) expect(JSON.stringify(tool)).not.toContain(`from ${name}`);
    },
  );

  it("INV-5: retains delegated-owner and filter cursor bindings with totals", async () => {
    const client = connector(),
      alice = context(),
      bob = context();
    setViewService(alice, ContinuationBinding, { connection: "church", principal: "alice" });
    setViewService(bob, ContinuationBinding, { connection: "church", principal: "bob" });
    documents.push({ data: [], meta: { total_count: 123, next: { offset: 1 } } });
    const first = (await client.callTool("search_people", { search: "Alice" }, alice)) as any;
    const before = sent.length;
    await expect(
      client.callTool("search_people", { search: "Alice", cursor: first.page.nextCursor }, bob),
    ).rejects.toMatchObject({ code: "invalid_args" });
    await expect(
      client.callTool("search_people", { search: "Bob", cursor: first.page.nextCursor }, alice),
    ).rejects.toMatchObject({ code: "invalid_args" });
    expect(sent).toHaveLength(before);
    documents.push({ data: [], meta: { total_count: 123 } });
    expect(
      await client.callTool("search_people", { search: "Alice", cursor: first.page.nextCursor }, alice),
    ).toMatchObject({ page: { total: 123, hasMore: false } });
  });
});
