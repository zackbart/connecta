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
  const vendor = await serveFetch(async (request) => {
    if (request.headers.get("authorization") !== `Bearer ${credential}`) return new Response(null, { status: 401 });
    const route = /^\/v1\/customers\/(cus_(?:control|html|broken|large|refused))$/.exec(new URL(request.url).pathname);
    if (!route) return Response.json({ error: { message: "Unknown customer route" } }, { status: 404 });
    const id = route[1]!;
    if (request.method === "GET") return Response.json({ id, object: "customer", deleted: deleted.has(id) });
    if (request.method !== "DELETE") return new Response(null, { status: 405 });
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
    await session.close();
    await deployment.close();
    deployment = await startNodeDeployment([spec]);
    session = await connectMcp(deployment.mcpUrl, { Authorization: `Bearer ${deployment.token}` });
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
    expect(sends).toEqual(["cus_control", "cus_html", "cus_broken", "cus_large"]);
  } finally {
    await session?.close();
    await deployment?.close();
    unregisterFakeRoute(credential);
    await vendor.close();
  }
}, 30_000);
