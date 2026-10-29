// Node-only: real HTTP/MCP, SQLite, encrypted credentials and QuickJS.
import { expect, it } from "vitest";
import { z } from "zod";
import { api, remoteMcp, type InboundAuth } from "@zackbart/connecta";
import { activityHistory } from "@zackbart/connecta/activity";
import { startNodeDeployment } from "../eval/deploy/node.js";
import { FakeService, Ledger } from "../eval/fakes/service.js";
import { connectMcp, type McpSession } from "../eval/support/mcp.js";
import { serveFetch } from "../eval/support/serve.js";
import { echoForms, leakedRun, SECRET } from "./helpers/secret-echoes.js";

const aliceKey = `alice_${SECRET}`;
const bobKey = `bob_${SECRET.split("").reverse().join("")}`;
const privateValue = "qL8!mP2#vX6$kN4?rS9@tW3+eZ7=F5/u";
const auth: InboundAuth = {
  kind: "journey-directory",
  interactiveOperator: true,
  activityActorNamespace: "https://directory.example.test",
  uiAuth: { kind: "clerk", publishableKey: "pk_test_fake", frontendApiUrl: "https://directory.example.test" },
  authorize(request) {
    const user = /^Bearer (alice|bob|carol)$/.exec(request.headers.get("authorization") ?? "")?.[1];
    return user ? { ok: true, userId: user } : { ok: false, response: new Response(null, { status: 401 }) };
  },
};

it("INV-1 INV-2 INV-3 INV-4 INV-5 INV-6 INV-9 INV-10: identities discover only their pool, write once, reconcile and keep payloads private", async () => {
  const ledger = new Ledger();
  const committed: Array<{ intent: string; password: string }> = [];
  const records: unknown[] = [];
  const record = (...args: unknown[]) => {
    records.push(args);
  };
  let fail = false;
  const vendor = new FakeService(
    "notes",
    "Team notes",
    [
      {
        name: "read",
        description: "Read team notes",
        input: z.object({}),
        annotations: { readOnlyHint: true },
        run: () => ({ json: { intents: committed.map((row) => row.intent), safe: "delivered-note" } }),
      },
      {
        name: "save",
        description: "Save team notes",
        input: z.object({ intent: z.string(), password: z.string().meta({ writeOnly: true }) }),
        // Missing hints must fail closed even though the tool's name sounds harmless.
        annotations: {},
        run: (args) => {
          committed.push(args as { intent: string; password: string });
          return fail
            ? { error: `reply lost ${privateValue}` }
            : { json: { saved: args.intent, password: args.password } };
        },
      },
      {
        name: "hidden",
        description: "Private maintenance",
        input: z.object({}),
        annotations: { readOnlyHint: true },
        run: () => ({ json: { forbidden: true } }),
      },
    ],
    ledger,
  );
  const accountReads: string[] = [];
  const accounts = await serveFetch(async (request) => {
    const key = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    accountReads.push(key);
    if (key !== aliceKey && key !== bobKey) return new Response(null, { status: 401 });
    return Response.json({ owner: key === aliceKey ? "Alice" : "Bob", echo: echoForms(key).map(([, form]) => form) });
  });
  let deployment: Awaited<ReturnType<typeof startNodeDeployment>> | undefined;
  const sessions: McpSession[] = [];
  try {
    await vendor.start();
    deployment = await startNodeDeployment([], {
      auth,
      maintainers: ["alice"],
      logger: { debug: record, info: record, warn: record, error: record },
      activity: activityHistory({
        store: {
          record: (event) => {
            records.push(event);
          },
        },
      }),
      pools: {
        eval: { tools: ["notes"], members: ["agent:eval-machine"] },
        team: { tools: ["notes"], members: ["alice", "bob"] },
        "team-agents": { tools: ["notes"], members: ["agent:eval-machine"] },
        locked: { tools: ["notes"], members: ["bob"], readOnly: true },
        readers: { tools: ["notes.read"], members: ["alice", "bob"] },
        account: { tools: ["account"], members: ["alice", "bob"] },
      },
      classification: { notes: { hidden: "hidden" } },
      execute: { maxWrites: 1 },
      connectors: [
        remoteMcp("notes", { url: vendor.url, usageGuide: "Save using notes.save." }),
        api("account", {
          authScope: "personal",
          credential: { label: "Account key" },
          tools: [
            {
              name: "read",
              description: "Read my account",
              annotations: { readOnlyHint: true },
              handler: async (_args, ctx) =>
                (
                  await ctx.fetch(accounts.url, { headers: { Authorization: `Bearer ${await ctx.credential!.get()}` } })
                ).json(),
            },
          ],
        }),
      ],
    });
    const origin = deployment.origin;
    const session = async (path: string, token: string) => {
      const client = await connectMcp(`${origin}${path}`, { Authorization: `Bearer ${token}` });
      sessions.push(client);
      return client;
    };
    const bob = await session("/mcp/team", "bob");
    const locked = await session("/mcp/locked", "bob");
    const machine = await session("/agent/team-agents", deployment.token);
    const search = await bob.call("search_tools", { query: "", limit: 50 });
    expect(search.isError).toBe(false);
    expect(search.text).toContain("notes.read");
    expect(search.text).toContain("notes.save");
    expect(search.text).not.toMatch(/account\.read|notes\.hidden/);
    // Discovery and status must not send a tool or begin authorization.
    expect(ledger.calls).toEqual([]);
    expect(accountReads).toEqual([]);
    const refusals = new Set<string>();
    for (const path of ["/mcp", "/mcp/missing", "/mcp/other"]) {
      const response = await fetch(`${origin}${path}`, { headers: { Authorization: "Bearer bob" } });
      expect(response.status).toBe(404);
      refusals.add(await response.text());
    }
    expect(refusals.size).toBe(1);
    for (const [path, token, status] of [
      ["/mcp/team", "carol", 404],
      ["/mcp/team", deployment.token, 401],
      ["/agent/team-agents", "bob", 401],
    ] as const) {
      const response = await fetch(`${origin}${path}`, { headers: { Authorization: `Bearer ${token}` } });
      expect(response.status, path).toBe(status);
      await response.body?.cancel();
    }
    const escape = await bob.call("execute_code", {
      code: `async () => {
      const seen = await connecta.search({ query: "", limit: 50 });
      const refused = [];
      for (const address of ["notes.hidden", "account.read"]) {
        try { await connecta.call(address, { owner: "alice", pool: "account", classification: "read" }); }
        catch (e) { refused.push(e.code); }
      }
      return { seen, refused };
    }`,
    });
    expect(escape.isError, escape.text).toBe(false);
    expect(escape.text).toContain("unknown_tool");
    expect(ledger.calls).toEqual([]);
    const listing = await locked.call("search_tools", { query: "", limit: 50 });
    expect(listing.text).toContain("notes.read");
    expect(JSON.parse(listing.text).tools.map((tool: { address: string }) => tool.address)).toEqual(["notes.read"]);
    expect((await locked.listTools()).find((tool) => tool.name === "execute_code")?.readOnly).toBe(true);
    for (const name of ["call_tool", "call_destructive_tool"]) {
      const refused = await locked.call(name, { address: "notes.save", args: {} });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain("read_only_endpoint");
    }
    const refused = await locked.call("execute_code", { code: 'async () => connecta.call("notes.save", {})' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("read_only_endpoint");
    expect((await locked.call("skills", { name: "connector:notes" })).text).toContain("notes.save");
    expect(ledger.calls).toEqual([]);

    // A maintainer's broader /mcp access cannot widen an exact pool grant.
    const reader = await session("/mcp/readers", "alice");
    const exact = await reader.call("search_tools", { query: "", limit: 50, pool: "team" });
    expect(JSON.parse(exact.text).tools.map((tool: { address: string }) => tool.address)).toEqual(["notes.read"]);
    const ungranted = await reader.call("execute_code", {
      code: 'async () => connecta.call("notes.save", { intent: "forged", password: "x", pool: "team" })',
    });
    expect(ungranted.isError).toBe(true);
    expect(ungranted.text).toContain("unknown_tool");
    expect(ledger.calls).toEqual([]);

    const args = { intent: "first", password: privateValue };
    expect((await machine.call("call_tool", { address: "notes.save", args })).isError).toBe(true);
    const saved = await machine.call("call_destructive_tool", { address: "notes.save", args });
    expect(saved.isError, saved.text).toBe(false);
    expect(saved.text).toContain("first");
    expect(leakedRun(JSON.stringify(saved), privateValue)).toBeUndefined();
    fail = true;
    // Catching the guest exception cannot turn an ambiguous dispatched write into success.
    const unknown = await bob.call("execute_code", {
      code: `async () => {
      try { await connecta.call("notes.save", ${JSON.stringify({ ...args, intent: "lost" })}); } catch {}
      return "claimed success";
    }`,
    });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain("write_outcome_unknown");
    expect(JSON.parse(unknown.text).error).toMatchObject({
      code: "write_outcome_unknown",
      retryable: false,
      writes: { succeeded: 0, failed: 0, unknown: 1 },
    });
    expect(leakedRun(JSON.stringify(unknown), privateValue)).toBeUndefined();
    const reconciled = await machine.call("call_tool", { address: "notes.read" });
    expect(reconciled.isError, reconciled.text).toBe(false);
    expect(reconciled.text).toContain("lost");
    fail = false;
    const recovered = await machine.call("execute_code", {
      code: `async () => {
      await connecta.call("notes.save", ${JSON.stringify({ ...args, intent: "recovered" })});
      try { await connecta.call("notes.save", ${JSON.stringify({ ...args, intent: "over-budget" })}); } catch {}
      return (await connecta.call("notes.read", {})).data;
    }`,
    });
    expect(recovered.isError, recovered.text).toBe(false);
    expect(recovered.text).toContain("recovered");
    expect(committed).toEqual(["first", "lost", "recovered"].map((intent) => ({ intent, password: privateValue })));
    expect(ledger.calls.filter((call) => call.kind === "write").map((call) => call.args)).toEqual(committed);
    expect(ledger.requests.filter((request) => request.methods.includes("tools/call"))).toHaveLength(
      ledger.calls.length,
    );

    // Personal credentials share a connector, never an owner.
    for (const [user, value] of [
      ["alice", aliceKey],
      ["bob", bobKey],
    ]) {
      const response = await fetch(`${origin}/ui/credentials/account`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${user}`, Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ value }),
      });
      expect(response.status, await response.text()).toBe(200);
    }
    for (const [user, value] of [
      ["alice", aliceKey],
      ["bob", bobKey],
    ]) {
      const client = await session("/mcp/account", user!);
      const result = await client.call("execute_code", {
        code: 'async () => (await connecta.call("account.read", { owner: "alice" })).data',
      });
      expect(result.isError, result.text).toBe(false);
      expect(result.text).toContain(user === "alice" ? "Alice" : "Bob");
      expect(leakedRun(JSON.stringify(result), value!)).toBeUndefined();
    }
    expect(accountReads).toEqual([aliceKey, bobKey]);
    expect(records.length).toBeGreaterThan(0);
    expect(JSON.stringify(records)).not.toMatch(/claimed success|over-budget|delivered-note|reply lost|"intent"/);
    expect(leakedRun(JSON.stringify(records), privateValue)).toBeUndefined();
    expect(leakedRun(JSON.stringify(records), aliceKey)).toBeUndefined();
    expect(leakedRun(JSON.stringify(records), bobKey)).toBeUndefined();
  } finally {
    await Promise.all(sessions.map((client) => client.close()));
    await deployment?.close();
    await vendor.stop();
    await accounts.close();
  }
}, 30_000);

it("INV-2 INV-4 INV-9: an explicitly writable pool reopens a read-only deployment while connector policy still refuses sends", async () => {
  const ledger = new Ledger();
  const state: string[] = [];
  const vendor = new FakeService(
    "notes",
    "Notes",
    [
      {
        name: "save",
        description: "Save a note",
        input: z.object({ intent: z.string() }),
        annotations: { readOnlyHint: false },
        run: (args) => {
          state.push(String(args.intent));
          return { json: { saved: args.intent } };
        },
      },
    ],
    ledger,
  );
  let deployment: Awaited<ReturnType<typeof startNodeDeployment>> | undefined;
  const sessions: McpSession[] = [];
  try {
    await vendor.start();
    deployment = await startNodeDeployment([], {
      readOnly: true,
      pools: {
        eval: { tools: ["notes"], members: ["agent:eval-machine"] },
        open: { tools: ["notes", "locked"], members: ["agent:eval-machine"], readOnly: false },
      },
      connectors: [remoteMcp("notes", { url: vendor.url }), remoteMcp("locked", { url: vendor.url, readOnly: true })],
    });
    const inherited = await connectMcp(deployment.mcpUrl, { Authorization: `Bearer ${deployment.token}` });
    sessions.push(inherited);
    const opened = await connectMcp(`${deployment.origin}/agent/open`, { Authorization: `Bearer ${deployment.token}` });
    sessions.push(opened);
    expect((await inherited.listTools()).find((tool) => tool.name === "execute_code")?.readOnly).toBe(true);
    expect((await opened.listTools()).find((tool) => tool.name === "execute_code")?.readOnly).toBe(false);
    for (const [client, address] of [
      [inherited, "notes.save"],
      [opened, "locked.save"],
    ] as const) {
      const reply = await client.call("execute_code", {
        code: `async () => connecta.call(${JSON.stringify(address)}, { intent: "refused" })`,
      });
      expect(reply.isError).toBe(true);
      expect(reply.text).toContain("read_only_endpoint");
    }
    expect(ledger.calls).toEqual([]);
    const reply = await opened.call("execute_code", {
      code: 'async () => (await connecta.call("notes.save", { intent: "permitted" })).data',
    });
    expect(reply.isError, reply.text).toBe(false);
    expect(reply.text).toContain("permitted");
    expect(state).toEqual(["permitted"]);
    expect(ledger.calls.map((call) => call.args)).toEqual([{ intent: "permitted" }]);
  } finally {
    await Promise.all(sessions.map((session) => session.close()));
    await deployment?.close();
    await vendor.stop();
  }
}, 30_000);
