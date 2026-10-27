// Node-only: real HTTP MCP, SQLite and QuickJS through the eval deployment adapter.
import { expect, it } from "vitest";
import { z } from "zod";
import { startNodeDeployment, type Deployment } from "../eval/deploy/node.js";
import { registerFakeRoute, unregisterFakeRoute } from "../eval/fakes/rest.js";
import { FakeService, Ledger } from "../eval/fakes/service.js";
import type { ConnectorSpec } from "../eval/fakes/world.js";
import { connectMcp, type McpSession } from "../eval/support/mcp.js";
import { serveFetch } from "../eval/support/serve.js";
import { basicForms, echoForms, leakedRun, SECRET } from "./helpers/secret-echoes.js";

// Independent of production redaction: inspect every decodable view of the
// actual wire response, including any new field the vendor starts returning.
const secret = `sk_test_${SECRET}`;
const echoes = [...echoForms(secret), ...basicForms("alice", secret)].map(([, form]) => form);
const extra = Object.fromEntries(echoes.map((form, index) => [`new_vendor_field_${index}`, `before ${form} after`]));

for (const kind of ["remote MCP", "Stripe API"] as const) {
  it(`INV-5: ${kind} hides credential echoes in new fields across direct, guest, failure and recovery`, async () => {
    let failing = false;
    let authenticated = 0;
    let deployment: Deployment | undefined;
    let session: McpSession | undefined;
    const ledger = new Ledger();
    const vendor =
      kind === "remote MCP"
        ? new FakeService(
            "crm",
            "Customer records",
            [
              {
                name: "get_customer",
                description: "Read a customer",
                input: z.object({}),
                annotations: { readOnlyHint: true },
                run: () => {
                  // FakeService rejects requests without the configured Bearer token.
                  authenticated++;
                  return failing
                    ? { error: `Permission refused: ${echoes.join(" ; ")}` }
                    : { json: { id: "cus_alice", name: "Alice", ...extra, [secret]: "new vendor key" } };
                },
              },
            ],
            ledger,
            { bearer: () => secret },
          )
        : undefined;
    let server: Awaited<ReturnType<typeof serveFetch>> | undefined;
    try {
      let spec: ConnectorSpec;
      if (vendor) {
        await vendor.start();
        spec = {
          id: "crm",
          title: "CRM",
          description: "Customer records",
          url: vendor.url,
          credential: { label: "API key", value: secret },
        };
      } else {
        server = await serveFetch(async (request) => {
          if (request.headers.get("authorization") !== `Bearer ${secret}`) return new Response(null, { status: 401 });
          authenticated++;
          return failing
            ? Response.json(
                { error: { type: "invalid_request_error", message: `Permission refused: ${echoes.join(" ; ")}` } },
                { status: 403 },
              )
            : Response.json({
                id: "cus_alice",
                object: "customer",
                name: "Alice",
                ...extra,
                [secret]: "new vendor key",
              });
        });
        registerFakeRoute(secret, server.url, ["api.stripe.com"]);
        spec = {
          id: "crm",
          title: "CRM",
          description: "Customer records",
          url: server.url,
          rest: "stripe",
          credential: { label: "API key", value: secret },
        };
      }
      deployment = await startNodeDeployment([spec]);
      session = await connectMcp(deployment.mcpUrl, { Authorization: `Bearer ${deployment.token}` });
      const address = vendor ? "crm.get_customer" : "crm.stripe_api_read";
      const args = vendor ? {} : { path: "/v1/customers/cus_alice" };
      const direct = () => session!.call("call_tool", { address, args, resultMode: "value" });
      const guest = () =>
        session!.call("execute_code", {
          code: `async () => (await connecta.call(${JSON.stringify(address)}, ${JSON.stringify(args)})).data`,
        });
      for (const call of [direct, guest]) {
        const result = await call();
        expect(result.isError, result.text).toBe(false);
        expect(result.text).toContain("Alice");
        expect(result.text).toContain("new_vendor_field_0");
        expect(result.text).toContain("[redacted]");
        expect(leakedRun(JSON.stringify(result), SECRET)).toBeUndefined();
      }
      const sentBeforeFailure = authenticated;
      failing = true;
      for (const call of [direct, guest]) {
        const result = await call();
        expect(result.isError, result.text).toBe(true);
        expect(leakedRun(JSON.stringify(result), SECRET)).toBeUndefined();
      }
      expect(authenticated).toBeGreaterThan(sentBeforeFailure);
      failing = false;
      const recovered = await guest();
      expect(recovered.isError, recovered.text).toBe(false);
      expect(recovered.text).toContain("Alice");
      expect(recovered.text).toContain("new_vendor_field_0");
      expect(leakedRun(JSON.stringify(recovered), SECRET)).toBeUndefined();
      expect(authenticated).toBeGreaterThanOrEqual(5);
    } finally {
      await session?.close();
      await deployment?.close();
      await vendor?.stop();
      await server?.close();
      if (!vendor) unregisterFakeRoute(secret);
    }
  }, 30_000);
}
