// Node-only: real loopback MCP/token servers and the owned Node socket sender.
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { googleServiceAccountToken } from "../src/google.js";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { configureGuardedTransport } from "../src/guarded-transport.js";
import { nodeGuardedTransport } from "../src/http/node-transport.js";
import { serveFetch } from "../eval/support/serve.js";
import { httpDownstream } from "./fixtures/downstream-mcp.js";
import { connectorContext } from "./fixtures/misc.js";
import { PRIVATE_KEY } from "./fixtures/rsa.js";

for (const operation of ["initialize", "tools/list", "read", "write"] as const) {
  it(`invalidates a real HTTP 401 during ${operation} for the next request without replay`, async () => {
    let mints = 0;
    let mutations = 0;
    const calls: Array<{ name: string; authorization: string | null }> = [];
    const endpoint = await serveFetch(async (request) => {
      const form = new URLSearchParams(await request.text());
      expect(form.get("assertion")?.split(".")).toHaveLength(3);
      return Response.json({ access_token: `GOOGLE_MINTED_ACCESS_${++mints}`, expires_in: 3600 });
    });
    const downstream = httpDownstream((server) => {
      for (const name of ["read", "write"])
        server.registerTool(
          name,
          {
            inputSchema: z.object({}),
            annotations: { readOnlyHint: name === "read" },
          },
          async () => {
            if (name === "write") mutations++;
            return { content: [{ type: "text", text: "complete" }] };
          },
        );
    });
    const vendor = await serveFetch(async (request) => {
      const rpc =
        request.method === "POST"
          ? ((await request.clone().json()) as { method: string; params?: { name?: string } })
          : undefined;
      const name = rpc?.method === "tools/call" ? rpc.params!.name! : (rpc?.method ?? request.method);
      const authorization = request.headers.get("authorization");
      calls.push({ name, authorization });
      if (name === operation && authorization === "Bearer GOOGLE_MINTED_ACCESS_1") {
        return new Response("GOOGLE_MINTED_ACCESS_1", { status: 401 });
      }
      return await downstream.fetch(request.url, {
        method: request.method,
        headers: request.headers,
        ...(request.method === "POST" ? { body: await request.text() } : {}),
      });
    });
    // Confine the fixed token endpoint to a loopback fake, still using real
    // sockets. MCP writes retain the production owned Node sender.
    const realFetch = globalThis.fetch;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        async (input, init) =>
          await realFetch(String(input) === "https://oauth2.googleapis.com/token" ? endpoint.url : input, init),
      );
    const previous = configureGuardedTransport(nodeGuardedTransport);
    const connector = remoteMcp("warehouse", {
      url: `${vendor.url}/mcp`,
      versionNegotiation: "legacy",
      authScope: "shared",
      auth: {
        type: "request",
        token: googleServiceAccountToken({
          serviceAccount: {
            clientEmail: `warehouse-${operation.replace(/\W/g, "")}@project.iam.gserviceaccount.com`,
            privateKey: PRIVATE_KEY,
          },
          scopes: ["https://www.googleapis.com/auth/bigquery"],
        }),
      },
    });
    const first = connectorContext();
    const next = connectorContext();
    const run = async (ctx: ReturnType<typeof connectorContext>) =>
      operation === "initialize" || operation === "tools/list"
        ? await connector.listTools(ctx)
        : await connector.callTool(operation, {}, ctx);
    try {
      await expect(run(first)).rejects.toMatchObject({
        code: "auth_required",
        message: expect.not.stringContaining("GOOGLE_MINTED_ACCESS_1"),
      });
      expect(calls.filter((call) => call.name === operation)).toEqual([
        { name: operation, authorization: "Bearer GOOGLE_MINTED_ACCESS_1" },
      ]);
      expect(mints).toBe(1);
      expect(mutations).toBe(0);
      // A later invocation in the failed scope stays latched, without a mint.
      await expect(run(first)).rejects.toMatchObject({ code: "auth_required" });
      expect(mints).toBe(1);
      await connector.closeScope?.(first);
      await expect(run(next)).resolves.toBeDefined();
      expect(calls.filter((call) => call.name === operation)).toEqual([
        { name: operation, authorization: "Bearer GOOGLE_MINTED_ACCESS_1" },
        { name: operation, authorization: "Bearer GOOGLE_MINTED_ACCESS_2" },
      ]);
      expect(mints).toBe(2);
      expect(mutations).toBe(operation === "write" ? 1 : 0);
    } finally {
      await connector.closeScope?.(first);
      await connector.closeScope?.(next);
      configureGuardedTransport(previous);
      fetchSpy.mockRestore();
      await Promise.all([endpoint.close(), vendor.close()]);
    }
  });
}
