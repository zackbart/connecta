/** An OAuth service and sign-in directory used only by loopback eval deployments. */
import { ConnectorCallError, type Connector, type InboundAuth } from "@zackbart/connecta";
import type { Ledger } from "./service.js";

export class FakeOAuth {
  connected = false;
  starts = 0;
  visits = 0;
  readonly token = "eval-human-token";
  constructor(private readonly ledger: Ledger) {}

  inbound(): InboundAuth {
    const matches = (r: Request) => r.headers.get("authorization") === `Bearer ${this.token}` ||
      r.headers.get("cookie") === `__session=${this.token}`;
    return {
      kind: "clerk", interactiveOperator: true, activityActorNamespace: "https://eval-directory.test",
      uiAuth: { kind: "clerk", publishableKey: "pk_test_fake", frontendApiUrl: "https://eval-directory.test" },
      recognizesCredential: matches,
      authorize: r => matches(r) ? { ok: true, userId: "eval-human" } :
        { ok: false, response: new Response("Unauthorized", { status: 401 }) },
    };
  }

  connector(): Connector {
    return {
      id: "oauth", title: "OAuth invoice service", kind: "api",
      listTools: async () => [{ name: "get_balance", description: "Read Northwind's outstanding balance",
        inputSchema: { type: "object", properties: { customer: { type: "string", const: "Northwind" } }, required: ["customer"] },
        annotations: { readOnlyHint: true } }],
      status: async () => ({ state: this.connected ? "ok" : "auth_required" }),
      startAuth: async () => {
        this.starts += 1;
        // No real consent URL or third-party request. Opening /connect is
        // the operator's consent for this deterministic service.
        this.connected = true;
        return { state: "ok" };
      },
      callTool: async (_tool, args) => {
        if (!this.connected) throw new ConnectorCallError("auth_required", "Connect the fake invoice service");
        this.ledger.calls.push({ seq: this.ledger.next(), at: Date.now(), service: "oauth", tool: "get_balance",
          args: args as Record<string, unknown>, kind: "read", outcome: "ok", resultBytes: 100 });
        return { customer: "Northwind", outstandingUsd: 5650.50, invoiceIds: ["in_1002", "in_1003", "in_1005"] };
      },
    };
  }
}
