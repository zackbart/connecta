import { describe, expect, it } from "vitest";
import { chargeConnectorCall } from "../src/call-admission-context.js";
import { recordRecovery, recoveryFor } from "../src/call-recovery.js";
import { callerOf } from "../src/connector-caller.js";
import { api } from "../src/connectors/api.js";
import { deriveContext } from "../src/derived-context.js";
import { ConnectorCallError } from "../src/errors.js";
import { createMetaTools } from "../src/meta-tools.js";
import { redactSentSecrets, sentSecretsFor } from "../src/sent-secrets.js";
import type { ConnectorContext } from "../src/types.js";
import { makeRegistry, required } from "./helpers.js";

const BASE = "https://connecta.test";
const SECRET = "derived-context-secret-0123456789";

function connector(handler: (ctx: ConnectorContext) => Promise<unknown>) {
  return api("crm", {
    callAdmission: { rules: [{ budget: { kind: "rolling-window", maxCalls: 2, windowMs: 60_000 } }] },
    tools: [
      { name: "read", description: "Read", annotations: { readOnlyHint: true }, handler: (_args, ctx) => handler(ctx) },
      {
        name: "write",
        description: "Write",
        annotations: { readOnlyHint: false },
        handler: (_args, ctx) => handler(ctx),
      },
    ],
  });
}

describe("derived connector contexts", () => {
  it("INV-4 INV-5 INV-9: a derived context keeps its origin's caller, recovery facts, and sent secrets, both ways", () => {
    const registry = makeRegistry([connector(async () => ({}))]);
    const caller = {
      identity: { actor: { kind: "user", id: "alice" }, interactive: true },
      authenticated: true,
      pool: "crm",
    };
    const origin = registry.contextFor("crm", BASE, {}, {}, { connectorIds: "all", caller });
    const derived = deriveContext(origin, { signal: new AbortController().signal });
    const twice = deriveContext(derived, { allowAuthorization: true });

    expect(derived).not.toBe(origin);
    expect(derived.requestScope).toBe(origin.requestScope);
    expect(callerOf(derived)).toBe(caller);
    expect(callerOf(twice)).toBe(caller);

    // Facts recorded through a copy, after it was made, reach the invocation's context.
    recordRecovery(twice, { idempotencyKey: "key-1" });
    expect(recoveryFor(origin)).toEqual({ idempotencyKey: "key-1" });

    // A credential a copy sent is redacted wherever the origin's output is.
    sentSecretsFor(derived).add(SECRET);
    expect(redactSentSecrets(origin, `echo ${SECRET}`)).not.toContain(SECRET);

    // A context outside an invocation keeps itself as its request scope.
    const bare: ConnectorContext = { storage: origin.storage, logger: origin.logger, baseUrl: BASE };
    expect(deriveContext(bare, {}).requestScope).toBe(bare);
  });

  it("INV-9: api() hands handlers a derived context that charges the call's permit and reports its recovery facts", async () => {
    let seen: ConnectorContext | undefined;
    const registry = makeRegistry([
      connector(async (ctx) => {
        seen = ctx;
        const copy = deriveContext(ctx, {});
        // The second charge spends the enclosing call's permit, so a third is refused.
        await chargeConnectorCall(copy);
        recordRecovery(copy, { idempotencyKey: "key-2" });
        sentSecretsFor(copy).add(SECRET);
        throw new ConnectorCallError("timeout", `Lost the reply that quoted ${SECRET}.`);
      }),
    ]);
    const mt = createMetaTools(registry, BASE);
    const result = await mt.callDestructiveTool({ address: "crm.write" });
    const text = result.content[0]!.text;
    expect(text).not.toContain(SECRET);
    const failed = JSON.parse(text) as { error: { code: string; uncertainCall?: { recovery?: unknown } } };
    expect(failed.error.code).toBe("write_outcome_unknown");
    expect(failed.error.uncertainCall?.recovery).toEqual({ idempotencyKey: "key-2" });
    expect(registry.callAdmissionSnapshot()["crm"]).toMatchObject({ totals: { admitted: 2 } });
    expect("fetch" in required(seen)).toBe(true);
  });

  it("INV-9: api() never mutates the registry's context, and facts recorded on the handler's copy reach it", async () => {
    const crm = connector(async (ctx) => ({ handed: ctx }));
    const origin = makeRegistry([crm]).contextFor("crm", BASE);
    const { handed } = (await crm.callTool("read", {}, origin)) as { handed: ConnectorContext };
    expect(handed).not.toBe(origin);
    expect("fetch" in handed).toBe(true);
    expect("fetch" in origin).toBe(false);
    recordRecovery(handed, { idempotencyKey: "key-3" });
    expect(recoveryFor(origin)).toEqual({ idempotencyKey: "key-3" });
  });
});
