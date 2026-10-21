import { describe, expect, it, vi } from "vitest";
import { authorizingContext } from "../src/auth/downstream-oauth.js";
import { attachCallAdmission, chargeConnectorCall } from "../src/call-admission-context.js";
import { attachCallClassification, callClassification } from "../src/call-classification.js";
import { recordRecovery, recoveryFor } from "../src/call-recovery.js";
import {
  attachCatalogCache,
  catalogExpiry,
  catalogFetchedAt,
  observeCatalogExpiry,
  observeCatalogFetch,
  observeCompletedCatalogRefresh,
  type CompletedCatalogRefresh,
} from "../src/catalog-cache.js";
import { callerOf, type ConnectorCaller } from "../src/connector-caller.js";
import { api } from "../src/connectors/api.js";
import { encryptedCredentialVault } from "../src/credentials.js";
import { deriveContext } from "../src/derived-context.js";
import { ConnectorCallError } from "../src/errors.js";
import { createMetaTools } from "../src/meta-tools.js";
import { attachOAuthPartition, oauthPartitionFor } from "../src/oauth-partition.js";
import { attachOAuthSealer, oauthSealerFor, type OAuthStateSealer } from "../src/oauth-sealing.js";
import { Registry } from "../src/registry.js";
import { redactSentSecrets, sentSecretsFor } from "../src/sent-secrets.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { ConnectorContext } from "../src/types.js";
import { CREDENTIAL_KEY } from "./fixtures/ui.js";
import { makeRegistry, required, silentLogger } from "./helpers.js";

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

  /** A caller as a pool view hands one to the registry. */
  const caller = (id: string): ConnectorCaller =>
    ({ identity: { actor: { kind: "user", id }, interactive: true }, authenticated: true, pool: "crm" }) as never;
  const refresh: CompletedCatalogRefresh = {
    connectorId: "crm",
    digest: "next",
    previous: [{ name: "a", fact: "1" }],
    next: [{ name: "a", fact: "2" }],
    private: false,
  };
  const sealer = (): OAuthStateSealer => ({ seal: async () => "sealed", open: async () => "opened", warn() {} });
  const catalogPolicy = (onCompletedCatalogRefresh: () => void = () => {}, maxTtlMs = 10_000) => ({
    storage: memoryStorage(),
    partition: "policy",
    defaultTtlMs: 1_000,
    minTtlMs: 0,
    maxTtlMs,
    onCompletedCatalogRefresh,
  });

  /**
   * One row per side table a derived context must share: recording a fresh
   * value through one copy is read back through a sibling copy and through
   * the origin. A table that stops keying through `contextKey` on either its
   * write or its read fails its row.
   */
  const tables: Array<{
    table: string;
    check: (origin: ConnectorContext, writer: ConnectorContext, reader: ConnectorContext) => Promise<void>;
  }> = [
    {
      table: "admission permit",
      check: async (origin, writer, reader) => {
        const registry = makeRegistry([connector(async () => ({}))]);
        // One call admitted out of a budget of two: one auxiliary charge fits, a second is refused.
        attachCallAdmission(writer, await registry.admitCall("crm", { toolName: "read", args: {} }));
        await chargeConnectorCall(reader);
        await expect(chargeConnectorCall(origin)).rejects.toBeDefined();
      },
    },
    {
      table: "call classification",
      check: async (origin, writer, reader) => {
        attachCallClassification(writer, "write");
        expect(callClassification(reader)).toBe("write");
        expect(callClassification(origin)).toBe("write");
      },
    },
    {
      table: "OAuth owner partition",
      check: async (origin, writer, reader) => {
        const partition = {};
        attachOAuthPartition(writer, partition);
        expect(oauthPartitionFor(reader)).toBe(partition);
        expect(oauthPartitionFor(origin)).toBe(partition);
      },
    },
  ];

  it.each(tables)(
    "INV-4 INV-5 INV-9: $table recorded through one derived copy is read through a sibling and the origin",
    async ({ check }) => {
      const registry = makeRegistry([connector(async () => ({}))]);
      const origin = registry.contextFor("crm", BASE, {}, {}, { connectorIds: "all", caller: caller("alice") });
      const nested = deriveContext(deriveContext(origin, {}), { allowAuthorization: true });
      await check(origin, nested, deriveContext(origin, { signal: new AbortController().signal }));
    },
  );

  it("INV-4 INV-5: an authorizing context keeps the registry's catalog policy, OAuth sealer, owner partition, and caller", async () => {
    const storage = memoryStorage();
    const recordChange = vi.fn();
    const registry = new Registry([connector(async () => ({}))], {
      storage,
      logger: silentLogger,
      credentialVault: encryptedCredentialVault(storage, CREDENTIAL_KEY),
      catalogDriftActivity: {
        recordChange,
        sink: { record: () => {} },
        serverInfo: { name: "test", version: "1" },
      },
    });
    const alice = caller("alice");
    const origin = registry.contextFor("crm", BASE, {}, {}, { connectorIds: "all", caller: alice });
    const authorizing = authorizingContext(origin);

    expect(authorizing.allowAuthorization).toBe(true);
    expect(authorizing.requestScope).toBe(origin.requestScope);
    expect(callerOf(authorizing)).toBe(alice);
    expect(oauthSealerFor(origin)).toBeDefined();
    expect(oauthSealerFor(authorizing)).toBe(oauthSealerFor(origin));
    expect(oauthPartitionFor(origin)).toBeDefined();
    expect(oauthPartitionFor(authorizing)).toBe(oauthPartitionFor(origin));
    // A health connect's catalog refresh reaches the registry's drift hook.
    await observeCompletedCatalogRefresh(authorizing, refresh);
    expect(recordChange).toHaveBeenCalledOnce();
    expect(recordChange.mock.calls[0]![1]).toMatchObject({ connectorId: "crm" });
  });

  it("INV-4 INV-5: state recorded for one caller never appears in a context derived for another", async () => {
    const registry = makeRegistry([connector(async () => ({}))]);
    // The same request scope, even: isolation is by origin, not by request.
    const requestScope = {};
    const alice = caller("alice");
    const bob = caller("bob");
    const forAlice = registry.contextFor("crm", BASE, requestScope, {}, { connectorIds: "all", caller: alice });
    const forBob = registry.contextFor("crm", BASE, requestScope, {}, { connectorIds: "all", caller: bob });
    const aliceCopy = deriveContext(forAlice, {});
    const bobCopy = deriveContext(forBob, {});
    const bobSealer = oauthSealerFor(bobCopy);
    const bobPartition = oauthPartitionFor(bobCopy);
    const bobSecrets = sentSecretsFor(bobCopy);

    const observed = vi.fn();
    attachCallAdmission(aliceCopy, await registry.admitCall("crm", { toolName: "read", args: {} }));
    recordRecovery(aliceCopy, { idempotencyKey: "alice-key" });
    attachCallClassification(aliceCopy, "write");
    attachOAuthSealer(aliceCopy, sealer());
    attachOAuthPartition(aliceCopy, {});
    attachCatalogCache(aliceCopy, catalogPolicy(observed));
    observeCatalogFetch(aliceCopy, 1_234);
    observeCatalogExpiry(aliceCopy, "tools/list", 2_000);
    sentSecretsFor(aliceCopy).add(SECRET);

    expect(callerOf(bobCopy)).toBe(bob);
    expect(recoveryFor(bobCopy)).toBeUndefined();
    expect(callClassification(bobCopy)).toBeUndefined();
    expect(oauthSealerFor(bobCopy)).toBe(bobSealer);
    expect(oauthPartitionFor(bobCopy)).toBe(bobPartition);
    expect(catalogFetchedAt(bobCopy)).toBeUndefined();
    expect(catalogExpiry(bobCopy)).toBeUndefined();
    expect(sentSecretsFor(bobCopy)).toBe(bobSecrets);
    expect(sentSecretsFor(bobCopy)).not.toBe(sentSecretsFor(aliceCopy));
    await observeCompletedCatalogRefresh(bobCopy, refresh);
    expect(observed).not.toHaveBeenCalled();
    // Bob's context holds no permit of Alice's to charge.
    await chargeConnectorCall(bobCopy);
    await chargeConnectorCall(bobCopy);
    await chargeConnectorCall(bobCopy);
  });
});
