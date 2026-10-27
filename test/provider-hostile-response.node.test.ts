// Node-only: real vendor sockets and the HTTP MCP/SQLite/QuickJS deployment.
import { expect, it } from "vitest";
import { startNodeDeployment, type Deployment } from "../eval/deploy/node.js";
import { registerFakeRoute, unregisterFakeRoute } from "../eval/fakes/rest.js";
import { connectMcp, type McpSession } from "../eval/support/mcp.js";
import { serveFetch } from "../eval/support/serve.js";

it("INV-5 INV-9: reconciles committed writes after hostile HTTP acknowledgements without a second physical send", async () => {
  const credential = "sk_test_hostile_acknowledgement";
  const deleted = new Set<string>();
  const sends: string[] = [];
  const attempts: string[] = [];
  let readStatus = 200;
  const vendor = await serveFetch(async (request) => {
    if (request.headers.get("authorization") !== `Bearer ${credential}`) return new Response(null, { status: 401 });
    const route = /^\/v1\/customers\/(cus_(?:control|html|broken|large|refused|auth))$/.exec(
      new URL(request.url).pathname,
    );
    if (!route) return Response.json({ error: { message: "Unknown customer route" } }, { status: 404 });
    const id = route[1]!;
    attempts.push(`${request.method} ${id}`);
    if (request.method === "GET")
      return readStatus === 200
        ? Response.json({ id, object: "customer", name: "Alice", deleted: deleted.has(id) })
        : Response.json(
            { error: { message: `Private vendor diagnostic ${credential}` } },
            {
              status: readStatus,
              headers: { "retry-after": "2" },
            },
          );
    if (request.method !== "DELETE") return new Response(null, { status: 405 });
    if (id === "cus_auth")
      return Response.json(
        { error: { message: credential } },
        {
          status: 401,
          headers: { "request-id": "req_auth_refused" },
        },
      );
    sends.push(id);
    deleted.add(id); // The vendor commits before it constructs the hostile acknowledgement.
    if (id === "cus_html") return new Response("<html>accepted</html>", { headers: { "content-type": "text/html" } });
    if (id === "cus_broken") return new Response('{"deleted":', { headers: { "content-type": "application/json" } });
    if (id === "cus_large") return Response.json({ padding: "x".repeat(8 * 1024 * 1024) });
    return Response.json({ id, object: "customer", deleted: true });
  });
  let deployment: Deployment | undefined;
  let session: McpSession | undefined;
  registerFakeRoute(credential, vendor.url, ["api.stripe.com"]);
  try {
    const spec = {
      id: "crm",
      title: "CRM",
      description: "Customers",
      url: vendor.url,
      rest: "stripe" as const,
      credential: { label: "API key", value: credential },
    };
    deployment = await startNodeDeployment([spec], { readOnly: true });
    session = await connectMcp(deployment.mcpUrl, { Authorization: `Bearer ${deployment.token}` });
    const remove = (id: string) =>
      session!.call("call_destructive_tool", {
        address: "crm.stripe_api_write",
        args: { method: "DELETE", path: `/v1/customers/${id}` },
        resultMode: "value",
      });
    // A refusal must really prevent a mutation, even though the vendor would accept it.
    expect((await remove("cus_refused")).isError).toBe(true);
    expect(sends).toEqual([]);
    expect(deleted.size).toBe(0);
    expect(attempts).toEqual([]);
    await session.close();
    await deployment.close();
    deployment = await startNodeDeployment([spec]);
    session = await connectMcp(deployment.mcpUrl, { Authorization: `Bearer ${deployment.token}` });
    // Unlike an ambiguous acknowledgement, Stripe's reviewed v1 401 with a
    // Request-Id proves the vendor refused before execution. Recovery must
    // retain that distinction without replaying the physical request.
    const refused = await remove("cus_auth");
    expect(refused.isError, refused.text).toBe(true);
    expect(refused.structured).toMatchObject({ ok: false, error: { code: "auth_required" } });
    expect(refused.structured).not.toHaveProperty("error.writeOutcome");
    expect(JSON.stringify(refused)).not.toContain(credential);
    expect(attempts).toEqual(["DELETE cus_auth"]);
    expect(deleted.size).toBe(0);
    const control = await remove("cus_control");
    expect(control.isError, control.text).toBe(false);
    expect(deleted.has("cus_control")).toBe(true);
    for (const id of ["cus_html", "cus_broken", "cus_large"]) {
      const result = await remove(id);
      expect(result.isError, result.text).toBe(true);
      expect(result.text).toContain("unknown");
      expect(result.text).toContain("check the target before repeating");
      expect(JSON.stringify(result)).not.toContain(credential);
      const reconciled = await session.call("execute_code", {
        code: `async () => (await connecta.call("crm.stripe_api_read", {path: "/v1/customers/${id}"})).data`,
      });
      expect(reconciled.isError, reconciled.text).toBe(false);
      expect(reconciled.text).toContain('"deleted":true');
      expect(deleted.has(id)).toBe(true);
      expect(sends.filter((sent) => sent === id)).toHaveLength(1);
    }
    // Read failures retain actionable facts and recover actual data through
    // both direct calls and the guest bridge; vendor prose stays private.
    for (const [status, code, retryable] of [
      [403, "provider_permission_denied", false],
      [429, "rate_limited", true],
      [503, "unavailable", true],
    ] as const) {
      readStatus = status;
      const read = await session.call("call_tool", {
        address: "crm.stripe_api_read",
        args: { path: "/v1/customers/cus_control" },
      });
      expect(read.isError, read.text).toBe(true);
      expect(read.structured).toMatchObject({ ok: false, error: { code, retryable } });
      expect(read.structured).not.toHaveProperty("error.writeOutcome");
      if (status === 429) expect(read.structured).toHaveProperty("error.retryAfterMs", 2000);
      expect(JSON.stringify(read)).not.toContain(credential);
      readStatus = 200;
      const recovered = await session.call("execute_code", {
        code: 'async () => (await connecta.call("crm.stripe_api_read", {path: "/v1/customers/cus_control"})).data',
      });
      expect(recovered.isError, recovered.text).toBe(false);
      expect(recovered.text).toContain('"name":"Alice"');
      expect(recovered.text).toContain('"deleted":true');
    }
    expect(sends).toEqual(["cus_control", "cus_html", "cus_broken", "cus_large"]);
    expect(attempts.filter((attempt) => attempt.startsWith("DELETE "))).toHaveLength(5);
  } finally {
    await session?.close();
    await deployment?.close();
    unregisterFakeRoute(credential);
    await vendor.close();
  }
}, 30_000);
