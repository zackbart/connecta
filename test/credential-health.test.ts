import { describe, expect, it } from "vitest";
import { bearerToken } from "../src/auth/bearer.js";
import {
  CredentialVault,
  STORED_CREDENTIAL_SHAPE_MISMATCH_ERROR,
} from "../src/credentials.js";
import { createConnecta } from "../src/index.js";
import { createMetaTools } from "../src/meta-tools.js";
import { Registry, ScopedRegistry } from "../src/registry.js";
import { memoryStorage } from "../src/storage/memory.js";
import { resolveToolkits } from "../src/toolkits.js";
import { withTimeout } from "../src/timeout.js";
import type {
  Connector,
  ConnectorStatus,
  ConnectorStatusState,
} from "../src/types.js";
import { makeRegistry, silentLogger } from "./helpers.js";

const BASE = "https://connecta.test";
const TOKEN = "test-token-123";
const KEY = Buffer.alloc(32, 9).toString("base64");

function textOf(result: { content: { text: string }[] }): any {
  return JSON.parse(result.content[0].text);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Calls {
  status: number;
  listTools: number;
  callTool: number;
  test: number;
}

type GrantConnector = Connector & {
  calls: Calls;
  /** What status() reports — flip it to simulate a revoked or restored grant. */
  state: ConnectorStatusState;
  /** Whether a downstream grant is stored at all. */
  stored: boolean;
};

/**
 * A downstream-OAuth-shaped connector: it holds a stored grant and answers
 * `status()`. `remoteMcp({ auth: { type: "oauth" } })` is the real thing; this
 * stub is the same contract with counters, so a test can prove a check never
 * reached `listTools`/`callTool`.
 */
function grantConnector(id = "linear"): GrantConnector {
  const connector: GrantConnector = {
    id,
    kind: "mcp",
    description: "Linear — issues",
    calls: { status: 0, listTools: 0, callTool: 0, test: 0 },
    state: "ok",
    stored: true,
    async hasStoredCredential() {
      return connector.stored;
    },
    async status(): Promise<ConnectorStatus> {
      connector.calls.status++;
      if (connector.state === "ok") return { state: "ok" };
      if (connector.state === "auth_required") {
        return {
          state: "auth_required",
          authorizationUrl: "https://auth.example/authorize?x=1",
          message: "Authorization required — open the URL to connect.",
        };
      }
      return { state: "error", message: "downstream unreachable" };
    },
    async listTools() {
      connector.calls.listTools++;
      return [
        { name: "search", description: "Search issues", annotations: { readOnlyHint: true } },
      ];
    },
    async callTool() {
      connector.calls.callTool++;
      return { ok: true };
    },
  };
  return connector;
}

type VaultConnector = Connector & { calls: Calls; valid: boolean };

/**
 * An operator-managed single-value credential in the vault, checked via the hook
 * that shape selects — `testCredential` (issue #55).
 */
function vaultConnector(id = "resend"): VaultConnector {
  const connector: VaultConnector = {
    id,
    kind: "api",
    description: "Resend — email",
    calls: { status: 0, listTools: 0, callTool: 0, test: 0 },
    valid: true,
    credential: { label: "API token" },
    async testCredential(value) {
      connector.calls.test++;
      expect(value).toBe("token-abcdefghij");
      return connector.valid
        ? { ok: true, message: "Token accepted." }
        : { ok: false, message: "Token was revoked." };
    },
    async listTools() {
      connector.calls.listTools++;
      return [];
    },
    async callTool() {
      connector.calls.callTool++;
      return null;
    },
  };
  return connector;
}

/** A registry over `connectors` that shares one store with a credential vault. */
function vaultRegistry(
  connectors: Connector[],
  opts: Parameters<typeof makeRegistry>[1] = {},
): { registry: Registry; vault: CredentialVault } {
  const storage = memoryStorage();
  const vault = new CredentialVault(storage, KEY);
  return {
    vault,
    registry: makeRegistry(connectors, {
      ...opts,
      storage,
      credentialVault: vault,
    }),
  };
}

function cachedEntry(payload: any, id: string): any {
  return payload.connectors.find((c: any) => c.id === id);
}

/** `list_connectors({ probe: false })` — the cheap, cached status read. */
async function cachedStatus(registry: Registry, id: string): Promise<any> {
  const mt = createMetaTools(registry, BASE);
  return cachedEntry(textOf(await mt.listConnectors({ probe: false })), id);
}

describe("credential liveness checks", () => {
  it("keeps the verdict when best-effort scope teardown throws", async () => {
    const linear = grantConnector();
    let closes = 0;
    linear.closeScope = async () => {
      closes++;
      throw new Error("teardown failed");
    };
    const registry = makeRegistry([linear]);

    const [outcome] = await registry.checkCredentialHealth(BASE);

    expect(outcome).toMatchObject({
      connectorId: "linear",
      record: { state: "ok" },
    });
    expect(closes).toBe(1);
  });

  it("bounds a never-settling teardown and clears in-flight state", async () => {
    const linear = grantConnector();
    let closes = 0;
    linear.closeScope = async () => {
      closes++;
      await new Promise<never>(() => {});
    };
    const registry = makeRegistry([linear]);

    const first = await withTimeout(
      registry.checkCredentialHealth(BASE),
      1_000,
      "credential check with hung teardown",
    );
    const second = await withTimeout(
      registry.checkCredentialHealth(BASE, { force: true }),
      1_000,
      "forced credential check after hung teardown",
    );

    expect(first[0]).toMatchObject({ record: { state: "ok" } });
    expect(second[0]).toMatchObject({ record: { state: "ok" } });
    expect(linear.calls.status).toBe(2);
    expect(closes).toBe(2);
  });

  it("flips a revoked grant to auth_required on the cached read, with no tool call", async () => {
    const linear = grantConnector();
    const registry = makeRegistry([linear]);

    // Healthy to begin with: the check verifies the grant and says nothing is
    // wrong, so the cached read reports ok rather than "unknown".
    const healthy = await registry.checkCredentialHealth(BASE);
    expect(healthy).toEqual([
      {
        connectorId: "linear",
        record: { state: "ok", checkedAt: expect.any(String) },
        latencyMs: expect.any(Number),
      },
    ]);
    expect((await cachedStatus(registry, "linear")).status).toBe("ok");

    // The grant is revoked downstream. Nothing has called the connector.
    linear.state = "auth_required";
    const [outcome] = await registry.checkCredentialHealth(BASE, {
      force: true,
    });
    expect(outcome.record).toMatchObject({
      state: "auth_required",
      authorizationUrl: "https://auth.example/authorize?x=1",
    });

    const entry = await cachedStatus(registry, "linear");
    expect(entry.status).toBe("auth_required");
    expect(entry.authorizationUrl).toBe("https://auth.example/authorize?x=1");
    expect(entry.message).toBe(
      "Authorization required — open the URL to connect.",
    );
    expect(entry.credentialCheck).toMatchObject({ state: "auth_required" });
    // The discovery of the dead credential cost no downstream tool call and no
    // catalog fetch — that is the whole point of the feature.
    expect(linear.calls.callTool).toBe(0);
    expect(linear.calls.listTools).toBe(0);
  });

  it("flips back when the credential is restored, without a restart", async () => {
    const linear = grantConnector();
    linear.state = "auth_required";
    const registry = makeRegistry([linear]);
    await registry.checkCredentialHealth(BASE);
    expect((await cachedStatus(registry, "linear")).status).toBe(
      "auth_required",
    );

    linear.state = "ok";
    await registry.checkCredentialHealth(BASE, { force: true });

    const entry = await cachedStatus(registry, "linear");
    expect(entry.status).toBe("ok");
    expect(entry.credentialCheck).toMatchObject({ state: "ok" });
    expect(entry.authorizationUrl).toBeUndefined();
  });

  it("clears the verdict when re-authorization completes, so recovery needs no check", async () => {
    const linear = grantConnector();
    linear.state = "auth_required";
    const registry = makeRegistry([linear]);
    await registry.checkCredentialHealth(BASE);
    expect((await cachedStatus(registry, "linear")).status).toBe(
      "auth_required",
    );

    // What /oauth/callback/<id> does once finishAuth succeeds.
    await registry.clearCredentialHealth("linear");

    const entry = await cachedStatus(registry, "linear");
    expect(entry.credentialCheck).toBeUndefined();
    expect(entry.status).toBe("unknown");
  });

  it("rate-limits repeated checks: one downstream probe per interval", async () => {
    const linear = grantConnector();
    const registry = makeRegistry([linear]);

    await registry.checkCredentialHealth(BASE);
    const second = await registry.checkCredentialHealth(BASE);
    const third = await registry.checkCredentialHealth(BASE);

    expect(linear.calls.status).toBe(1);
    expect(second[0]).toMatchObject({ skipped: "fresh" });
    expect(second[0].record).toMatchObject({ state: "ok" });
    expect(third[0]).toMatchObject({ skipped: "fresh" });

    // Repeated status READS never probe either, however many there are.
    await cachedStatus(registry, "linear");
    await cachedStatus(registry, "linear");
    expect(linear.calls.status).toBe(1);

    // Past the interval it checks again — the limit is a rate, not a one-shot.
    const brief = makeRegistry([linear], {
      credentialHealth: { intervalSeconds: 0.02 },
    });
    await brief.checkCredentialHealth(BASE);
    await sleep(30);
    await brief.checkCredentialHealth(BASE);
    expect(linear.calls.status).toBe(3);
  });

  it("never probes a connector that stores no credential of ours", async () => {
    const linear = grantConnector();
    linear.stored = false;
    const plain: Connector & { calls: Calls } = {
      id: "calc",
      kind: "api",
      description: "Calculator",
      calls: { status: 0, listTools: 0, callTool: 0, test: 0 },
      async status() {
        this.calls.status++;
        return { state: "ok" };
      },
      async listTools() {
        return [];
      },
      async callTool() {
        return null;
      },
    };
    const registry = makeRegistry([linear, plain]);

    const results = await registry.checkCredentialHealth(BASE);

    expect(results).toEqual([
      { connectorId: "linear", skipped: "no_credential" },
      { connectorId: "calc", skipped: "not_checkable" },
    ]);
    expect(linear.calls.status).toBe(0);
    expect(plain.calls.status).toBe(0);
    // A skip records nothing, so the cached read is unchanged.
    expect(
      (await cachedStatus(registry, "linear")).credentialCheck,
    ).toBeUndefined();
  });

  it("adds no storage reads to a cached status read that cannot have a verdict", async () => {
    const reads: string[] = [];
    const inner = memoryStorage();
    const storage = {
      get: (k: string) => {
        reads.push(k);
        return inner.get(k);
      },
      set: inner.set,
      delete: inner.delete,
    };
    const calc: Connector = {
      id: "calc",
      kind: "api",
      description: "Calculator",
      async listTools() {
        return [];
      },
      async callTool() {
        return null;
      },
    };
    const registry = makeRegistry([calc], { storage });

    await cachedStatus(registry, "calc");
    await cachedStatus(registry, "calc");

    // Only a connector holding a credential of ours can have a verdict, so the
    // fast inventory path stays exactly as cheap as it was without this feature.
    expect(reads.filter((k) => k.startsWith("credhealth:"))).toEqual([]);
  });

  it("checks a vault credential with the connector's own test hook", async () => {
    const resend = vaultConnector();
    const { registry, vault } = vaultRegistry([resend]);

    // Nothing stored yet: there is no credential whose liveness is in question.
    expect(await registry.checkCredentialHealth(BASE)).toEqual([
      { connectorId: "resend", skipped: "no_credential" },
    ]);
    expect(resend.calls.test).toBe(0);

    await vault.set("resend", "token-abcdefghij", "user_1");
    const [ok] = await registry.checkCredentialHealth(BASE);
    expect(ok.record).toMatchObject({ state: "ok", message: "Token accepted." });

    resend.valid = false;
    const [revoked] = await registry.checkCredentialHealth(BASE, {
      force: true,
    });
    expect(revoked.record).toMatchObject({
      state: "auth_required",
      message: "Token was revoked.",
    });
    // No consent URL exists for a vault credential — /ui's form replaces it.
    expect(revoked.record?.authorizationUrl).toBeUndefined();
    expect(resend.calls.callTool).toBe(0);

    const entry = await cachedStatus(registry, "resend");
    expect(entry.status).toBe("auth_required");
    expect(entry.message).toBe("Token was revoked.");
  });

  it("replaces a fresh ok verdict when named storage drifts to a single declaration", async () => {
    const calls = { status: 0, listTools: 0, callTool: 0, test: 0 };
    const connector: Connector = {
      id: "drift",
      kind: "api",
      description: "Shape drift",
      credential: { label: "API token" },
      async testCredential() {
        calls.test++;
        return { ok: true };
      },
      async status() {
        calls.status++;
        return { state: "ok" };
      },
      async listTools() {
        calls.listTools++;
        return [];
      },
      async callTool() {
        calls.callTool++;
        return null;
      },
    };
    const { registry, vault } = vaultRegistry([connector]);
    await vault.setAll(
      "drift",
      { email: "operator@example.com", apiKey: "old-key" },
      "user_1",
    );
    await registry.recordCredentialHealth("drift", {
      state: "ok",
      checkedAt: new Date().toISOString(),
    });

    const [outcome] = await registry.checkCredentialHealth(BASE);

    expect(outcome).toMatchObject({
      connectorId: "drift",
      record: {
        state: "auth_required",
        message: STORED_CREDENTIAL_SHAPE_MISMATCH_ERROR,
      },
    });
    expect(outcome.skipped).toBeUndefined();
    expect(await registry.credentialHealthFor("drift")).toMatchObject({
      state: "auth_required",
      message: STORED_CREDENTIAL_SHAPE_MISMATCH_ERROR,
    });
    expect(calls.test).toBe(0);
    expect(calls.status).toBe(0);

    // A credential-independent tool could succeed, but it cannot make a
    // missing declared field appear. Drift remains decisive until replacement.
    await sleep(2);
    registry.recordSuccess("drift", 1);
    expect((await cachedStatus(registry, "drift")).status).toBe(
      "auth_required",
    );
  });

  it("replaces a fresh ok verdict when single storage drifts to named fields", async () => {
    const calls = { status: 0, listTools: 0, callTool: 0, test: 0 };
    const connector: Connector = {
      id: "drift",
      kind: "api",
      description: "Shape drift",
      credential: {
        label: "Service credentials",
        fields: [
          { name: "email", label: "Account email" },
          { name: "apiKey", label: "API key" },
        ],
      },
      async testCredentials() {
        calls.test++;
        return { ok: true };
      },
      async status() {
        calls.status++;
        return { state: "ok" };
      },
      async listTools() {
        calls.listTools++;
        return [];
      },
      async callTool() {
        calls.callTool++;
        return null;
      },
    };
    const { registry, vault } = vaultRegistry([connector]);
    await vault.set("drift", "old-single-secret", "user_1");
    await registry.recordCredentialHealth("drift", {
      state: "ok",
      checkedAt: new Date().toISOString(),
    });

    const [outcome] = await registry.checkCredentialHealth(BASE);

    expect(outcome).toMatchObject({
      connectorId: "drift",
      record: {
        state: "auth_required",
        message: STORED_CREDENTIAL_SHAPE_MISMATCH_ERROR,
      },
    });
    expect(outcome.skipped).toBeUndefined();
    expect(await registry.credentialHealthFor("drift")).toMatchObject({
      state: "auth_required",
      message: STORED_CREDENTIAL_SHAPE_MISMATCH_ERROR,
    });
    expect(calls.test).toBe(0);
    expect(calls.status).toBe(0);
  });

  it("checks a stored superset of the declared fields like any other credential", async () => {
    const calls = { status: 0, test: 0 };
    let seen: Record<string, string> | undefined;
    // The redeploy in issue #79's review: `email` was dropped from the
    // declaration, the vault still holds it, and `apiKey` still works.
    const connector: Connector = {
      id: "superset",
      kind: "api",
      description: "Dropped a field",
      credential: {
        label: "Service credentials",
        fields: [{ name: "apiKey", label: "API key" }],
      },
      async testCredentials(values) {
        calls.test++;
        seen = values;
        return { ok: true, message: "Key accepted." };
      },
      async status() {
        calls.status++;
        return { state: "ok" };
      },
      async listTools() {
        return [];
      },
      async callTool() {
        return null;
      },
    };
    const { registry, vault } = vaultRegistry([connector]);
    await vault.setAll(
      "superset",
      { email: "operator@example.com", apiKey: "live-key-abcdefghij" },
      "user_1",
    );

    const [outcome] = await registry.checkCredentialHealth(BASE);

    expect(outcome).toMatchObject({
      connectorId: "superset",
      record: { state: "ok", message: "Key accepted." },
    });
    expect(calls.test).toBe(1);
    // The hook is handed what the vault actually holds — the same set
    // `ctx.credential.getAll()` gives the connector during a real call.
    expect(seen).toEqual({
      email: "operator@example.com",
      apiKey: "live-key-abcdefghij",
    });
    expect(await registry.credentialHealthFor("superset")).toMatchObject({
      state: "ok",
    });
  });

  it("charges a repeated drift verdict to the freshness budget instead of a write", async () => {
    const writes: string[] = [];
    const inner = memoryStorage();
    const storage = {
      get: (k: string) => inner.get(k),
      set: (k: string, v: string) => {
        writes.push(k);
        return inner.set(k, v);
      },
      delete: (k: string) => inner.delete(k),
    };
    const vault = new CredentialVault(storage, KEY);
    const connector: Connector = {
      id: "drift",
      kind: "api",
      description: "Shape drift",
      credential: { label: "API token" },
      async testCredential() {
        return { ok: true };
      },
      async listTools() {
        return [];
      },
      async callTool() {
        return null;
      },
    };
    const registry = makeRegistry([connector], {
      storage,
      credentialVault: vault,
    });
    await vault.setAll(
      "drift",
      { email: "operator@example.com", apiKey: "old-key" },
      "user_1",
    );
    // The drift verdict this sweep would form, already stored and stamped two
    // minutes ago: past MIN_WRITE_GAP_MS, so only the freshness gate can stop
    // the write. Drift is a durable reconfiguration state; re-settling it on
    // every sweep in every isolate would bill a metered write for nothing.
    await registry.recordCredentialHealth("drift", {
      state: "auth_required",
      checkedAt: new Date(Date.now() - 120_000).toISOString(),
      message: STORED_CREDENTIAL_SHAPE_MISMATCH_ERROR,
    });
    writes.length = 0;

    const [outcome] = await registry.checkCredentialHealth(BASE);

    expect(outcome).toMatchObject({
      connectorId: "drift",
      skipped: "fresh",
      record: {
        state: "auth_required",
        message: STORED_CREDENTIAL_SHAPE_MISMATCH_ERROR,
      },
    });
    expect(writes.filter((k) => k.startsWith("credhealth:"))).toEqual([]);
    // `force` is still the operator's override, and still re-settles.
    const [forced] = await registry.checkCredentialHealth(BASE, {
      force: true,
    });
    expect(forced.skipped).toBeUndefined();
    expect(writes.filter((k) => k.startsWith("credhealth:"))).toEqual([
      "credhealth:drift",
    ]);
  });

  it("reports a credential it can no longer decrypt as auth_required", async () => {
    const resend = vaultConnector();
    const storage = memoryStorage();
    const written = new CredentialVault(storage, KEY);
    await written.set("resend", "token-abcdefghij", "user_1");
    // Key rotation without re-entering the credential: the stored bytes are
    // unreadable, which is a dead credential however it got that way.
    const rotated = new CredentialVault(storage, Buffer.alloc(32, 3).toString("base64"));
    const registry = makeRegistry([resend], {
      storage,
      credentialVault: rotated,
    });

    const [outcome] = await registry.checkCredentialHealth(BASE);

    expect(outcome.record).toMatchObject({ state: "auth_required" });
    expect(outcome.record?.message).toMatch(/could not be decrypted/);
    expect(resend.calls.test).toBe(0);
  });

  it("bounds a hung check with a deadline and keeps the sweep moving", async () => {
    const slow = grantConnector("slow");
    slow.status = () => new Promise<ConnectorStatus>(() => {});
    const fast = grantConnector("fast");
    const registry = makeRegistry([slow, fast], {
      credentialHealth: { timeoutMs: 10 },
    });

    const results = await registry.checkCredentialHealth(BASE);

    expect(results[0].record).toMatchObject({ state: "error" });
    expect(results[0].record?.message).toMatch(
      /credential check of "slow" timed out after 10ms/,
    );
    expect(results[1].record).toMatchObject({ state: "ok" });
  });

  it("records a thrown check as an error verdict instead of rejecting", async () => {
    const boom = grantConnector("boom");
    boom.status = async () => {
      throw new Error("kaboom");
    };
    const registry = makeRegistry([boom]);

    const [outcome] = await registry.checkCredentialHealth(BASE);

    expect(outcome.record).toMatchObject({ state: "error", message: "kaboom" });
  });

  it("bounds the fan-out to `concurrency` checks at a time", async () => {
    let inFlight = 0;
    let peak = 0;
    const connectors = Array.from({ length: 9 }, (_, i) => {
      const c = grantConnector(`c${i}`);
      c.status = async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await sleep(5);
        inFlight--;
        return { state: "ok" };
      };
      return c;
    });
    const registry = makeRegistry(connectors, {
      credentialHealth: { concurrency: 3 },
    });

    const results = await registry.checkCredentialHealth(BASE);

    expect(results).toHaveLength(9);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("checks only the named connectors when `ids` is given", async () => {
    const a = grantConnector("a");
    const b = grantConnector("b");
    const registry = makeRegistry([a, b]);

    const results = await registry.checkCredentialHealth(BASE, { ids: ["b"] });

    expect(results.map((r) => r.connectorId)).toEqual(["b"]);
    expect(a.calls.status).toBe(0);
    expect(b.calls.status).toBe(1);
  });

  it("a real-call success retires an older failed verdict", async () => {
    const linear = grantConnector();
    linear.state = "auth_required";
    const registry = makeRegistry([linear]);
    await registry.checkCredentialHealth(BASE);
    expect((await cachedStatus(registry, "linear")).status).toBe(
      "auth_required",
    );

    // A call went through after the check: whatever the check saw, the
    // credential demonstrably works now.
    await sleep(2);
    registry.recordSuccess("linear", 5);

    const entry = await cachedStatus(registry, "linear");
    expect(entry.status).toBe("ok");
    // The verdict is still reported — it is evidence, just no longer decisive.
    expect(entry.credentialCheck).toMatchObject({ state: "auth_required" });
  });

  it("an auth_required verdict outranks even a newer real-call failure", async () => {
    const linear = grantConnector();
    linear.state = "auth_required";
    const registry = makeRegistry([linear]);
    await registry.checkCredentialHealth(BASE);
    // A real call failed AFTER the verdict. Both say something is wrong; only
    // the verdict carries the URL that fixes it, so it stays the reported state
    // and the call failure remains visible as lastError.
    await sleep(2);
    registry.recordFailure("linear", 5, new Error("linear.search failed"));

    const entry = await cachedStatus(registry, "linear");

    expect(entry.status).toBe("auth_required");
    expect(entry.authorizationUrl).toBe("https://auth.example/authorize?x=1");
    expect(entry.lastError).toBe("linear.search failed");
    expect(entry.consecutiveFailures).toBe(1);
  });

  it("an error verdict is reported but never decides the status", async () => {
    const slow = grantConnector("slow");
    const registry = makeRegistry([slow], {
      credentialHealth: { timeoutMs: 10 },
    });
    // A real call succeeded, so this connector demonstrably works...
    registry.recordSuccess("slow", 5);
    // ...and then a check timed out. That is "the check did not complete", not
    // evidence about the credential: a DNS blip or a slow status endpoint must
    // not flip a working connector to error for a whole interval.
    slow.status = () => new Promise<ConnectorStatus>(() => {});
    const [outcome] = await registry.checkCredentialHealth(BASE);
    expect(outcome.record).toMatchObject({ state: "error" });

    const entry = await cachedStatus(registry, "slow");

    expect(entry.status).toBe("ok");
    // Still visible to an operator: checks are failing, even if calls are not.
    expect(entry.credentialCheck).toMatchObject({ state: "error" });
  });

  it("an error verdict does not invent evidence where there was none", async () => {
    const boom = grantConnector("boom");
    boom.status = async () => {
      throw new Error("kaboom");
    };
    const registry = makeRegistry([boom]);
    await registry.checkCredentialHealth(BASE);

    const entry = await cachedStatus(registry, "boom");

    expect(entry.status).toBe("unknown");
    expect(entry.credentialCheck).toMatchObject({
      state: "error",
      message: "kaboom",
    });
  });

  it("keeps a verdict cleared mid-check from resurrecting", async () => {
    let entered!: () => void;
    const arrived = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const linear = grantConnector();
    linear.status = async () => {
      entered();
      await gate;
      return {
        state: "auth_required",
        authorizationUrl: "https://auth.example/authorize?x=1",
      };
    };
    const registry = makeRegistry([linear]);

    const check = registry.checkCredentialHealth(BASE);
    await arrived;
    // The operator finishes consent while the check is still in flight — this is
    // what /oauth/callback and the credential API do.
    await registry.clearCredentialHealth("linear");
    release();
    const [outcome] = await check;

    // The verdict it formed is about a credential that no longer exists, so it
    // is reported to the caller but never stored: no stale auth_required, and
    // no stale consent URL, surviving the re-authorization that fixed it.
    expect(outcome.discarded).toBe(true);
    expect(outcome.record).toMatchObject({ state: "auth_required" });
    expect(await registry.credentialHealthFor("linear")).toBeUndefined();
    expect((await cachedStatus(registry, "linear")).status).toBe("unknown");
  });

  it("stores the verdict when nothing cleared it mid-check", async () => {
    const linear = grantConnector();
    linear.state = "auth_required";
    const registry = makeRegistry([linear]);

    const [outcome] = await registry.checkCredentialHealth(BASE);

    expect(outcome.discarded).toBeUndefined();
    expect(await registry.credentialHealthFor("linear")).toMatchObject({
      state: "auth_required",
    });
  });

  it("reports an id that names no connector instead of silently checking nothing", async () => {
    const linear = grantConnector();
    const registry = makeRegistry([linear]);

    const results = await registry.checkCredentialHealth(BASE, {
      ids: ["linear", "typo"],
    });

    expect(results).toEqual([
      {
        connectorId: "linear",
        record: { state: "ok", checkedAt: expect.any(String) },
        latencyMs: expect.any(Number),
      },
      { connectorId: "typo", skipped: "not_found" },
    ]);
  });

  it("skips a named-field credential the connector can only test as a single value", async () => {
    let tested = 0;
    const multi: Connector = {
      id: "multi",
      kind: "api",
      description: "Multi-field API",
      credential: {
        label: "Service credentials",
        fields: [
          { name: "email", label: "Account email" },
          { name: "apiKey", label: "API key" },
        ],
      },
      // Only the single-value hook: there is no `value` field to hand it.
      async testCredential() {
        tested++;
        return { ok: false, message: "should never run" };
      },
      async listTools() {
        return [];
      },
      async callTool() {
        return null;
      },
    };
    const storage = memoryStorage();
    const vault = new CredentialVault(storage, KEY);
    await vault.setAll(
      "multi",
      { email: "operator@example.com", apiKey: "api-key-1234" },
      "user_1",
    );
    const registry = makeRegistry([multi], { storage, credentialVault: vault });

    const [outcome] = await registry.checkCredentialHealth(BASE);

    // Testing the empty string would record a confident auth_required about a
    // credential nothing examined — the declared shape picks the hook here just
    // as it does in /ui and the credential API (issue #55), and this shape
    // cannot use the one hook implemented.
    expect(outcome).toEqual({ connectorId: "multi", skipped: "not_checkable" });
    expect(tested).toBe(0);
    expect(await registry.credentialHealthFor("multi")).toBeUndefined();
  });

  it("probes named fields with the named-set hook, and the whole set", async () => {
    const seen: Record<string, string>[] = [];
    const multi: Connector = {
      id: "multi",
      kind: "api",
      description: "Multi-field API",
      credential: {
        label: "Service credentials",
        fields: [
          { name: "email", label: "Account email" },
          { name: "apiKey", label: "API key" },
        ],
      },
      async testCredentials(values) {
        seen.push({ ...values });
        return { ok: true, message: "Both fields accepted." };
      },
      async listTools() {
        return [];
      },
      async callTool() {
        return null;
      },
    };
    const storage = memoryStorage();
    const vault = new CredentialVault(storage, KEY);
    const values = { email: "operator@example.com", apiKey: "api-key-1234" };
    await vault.setAll("multi", values, "user_1");
    const registry = makeRegistry([multi], { storage, credentialVault: vault });

    const [outcome] = await registry.checkCredentialHealth(BASE);

    expect(outcome.record).toMatchObject({
      state: "ok",
      message: "Both fields accepted.",
    });
    expect(seen).toEqual([values]);
  });

  it("skips a single-value credential the connector can only test as a set", async () => {
    let tested = 0;
    const single: Connector = {
      id: "single",
      kind: "api",
      description: "Single-value API",
      credential: { label: "API token" },
      // Only the named-set hook. The sweep used to prefer it whenever it
      // existed and hand it `{ value }` — the vault's reserved storage field,
      // not a named set this connector ever declared.
      async testCredentials() {
        tested++;
        return { ok: false, message: "should never run" };
      },
      async listTools() {
        return [];
      },
      async callTool() {
        return null;
      },
    };
    const { registry, vault } = vaultRegistry([single]);
    await vault.set("single", "token-abcdefghij", "user_1");

    const [outcome] = await registry.checkCredentialHealth(BASE);

    // Symmetric with the named-field mismatch above: untestable per the one
    // rule, so skipped rather than probed through a hook the shape cannot use.
    expect(outcome).toEqual({ connectorId: "single", skipped: "not_checkable" });
    expect(tested).toBe(0);
    expect(await registry.credentialHealthFor("single")).toBeUndefined();
  });

  it("probes a single value that declares both hooks with the single-value one", async () => {
    const seen: string[] = [];
    let named = 0;
    const both: Connector = {
      id: "both",
      kind: "api",
      description: "Both hooks",
      credential: { label: "API token" },
      async testCredential(value) {
        seen.push(value);
        return { ok: true, message: "Token accepted." };
      },
      async testCredentials() {
        named++;
        return { ok: true };
      },
      async listTools() {
        return [];
      },
      async callTool() {
        return null;
      },
    };
    const { registry, vault } = vaultRegistry([both]);
    await vault.set("both", "token-abcdefghij", "user_1");

    const [outcome] = await registry.checkCredentialHealth(BASE);

    expect(outcome.record).toMatchObject({ state: "ok" });
    expect(seen).toEqual(["token-abcdefghij"]);
    expect(named).toBe(0);
  });

  it("still probes an untestable shape through status() when it has one", async () => {
    let tested = 0;
    const mismatch: Connector = {
      id: "mismatch",
      kind: "api",
      description: "Named fields, single-value hook, plus status()",
      credential: {
        label: "Service credentials",
        fields: [{ name: "email", label: "Account email" }],
      },
      async testCredential() {
        tested++;
        return { ok: true, message: "should never run" };
      },
      async status() {
        return { state: "auth_required" as const, message: "Grant expired." };
      },
      async listTools() {
        return [];
      },
      async callTool() {
        return null;
      },
    };
    const storage = memoryStorage();
    const vault = new CredentialVault(storage, KEY);
    await vault.setAll("mismatch", { email: "operator@example.com" }, "user_1");
    const registry = makeRegistry([mismatch], {
      storage,
      credentialVault: vault,
    });

    const [outcome] = await registry.checkCredentialHealth(BASE);

    // The unusable hook is skipped, not the connector: `status()` is a question
    // the connector answers about itself, and never involves the shape mismatch.
    expect(outcome.record).toMatchObject({
      state: "auth_required",
      message: "Grant expired.",
    });
    expect(tested).toBe(0);
  });

  it("clamps a verdict stamped in the future so it can age out", async () => {
    const linear = grantConnector();
    const storage = memoryStorage();
    const registry = makeRegistry([linear], { storage });
    // A clock-skewed isolate wrote this. Left alone it would be permanently
    // fresh and permanently newer than any real-call success.
    await storage.set(
      "credhealth:linear",
      JSON.stringify({
        state: "auth_required",
        checkedAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      }),
    );

    const record = await registry.credentialHealthFor("linear");

    expect(Date.parse(record!.checkedAt)).toBeLessThanOrEqual(Date.now());
    // ...and a success recorded now retires it, which the unclamped stamp would
    // have made impossible.
    registry.recordSuccess("linear", 5);
    expect((await cachedStatus(registry, "linear")).status).toBe("ok");
  });
});

describe("liveness verdicts and the live probe", () => {
  it("a probe: true call records the verdict it just observed", async () => {
    const linear = grantConnector();
    linear.state = "auth_required";
    const registry = makeRegistry([linear]);

    const probed = cachedEntry(
      textOf(await createMetaTools(registry, BASE).listConnectors({})),
      "linear",
    );
    expect(probed.status).toBe("auth_required");
    expect(probed.credentialCheck).toMatchObject({ state: "auth_required" });

    // And it counts against the freshness budget: an operator who just probed
    // live is not swept again moments later.
    const [swept] = await registry.checkCredentialHealth(BASE);
    expect(swept).toMatchObject({ skipped: "fresh" });
    expect(linear.calls.status).toBe(1);
  });

  it("records the status observation, never a failing catalog refresh", async () => {
    const linear = grantConnector();
    // The credential is fine — status() says so — but the catalog fetch fails.
    linear.listTools = async () => {
      linear.calls.listTools++;
      throw new Error("linear.search catalog fetch failed");
    };
    const registry = makeRegistry([linear]);

    const probed = cachedEntry(
      textOf(await createMetaTools(registry, BASE).listConnectors({})),
      "linear",
    );

    // The connector is reported unhealthy, from the health log as before...
    expect(probed.status).toBe("error");
    expect(probed.consecutiveFailures).toBe(1);
    // ...but a catalog fetch is not a credential check (the sweep never fetches
    // one), so the verdict records what status() actually observed.
    expect(probed.credentialCheck).toMatchObject({ state: "ok" });
    expect(await registry.credentialHealthFor("linear")).toMatchObject({
      state: "ok",
    });
  });

  it("stamps a probe verdict at observation time, so a success during it still wins", async () => {
    const linear = grantConnector();
    // Timestamp the observation itself rather than measuring the sleep from
    // the outside: setTimeout may fire a hair early, so `start + 10` can
    // overshoot the real observation time by a millisecond.
    let observedAt = 0;
    linear.status = async () => {
      await sleep(10);
      observedAt = Date.now();
      return { state: "auth_required", authorizationUrl: "https://auth.example/a" };
    };
    const registry = makeRegistry([linear]);

    await createMetaTools(registry, BASE).listConnectors({});

    const record = await registry.credentialHealthFor("linear");
    expect(observedAt).toBeGreaterThan(0);
    expect(Date.parse(record!.checkedAt)).toBeGreaterThanOrEqual(observedAt);
  });

  it("keeps a probe of a connector with no stored credential out of the verdicts", async () => {
    const calc: Connector = {
      id: "calc",
      kind: "api",
      description: "Calculator",
      async listTools() {
        return [];
      },
      async callTool() {
        return null;
      },
    };
    const registry = makeRegistry([calc]);

    const probed = cachedEntry(
      textOf(await createMetaTools(registry, BASE).listConnectors({})),
      "calc",
    );

    expect(probed.status).toBe("ok");
    expect(probed.credentialCheck).toBeUndefined();
  });

  it("authorize_connector's answer replaces the verdict that sent the agent there", async () => {
    const linear = grantConnector();
    linear.state = "auth_required";
    linear.startAuth = async () => ({
      state: "ok",
      message: "Already authorized — connection is healthy.",
    });
    const registry = makeRegistry([linear]);
    await registry.checkCredentialHealth(BASE);
    expect((await cachedStatus(registry, "linear")).status).toBe(
      "auth_required",
    );

    await createMetaTools(registry, BASE).authorizeConnector({
      connector: "linear",
    });

    const entry = await cachedStatus(registry, "linear");
    expect(entry.status).toBe("ok");
    expect(entry.credentialCheck).toMatchObject({ state: "ok" });
  });
});

describe("credential health across a toolkit scope", () => {
  it("shows a shared connector's verdict inside the scope and hides it outside", async () => {
    const linear = grantConnector();
    const other = grantConnector("gmail");
    linear.state = "auth_required";
    other.state = "auth_required";
    const base = makeRegistry([linear, other]);
    await base.checkCredentialHealth(BASE);
    const toolkits = resolveToolkits(
      { support: { connectors: ["linear"] } },
      [linear, other],
    )!;
    const scoped = new ScopedRegistry(base, toolkits.get("support")!);

    expect(await scoped.credentialHealthFor("linear")).toMatchObject({
      state: "auth_required",
    });
    expect(await scoped.credentialHealthFor("gmail")).toBeUndefined();

    const entry = cachedEntry(
      textOf(await createMetaTools(scoped, BASE).listConnectors({ probe: false })),
      "linear",
    );
    expect(entry.status).toBe("auth_required");
  });
});

describe("the traffic-triggered sweep", () => {
  function ctxWith(): {
    waitUntil(p: Promise<unknown>): void;
    settled(): Promise<unknown>;
  } {
    const pending: Promise<unknown>[] = [];
    return {
      waitUntil(p) {
        pending.push(p);
      },
      settled: () => Promise.all(pending),
    };
  }

  function deployment(linear: Connector) {
    return createConnecta({
      connectors: [linear],
      auth: bearerToken(TOKEN),
      storage: memoryStorage(),
      publicUrl: BASE,
      logger: silentLogger,
    });
  }

  async function mcpRequest(
    connecta: ReturnType<typeof createConnecta>,
    ctx: unknown,
  ): Promise<Response> {
    return connecta.fetch(
      new Request(`${BASE}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${TOKEN}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        }),
      }),
      undefined,
      ctx,
    );
  }

  it("detects a revoked credential from ordinary /mcp traffic, before any call fails", async () => {
    const linear = grantConnector();
    linear.state = "auth_required";
    const connecta = deployment(linear);
    const ctx = ctxWith();

    const res = await mcpRequest(connecta, ctx);
    expect(res.status).toBe(200);
    await ctx.settled();

    const entry = await cachedStatus(connecta.registry, "linear");
    expect(entry.status).toBe("auth_required");
    expect(linear.calls.callTool).toBe(0);
  });

  it("sweeps once for a burst of requests", async () => {
    const linear = grantConnector();
    const connecta = deployment(linear);
    const ctx = ctxWith();

    await Promise.all([
      mcpRequest(connecta, ctx),
      mcpRequest(connecta, ctx),
      mcpRequest(connecta, ctx),
    ]);
    await ctx.settled();
    await mcpRequest(connecta, ctx);
    await ctx.settled();

    expect(linear.calls.status).toBe(1);
  });

  it("keeps the teardown tail inside the request's waitUntil", async () => {
    let closeStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      closeStarted = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const linear = grantConnector();
    linear.closeScope = async () => {
      closeStarted();
      await gate;
    };
    const connecta = deployment(linear);
    const ctx = ctxWith();

    const res = await mcpRequest(connecta, ctx);
    expect(res.status).toBe(200);
    await started;

    const settled = ctx.settled();
    await expect(
      Promise.race([
        settled.then(() => "settled"),
        Promise.resolve("pending"),
      ]),
    ).resolves.toBe("pending");
    release();
    await expect(settled).resolves.toBeDefined();
  });

  it("stays out of the request when onRequest is off", async () => {
    const linear = grantConnector();
    const connecta = createConnecta({
      connectors: [linear],
      auth: bearerToken(TOKEN),
      storage: memoryStorage(),
      publicUrl: BASE,
      logger: silentLogger,
      credentials: { health: { onRequest: false } },
    });
    const ctx = ctxWith();

    await mcpRequest(connecta, ctx);
    await ctx.settled();

    expect(linear.calls.status).toBe(0);
    // The scheduler-facing entry point still works.
    await connecta.checkCredentials();
    expect(linear.calls.status).toBe(1);
  });

  it("never sweeps for an unauthenticated request", async () => {
    const linear = grantConnector();
    const connecta = deployment(linear);
    const ctx = ctxWith();

    const res = await connecta.fetch(
      new Request(`${BASE}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
      undefined,
      ctx,
    );

    expect(res.status).toBe(401);
    await ctx.settled();
    expect(linear.calls.status).toBe(0);
  });

  it("surfaces the verdict on /ui/data", async () => {
    const linear = grantConnector();
    linear.state = "auth_required";
    const connecta = deployment(linear);
    await connecta.checkCredentials();

    const res = await connecta.fetch(
      new Request(`${BASE}/ui/data`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
    );
    const data = (await res.json()) as any;

    expect(data.connectors[0].credentialCheck).toMatchObject({
      state: "auth_required",
      checkedAt: expect.any(String),
    });
  });

  it("checkCredentials() says what to configure when there is no base URL", async () => {
    const connecta = createConnecta({
      connectors: [grantConnector()],
      auth: bearerToken(TOKEN),
      storage: memoryStorage(),
      logger: silentLogger,
    });

    // Rejects rather than throws: `ctx.waitUntil(...)` and `.catch(...)` — the
    // two ways this is called — cannot see a synchronous throw.
    await expect(connecta.checkCredentials()).rejects.toThrow(/publicUrl/);
    await expect(
      connecta.checkCredentials({ baseUrl: BASE }),
    ).resolves.toHaveLength(1);
  });

  it("never makes the request wait for the sweep", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const linear = grantConnector();
    linear.status = async () => {
      linear.calls.status++;
      await gate;
      return { state: "ok" };
    };
    const connecta = deployment(linear);
    const ctx = ctxWith();

    const res = await mcpRequest(connecta, ctx);

    // Response served while the sweep is still blocked on the downstream.
    expect(res.status).toBe(200);
    const settled = ctx.settled();
    await expect(
      Promise.race([settled.then(() => "settled"), Promise.resolve("pending")]),
    ).resolves.toBe("pending");
    release();
    await settled;
    expect(linear.calls.status).toBe(1);
  });

  it("serves the request normally when the sweep itself throws", async () => {
    const linear = grantConnector();
    const connecta = deployment(linear);
    const warnings: unknown[] = [];
    // A synchronous throw from the trigger — the half a rejected promise does
    // not cover. It must not reach the response.
    connecta.registry.sweepCredentialHealthIfDue = () => {
      warnings.push("called");
      throw new Error("sweep exploded");
    };

    const res = await mcpRequest(connecta, ctxWith());

    expect(res.status).toBe(200);
    expect(warnings).toEqual(["called"]);
  });
});
