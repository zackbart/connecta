import { wrapViewCredentials } from "../src/runtime/call.js";
import { beforeEach as beforeTransportTest } from "vitest";
import { installOwnedTransport } from "./fixtures/owned-transport.js";

beforeTransportTest(() => {
  installOwnedTransport();
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/connectors/api.js";
import { remoteMcp, type RemoteMcpAuth } from "../src/connectors/remote-mcp.js";
import { CatalogService } from "../src/catalog-service.js";
import { ConnectorCallError } from "../src/errors.js";
import { buildSandboxProviders, createExecuteTool } from "../src/execute.js";
import { createMetaTools } from "../src/meta-tools.js";
import { EXECUTE_OUTPUT } from "../src/meta-output.js";
import { InvocationService } from "../src/invocation.js";
import { SentSecrets, sentSecretsFor } from "../src/sent-secrets.js";
import { CredentialVault } from "../src/credentials.js";
import { memoryStorage } from "../src/storage/memory.js";
import { scopes } from "../src/storage/keys.js";
import { seedGrant } from "./fixtures/oauth.js";
import type { Connector, ConnectorContext, Executor } from "../src/types.js";
import { httpDownstream } from "./fixtures/downstream-mcp.js";
import { connectorContext, spyLogger } from "./fixtures/misc.js";
import { modernRequest } from "./fixtures/client-identity.js";
import { readJsonRpc } from "./fixtures/http.js";
import { activitySink, createTestConnecta, makeRegistry, silentLogger } from "./helpers.js";

const BASE = "https://connecta.test";
const SECRET = "zq7-echo/+with=encoding";
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function diagnostic(secret: string): string {
  return `Permission refused: ${secret}; ${encodeURIComponent(secret)}; ${btoa(secret)}.\nAuthorization: Bearer ${secret}\nCookie: session=opaque\nRetry after checking permissions.`;
}

async function exercise(connector: Connector, options: Parameters<typeof makeRegistry>[1] = {}) {
  const logger = spyLogger();
  const registry = makeRegistry([connector], { ...options, logger: logger.logger });
  const activity = activitySink();
  const invocation = new InvocationService(registry, new CatalogService(registry, BASE), activity.activity);
  const outcome = await invocation.invoke(`${connector.id}.read`, {}, { source: "call_tool" });
  const providers = await buildSandboxProviders(registry, BASE, silentLogger);
  const host = providers.find((provider) => provider.name === "connecta")!;
  let failure: any;
  try {
    await host.fns.call!(`${connector.id}.read`, {});
  } catch (error) {
    failure = error;
  }
  expect(outcome).toMatchObject({ ok: false });
  expect(failure).toBeInstanceOf(Error);
  expect(JSON.stringify(outcome)).not.toContain(SECRET);
  expect(failure.message).not.toContain(SECRET);
  expect(JSON.stringify(failure)).not.toContain(SECRET);
  expect(JSON.stringify(failure.cause) ?? "").not.toContain(SECRET);
  expect(JSON.stringify(activity.events)).not.toContain(SECRET);
  expect(logger.warnings().join(" ")).not.toContain(SECRET);
  return { outcome, failure };
}

describe("call-scoped sent credentials", () => {
  it("INV-5: execute_code keeps schema-valid integer hostCalls through the final MCP envelope redaction (#1118)", async () => {
    const called = vi.fn();
    const app = createTestConnecta({
      serverInfo: { name: "examplecorp-connecta", version: "1" },
      logger: silentLogger,
      connectors: [
        {
          id: "notes",
          kind: "api",
          listTools: async () => [{ name: "read", annotations: { readOnlyHint: true } }],
          callTool: async (_name, _args, ctx) => {
            sentSecretsFor(ctx).secret("alice@examplecorp.com");
            called();
            return { count: 10, name: "examplecorp-connecta" };
          },
        },
      ],
      executor: {
        execute: async (_code, providers) => ({ result: await providers[0]!.fns.call!("notes.read", {}) }),
      },
    });
    try {
      const body = await readJsonRpc(
        await app.fetch(
          modernRequest("tools/call", {
            name: "execute_code",
            arguments: { code: 'async () => await connecta.call("notes.read")' },
          }),
        ),
      );
      expect(called).toHaveBeenCalledOnce();
      expect(body.error).toBeUndefined();
      expect(body.result.isError).toBeFalsy();
      expect(body.result.structuredContent).toMatchObject({
        result: { data: { count: 10, name: "[redacted]-connecta" } },
        hostCalls: { attempted: 1, admitted: 1, succeeded: 1, failed: 0 },
      });
      expect((await EXECUTE_OUTPUT["~standard"].validate(body.result.structuredContent)).issues).toBeUndefined();
      expect(JSON.parse(body.result.content[0].text)).toEqual(body.result.structuredContent);
      expect(body.result._meta["io.modelcontextprotocol/serverInfo"].name).toBe("[redacted]-connecta");
    } finally {
      await app.close();
    }
  });

  it("INV-5: copies nested error data and causes without raw, prefixed, encoded or Basic credentials, and withholds a header line whose name or credential prefix a private value took", () => {
    const secrets = new SentSecrets();
    secrets.header(`Basic ${btoa(`account:${SECRET}`)}`);
    const cause = new Error(diagnostic(SECRET));
    const error = Object.assign(new ConnectorCallError("invalid_args", diagnostic(SECRET), { cause }), {
      data: { nested: diagnostic(SECRET), [SECRET]: [cause] },
    });
    const redacted = secrets.redact(error);
    expect(redacted).toBeInstanceOf(ConnectorCallError);
    expect(redacted).not.toBe(error);
    expect(redacted.cause).not.toBe(cause);
    for (const text of [
      redacted.message,
      redacted.stack,
      (redacted.cause as Error).message,
      JSON.stringify(redacted),
    ]) {
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(encodeURIComponent(SECRET));
      expect(text).not.toContain(btoa(SECRET));
      expect(text).not.toContain("session=opaque");
    }
    expect(redacted.message).toContain("Permission refused");
    expect(redacted.message).toContain("Retry after checking permissions");
    expect(error.message).toContain(SECRET);
    // A sensitive header line in an echo is read before the echo replaces anything, so a private
    // value that takes part of its name, its `:` or a credential prefix leaves none of its value:
    // the whole token, every cookie pair, a short tail. A private word opening prose keeps it (#703).
    const scrub = (pin: string, text: string) => {
      const one = new SentSecrets();
      one.arguments({ pin }, { type: "object", properties: { pin: { type: "string", writeOnly: true } } });
      return one.redact(text);
    };
    const token = "sk_live_A7vJp9nR-2tW6qK8c-M4zX1sF5-hL3dB0uY";
    expect(scrub("Authorization: Bearer", `Authorization: Bearer ${token}\nRetry`)).toBe("[redacted]\nRetry");
    expect(scrub("Cookie: public=", "Cookie: public=tracking123456; session=VENDOR_HELD_0003")).toBe("[redacted]");
    expect(scrub(`Authorization: Bearer ${token.slice(0, -7)}`, `Authorization: Bearer ${token}`)).toBe("[redacted]");
    expect(scrub("tion: Be", `Authorization: Bearer ${token}`)).toBe("Authoriza[redacted]");
    expect(scrub("X-Api-", "X-Api-Key: VENDOR_HELD_0002")).toBe("[redacted]Key: [redacted]");
    expect(scrub("Auth", `X-${"a".repeat(300)}Authorization: ${token}`)).toBe(
      `X-${"a".repeat(300)}[redacted]orization: [redacted]`,
    );
    expect(scrub("Auth", `Authorization${" ".repeat(80)}: ${token}`)).toBe(
      `[redacted]orization${" ".repeat(80)}: [redacted]`,
    );
    expect(scrub("hunter22", "hunter22 opens this line")).toBe("[redacted] opens this line");
  });

  it("INV-5: ordinary diagnostics and results keep their text, and plain results their identity", () => {
    const secrets = new SentSecrets();
    secrets.add(SECRET);
    const error = new ConnectorCallError("invalid_args", "The token field requires an ordinary repository name.");
    const result = { content: [{ type: "text", text: "Bearer authentication refused for this repository." }] };
    // An error is always a checked copy of its own class, never the original.
    const safe = secrets.redact(error);
    expect(safe).not.toBe(error);
    expect(safe).toBeInstanceOf(ConnectorCallError);
    expect([safe.code, safe.message, safe.retryable]).toEqual([error.code, error.message, error.retryable]);
    expect(secrets.redact(result)).toBe(result);
  });

  describe("INV-5: a walk repeats unless its object, set, revision and mode are all unchanged", () => {
    type Walker = { project(...args: unknown[]): unknown };
    const walks = (secrets: SentSecrets) => vi.spyOn(secrets as unknown as Walker, "project");
    const frozen = <T>(value: T): T => {
      const pending: unknown[] = [value];
      while (pending.length) {
        const item = pending.pop();
        if (item !== null && typeof item === "object") pending.push(...Object.values(Object.freeze(item)));
      }
      return value;
    };
    const LATER = "later-credential-0123456789";

    it("walks a deeply frozen clean object once per mode, and an open or shallow one every time", () => {
      const secrets = new SentSecrets();
      secrets.add(SECRET);
      const walk = walks(secrets);
      const value = frozen({ rows: [{ text: "ordinary row", count: 3 }] });
      expect(secrets.redact(value)).toBe(value);
      expect(secrets.redact(value)).toBe(value);
      expect(walk).toHaveBeenCalledTimes(1);
      expect(secrets.redact(value, "envelope")).toBe(value);
      expect(secrets.redact(value, "envelope")).toBe(value);
      expect(secrets.redact(value)).toBe(value);
      expect(walk).toHaveBeenCalledTimes(2);
      walk.mockClear();
      const open = { rows: [{ text: "ordinary row" }] };
      const shallow = Object.freeze({ rows: [{ text: "ordinary row" }] });
      const sparse: number[] = [];
      sparse[0] = 1;
      sparse[2] = 3;
      Object.freeze(sparse);
      for (const item of [open, shallow, sparse]) {
        expect(secrets.redact(item)).toBe(item);
        expect(secrets.redact(item)).toBe(item);
      }
      expect(walk).toHaveBeenCalledTimes(6);
    });

    it("walks a retained object again after a registration, a memo write or a minted state, and redacts it", () => {
      const secrets = new SentSecrets();
      const context = new SentSecrets();
      secrets.add(SECRET);
      secrets.include(context);
      const walk = walks(secrets);
      const retained = frozen({ notes: [`echo ${LATER}`], state: "minted-relay-state-0001" });
      const walksOf = () => walk.mock.calls.filter(([root]) => root === retained).length;
      expect(secrets.redactCredentials(retained)).toBe(retained);
      expect(secrets.redactCredentials(retained)).toBe(retained);
      expect(walksOf()).toBe(1);
      secrets.encode(new TextEncoder().encode("ordinary binary content"), { claims: true });
      expect(secrets.redactCredentials(retained)).toBe(retained);
      secrets.mintedState("minted-relay-state-0001");
      expect(secrets.redactCredentials(retained)).toBe(retained);
      expect(walksOf()).toBe(3);
      const revision = secrets.revision;
      context.add(LATER);
      expect(secrets.revision).toBeGreaterThan(revision);
      expect(secrets.redactCredentials(retained)).toEqual({ notes: ["echo [redacted]"], state: retained.state });
      expect(walksOf()).toBe(4);
      const text = `${"Ordinary public notes. ".repeat(200)}${LATER}`;
      const late = new SentSecrets();
      late.add(SECRET);
      const textWalk = walks(late);
      expect(late.redact(text)).toBe(text);
      expect(late.redact(text)).toBe(text);
      expect(textWalk).toHaveBeenCalledTimes(1);
      expect(late.text(text)).toBe(text);
      expect(textWalk).toHaveBeenCalledTimes(2);
      late.add(LATER);
      expect(late.redact(text)).toBe(`${"Ordinary public notes. ".repeat(200)}[redacted]`);
      expect(textWalk).toHaveBeenCalledTimes(3);
    });

    it("never lets a mark made under one set, view or mode satisfy another", () => {
      const first = new SentSecrets();
      first.add(SECRET);
      const second = new SentSecrets();
      second.add(LATER);
      const value = frozen({ text: `echo ${LATER}`, [LATER]: "keyed" });
      expect(first.redact(value)).toBe(value);
      expect(second.redact(value)).toEqual({ text: "echo [redacted]", "[redacted]": "keyed" });
      const same = new SentSecrets();
      same.add(SECRET);
      const walk = walks(same);
      expect(same.redact(value)).toBe(value);
      expect(walk).toHaveBeenCalledOnce();
      expect(second.redact(value, "values")).toEqual({ text: "echo [redacted]", [LATER]: "keyed" });
      const keyed = frozen({ [LATER]: "kept by values mode only" });
      expect(second.redact(keyed, "values")).toBe(keyed);
      expect(second.redact(keyed)).toEqual({ "[redacted]": "kept by values mode only" });
      const withArguments = new SentSecrets();
      withArguments.add(SECRET);
      withArguments.arguments(
        { note: "private-note-0123" },
        { type: "object", properties: { note: { type: "string", writeOnly: true } } },
      );
      const echo = frozen({ text: "private-note-0123" });
      expect(withArguments.redactCredentials(echo)).toBe(echo);
      expect(withArguments.redact(echo)).toEqual({ text: "[redacted]" });
    });

    it("freezes a value Connecta owns only once a walk finds it clean, and marks a changed copy on its next clean walk", () => {
      const secrets = new SentSecrets();
      secrets.add(SECRET);
      const walk = walks(secrets);
      const clean = { content: [{ type: "text", text: "ordinary" }] };
      expect(secrets.redactFrozen(clean)).toBe(clean);
      expect(Object.isFrozen(clean.content[0])).toBe(true);
      expect(secrets.redact(clean)).toBe(clean);
      expect(walk).toHaveBeenCalledTimes(1);
      const echoed = { content: [{ type: "text", text: `echo ${SECRET}` }], meta: { kept: true } };
      const copy = secrets.redactFrozen(echoed);
      expect(copy).toEqual({ content: [{ type: "text", text: "echo [redacted]" }], meta: { kept: true } });
      expect(Object.isFrozen(echoed)).toBe(false);
      expect(Object.isFrozen(copy.content[0]) && Object.isFrozen(copy.meta)).toBe(true);
      expect(secrets.redact(copy)).toBe(copy);
      expect(secrets.redact(copy)).toBe(copy);
      expect(walk).toHaveBeenCalledTimes(3);
    });

    it.each([
      ["Object.prototype", Object.prototype],
      ["Array.prototype", Array.prototype],
    ] as const)("walks a marked value again once %s gains a toJSON", (_name, prototype) => {
      const secrets = new SentSecrets();
      secrets.add(SECRET);
      const value = frozen({ rows: [{ text: "ordinary" }] });
      expect(secrets.redact(value)).toBe(value);
      let redacted: unknown;
      Object.defineProperty(prototype, "toJSON", { value: () => ({ text: SECRET }), configurable: true });
      try {
        redacted = secrets.redact(value);
      } finally {
        delete (prototype as { toJSON?: unknown }).toJSON;
      }
      expect(redacted).not.toBe(value);
      expect(JSON.stringify(redacted)).not.toContain(SECRET);
    });

    it("leaves a value unmarked when a registration lands during its walk", () => {
      const secrets = new SentSecrets();
      secrets.add(SECRET);
      const child = new Proxy(Object.freeze({}), {
        isExtensible(target) {
          secrets.add(LATER);
          return Reflect.isExtensible(target);
        },
      });
      const value = Object.freeze({ [LATER]: child });
      expect(secrets.redact(value)).toBe(value);
      expect(Object.keys(secrets.redact(value))).toEqual(["[redacted]"]);
    });

    it("walks a marked value again after an unregistered value tightens the set", () => {
      const secrets = new SentSecrets();
      secrets.add(SECRET);
      const walk = walks(secrets);
      const value = frozen({ text: "ordinary row" });
      expect(secrets.redact(value)).toBe(value);
      expect(secrets.redact(value)).toBe(value);
      secrets.arguments(
        { note: "x".repeat(524_289) },
        { type: "object", properties: { note: { type: "string", writeOnly: true } } },
      );
      expect(secrets.redact(value)).toEqual({ text: "[redacted]" });
      expect(walk.mock.calls.filter(([root]) => root === value)).toHaveLength(2);
    });

    it("always walks a pass that feeds storage, whatever an earlier pass marked", () => {
      const secrets = new SentSecrets();
      secrets.add(SECRET);
      const walk = walks(secrets);
      const value = frozen({ tools: [{ name: "a", description: "ordinary" }] });
      expect(secrets.redactCredentials(value)).toBe(value);
      expect(secrets.redactCredentials(value)).toBe(value);
      expect(walk.mock.calls.filter(([root]) => root === value)).toHaveLength(1);
      expect(secrets.redactCredentials(value, "store")).toBe(value);
      expect(secrets.redactCredentials(value, "store")).toBe(value);
      expect(walk.mock.calls.filter(([root]) => root === value)).toHaveLength(3);
    });

    it("never marks frozen data holding binary, which every walk copies", () => {
      const secrets = new SentSecrets();
      secrets.add(SECRET);
      const walk = walks(secrets);
      for (const binary of [
        new Uint8Array([1, 2, 3]),
        Object.freeze(new Uint8Array(0)),
        Object.freeze(new DataView(new ArrayBuffer(4))),
        Object.freeze(new ArrayBuffer(4)),
      ]) {
        const value = Object.freeze({ binary });
        expect(secrets.redact(value)).not.toBe(value);
        expect(secrets.redact(value)).not.toBe(value);
        expect(walk.mock.calls.filter(([root]) => root === value)).toHaveLength(2);
      }
    });
  });

  describe("INV-5: a header or query parameter's name never makes its value public", () => {
    const interior = SECRET.slice(2, 14);
    const expectProtected = (secrets: SentSecrets) => {
      expect(secrets.text(`note ${interior} end`)).not.toContain(interior);
      expect(secrets.text(`note ${SECRET} end`)).not.toContain(SECRET);
      expect(secrets.filterCredentials({ note: `note ${interior} end` }).changed).toBe(true);
    };

    it.each([["x-auth-email"], ["x-auth-user"], ["x-auth-id"], ["x-api-key-id"], ["public-key-auth"]])(
      "keeps the whole value and every fragment of a %s header matched",
      (name) => {
        const secrets = new SentSecrets();
        secrets.request("https://api.example.com/", { headers: { [name]: SECRET } });
        expectProtected(secrets);
      },
    );

    it.each([["auth_user"], ["auth_email"], ["x_auth_id"], ["public_key"]])(
      "keeps the whole value and every fragment of a %s query parameter matched",
      (name) => {
        const secrets = new SentSecrets();
        secrets.request(`https://api.example.com/?${name}=${encodeURIComponent(SECRET)}`);
        expectProtected(secrets);
      },
    );

    it("matches the unframed secret of a query value an auth scheme frames", () => {
      const secrets = new SentSecrets();
      secrets.request(`https://api.example.com/?auth_user=Bearer%20${encodeURIComponent(SECRET)}`);
      expectProtected(secrets);
    });
  });

  describe("INV-5: a header maintained provider code declares a public identifier", () => {
    const EMAIL = "alice@example.com";

    it("matches the whole value in output only, leaving its parts and outbound arguments alone", () => {
      const secrets = new SentSecrets();
      expect(secrets.publicIdentifierHeader(EMAIL)).toBe(true);
      expect(secrets.text("example.com alice")).toBe("example.com alice");
      expect(secrets.text(EMAIL)).toBe("[redacted]");
      expect(secrets.filterCredentials({ name: "example.com", owner: EMAIL })).toEqual({
        value: { name: "example.com", owner: EMAIL },
        changed: false,
      });
    });

    it.each([["Bearer"], ["token"], ["Basic"], ["ApiKey"]])("treats a value %s frames as a credential", (scheme) => {
      const secrets = new SentSecrets();
      expect(secrets.publicIdentifierHeader(`${scheme} ${SECRET}`)).toBe(false);
      const fragment = `note ${SECRET.slice(2, 14)} end`;
      expect(secrets.text(fragment)).not.toContain(SECRET.slice(2, 14));
      expect(secrets.filterCredentials({ note: fragment }).changed).toBe(true);
    });

    it("gives way to the same value sent as a credential", () => {
      const secrets = new SentSecrets();
      secrets.publicIdentifierHeader(SECRET);
      secrets.header(SECRET);
      expect(secrets.filterCredentials({ note: SECRET.slice(2, 14) }).changed).toBe(true);
    });
  });

  it("INV-5: credentials shorter than eight characters and Basic usernames cannot corrupt ordinary text", () => {
    const secrets = new SentSecrets();
    secrets.add("a");
    secrets.add("1234567");
    expect(secrets.text("a [redacted] 1234567")).toBe("a [redacted] 1234567");
    secrets.header(`Basic ${btoa(`a:${SECRET}`)}`);
    expect(secrets.text("a valid ordinary diagnostic")).toBe("a valid ordinary diagnostic");
    // A Basic username beside a registrable password is an identifier, matched whole only.
    expect(secrets.text(`a:${SECRET}`)).toBe("a:[redacted]");
    secrets.add("12345678");
    expect(secrets.text("12345678 [redacted]")).toBe("[redacted] [redacted]");
    expect(secrets.text(secrets.text(`Bearer ${SECRET}`))).toBe("[redacted]");
  });

  it("INV-5: one cached matcher handles mixed JSON escapes, percent casing and new credentials", () => {
    const secrets = new SentSecrets();
    const token = 'credential/"with\\escapes';
    secrets.add(token);
    const unicode = token
      .split("")
      .map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0").toUpperCase()}`)
      .join("");
    const mixed = 'credential\\/\\"with\\\\escapes';
    const percent = encodeURIComponent(token).replace(
      /%[0-9A-F]{2}/g,
      (escape) => `%${escape[1]!.toLowerCase()}${escape[2]}`,
    );
    for (const form of [token, unicode, mixed, percent]) expect(secrets.text(form)).toBe("[redacted]");
    expect(secrets.text(`Bearer ${token}`)).toBe("[redacted]");
    secrets.add("another-credential");
    expect(secrets.text("another-credential")).toBe("[redacted]");
    expect(secrets.text(JSON.stringify(unicode))).toBe('"[redacted]"');
  });

  it("INV-5: a vault-backed matcher handles 10,000 rows without recompiling for each string", async () => {
    const vault = new CredentialVault(memoryStorage(), KEY);
    const values = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`key${i}`, `${SECRET}-${i}`]));
    await vault.setAll("bench", values, "test-user");
    const ctx = connectorContext();
    ctx.credential = { get: async (field) => values[field ?? "key0"] ?? null, getAll: () => vault.getAll("bench") };
    wrapViewCredentials(ctx);
    await ctx.credential.getAll();
    const secrets = sentSecretsFor(ctx);
    const rows = Array.from({ length: 10_000 }, (_, i) => ({
      id: i,
      text: `row ${i} ${values.key0}`,
      label: "ordinary row",
    }));
    secrets.redact(rows[0]);
    const fragments = secrets["views"].fragments;
    expect(fragments).toBeDefined();
    const result = secrets.redact(rows);
    expect(result[9_999]!.text).toBe("row 9999 [redacted]");
    expect(secrets["views"].fragments).toBe(fragments);
  });

  it("INV-5 INV-8: finds twice-escaped credentials across bounded scanning windows", () => {
    const token = 'boundary/"credential';
    const secrets = new SentSecrets();
    secrets.secret(token);
    const escaped = token
      .split("")
      .map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)
      .join("");
    for (const encoded of [escaped, JSON.stringify(escaped).slice(1, -1)]) {
      const text = "\\u0000".repeat(10_920) + encoded + "\\u0000".repeat(20_000);
      expect(secrets.text(text)).toBe("\\u0000".repeat(10_920) + "[redacted]" + "\\u0000".repeat(20_000));
    }
  });

  it("INV-5 INV-8: preserves JSON escape context at a redaction window boundary", () => {
    const token = "ABCDEFGH";
    const secrets = new SentSecrets();
    secrets.secret(token);
    const escaped = token
      .split("")
      .map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)
      .join("");
    const prefix = '{"echo":"' + "x".repeat(65_535 - 9);
    const source = prefix + "\\\\" + escaped + '"}';
    const result = secrets.text(source);
    expect(JSON.parse(result).echo).toBe("x".repeat(65_535 - 9) + "\\[redacted]");
  });

  it("INV-5: custom connector errors are redacted before classification truncates their diagnostic", async () => {
    const storage = memoryStorage();
    const vault = new CredentialVault(storage, KEY);
    await vault.set("custom", SECRET, "test-user");
    const escaped = SECRET.split("")
      .map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)
      .join("");
    const connector: Connector = {
      id: "custom",
      kind: "api",
      credential: { label: "Key" },
      listTools: async () => [{ name: "read", description: "Read", annotations: { readOnlyHint: true } }],
      callTool: async (_name, _args, ctx) => {
        await ctx.credential!.get();
        throw new ConnectorCallError("invalid_args", `Refused ${"x".repeat(460)} ${escaped}`);
      },
    };
    const { outcome, failure } = await exercise(connector, { storage, credentialVault: vault });
    expect(failure.message).toContain("[redacted]");
    if (!outcome.ok) {
      expect(outcome.error.message).toContain("[redacted]");
      expect(outcome.error.message).not.toContain("\\u0073");
    }
  });

  it.each(["unicode", "split", "escaped", "fragment"])(
    "INV-5: %s MCP text is redacted after unwrapping, before paging and emits",
    async (form) => {
      const token = 'credential/"with-escapes';
      const storage = memoryStorage();
      const vault = new CredentialVault(storage, KEY);
      await vault.set("remote", token, "test-user");
      const serialized = JSON.stringify({
        echo: form === "fragment" ? token.slice(3, -3) : token,
        padding: "x".repeat(600),
      });
      const escaped = serialized.replace(
        token.replace(/"/g, '\\"'),
        token
          .split("")
          .map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)
          .join(""),
      );
      const content =
        form === "split"
          ? [
              { type: "text", text: serialized.slice(0, 18) },
              { type: "text", text: serialized.slice(18) },
            ]
          : [{ type: "text", text: form === "unicode" ? escaped : serialized.replace(/\//g, "\\/") }];
      const connector: Connector = {
        id: "remote",
        kind: "mcp",
        credential: { label: "Key" },
        listTools: async () => [{ name: "read", description: "Read", annotations: { readOnlyHint: true } }],
        callTool: async (_name, _args, ctx) => {
          await ctx.credential!.get();
          return { content };
        },
      };
      const registry = makeRegistry([connector], { storage, credentialVault: vault, maxResultBytes: 256 });
      const meta = createMetaTools(registry, BASE);
      const page = await meta.callTool({ address: "remote.read", resultMode: "value" });
      const notice = (page.structuredContent as any).data;
      expect(notice.truncated).toBe(true);
      let reconstructed = "";
      let offset = 0;
      for (;;) {
        const result = await meta.readResult({ id: notice.resultId, offset, maxBytes: 256 });
        const text = result.content[0]!.text;
        const newline = text.indexOf("\n");
        const header = JSON.parse(text.slice(0, newline));
        reconstructed += text.slice(newline + 1);
        if (!header.hasMore) break;
        offset = header.nextOffset;
      }
      // Blocks unwrap joined by a newline, so a document split across two is text; each
      // block keeps its own piece of the match as a placeholder.
      const expectEcho = (data: any) =>
        form === "split"
          ? expect(data).toMatch(/^\{"echo":"\[redacted\]\n\[redacted\]","padding":"x+"\}$/)
          : expect(data.echo).toBe("[redacted]");
      expectEcho(JSON.parse(reconstructed));
      const executor: Executor = {
        execute: async (_code, providers) => {
          const host = providers[0]!.fns;
          const result = (await host.call!("remote.read", {})) as { data: unknown; format: string };
          expectEcho(result.data);
          await host.emit!({ type: "text", text: token });
          return { result: { echoed: token }, logs: [token] };
        },
      };
      const run = createExecuteTool(registry, BASE, executor, silentLogger, undefined, { readOnly: false });
      const result = await run({ code: "async () => {}" });
      expect(result.isError).toBeFalsy();
      expect(JSON.stringify(result)).not.toContain(token);
      expect(result.structuredContent).toMatchObject({ result: { echoed: "[redacted]" }, logs: "[redacted]" });
      expect(result.content.at(-1)?.text).toBe("[redacted]");
      const failed = createExecuteTool(
        registry,
        BASE,
        {
          execute: async (_code, providers) => {
            await providers[0]!.fns.call!("remote.read", {});
            return { result: undefined, error: token, logs: [token] };
          },
        },
        silentLogger,
      );
      const failure = await failed({ code: "async () => {}" });
      expect(failure.isError).toBe(true);
      expect(JSON.stringify(failure)).not.toContain(token);
      expect(failure.structuredContent).toMatchObject({
        error: { code: "program_error", message: "Program Error: [redacted]" },
        logs: "[redacted]",
      });
      expect(JSON.parse(failure.content[0]!.text)).toEqual(failure.structuredContent);
    },
  );

  it.each(["api", "oauth", "remote"])(
    "INV-5: %s final outgoing requests register auxiliary sensitive headers and query parameters",
    async (mode) => {
      const header = "auxiliary-header-credential";
      const query = "auxiliary-query-credential";
      const storage = memoryStorage();
      await seedGrant(
        storage,
        { issuer: "https://oauth.api.test/token", tokens: { access_token: SECRET, token_type: "bearer" } },
        undefined,
        scopes.connector("api"),
      );
      const server = httpDownstream((mcp) =>
        mcp.registerTool("read", { description: "Read", annotations: { readOnlyHint: true } }, async () => ({
          content: [{ type: "text", text: "ok" }],
        })),
      );
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const body =
          mode === "remote" && request.method === "POST" ? ((await request.clone().json()) as any) : undefined;
        if (mode !== "remote" || body?.method === "tools/call") {
          expect(request.headers.get("x-api-key")).toBe(header);
          expect(new URL(request.url).searchParams.get("custom_session_key")).toBe(query);
          const echo = { header, query };
          return mode === "remote"
            ? Response.json({
                jsonrpc: "2.0",
                id: body.id,
                result: {
                  resultType: "complete",
                  content: [{ type: "text", text: JSON.stringify(echo) }],
                  structuredContent: echo,
                },
              })
            : Response.json(echo);
        }
        return server.fetch(request.url, init);
      });
      const connector =
        mode === "remote"
          ? remoteMcp("api", {
              url: `${server.url}?custom_session_key=${query}`,
              auth: { type: "headers", headers: { "X-API-Key": header } },
            })
          : api("api", {
              ...(mode === "oauth"
                ? {
                    oauth: {
                      authorizationEndpoint: "https://oauth.api.test/authorize",
                      tokenEndpoint: "https://oauth.api.test/token",
                      clientId: "client",
                      apiOrigins: ["https://api.test"],
                    },
                  }
                : {}),
              tools: [
                {
                  name: "read",
                  description: "Read",
                  annotations: { readOnlyHint: true },
                  handler: async (_args, ctx) => {
                    const response = await (ctx.oauth?.fetch ?? ctx.fetch)(
                      `https://api.test/read?custom_session_key=${query}`,
                      { headers: { "X-API-Key": header, "Signature": header } },
                    );
                    return response.json();
                  },
                },
              ],
            });
      const registry = makeRegistry([connector], { storage });
      const outcome = await new InvocationService(registry, new CatalogService(registry, BASE)).invoke(
        "api.read",
        {},
        { source: "call_tool", unwrapResult: true },
      );
      expect(outcome).toMatchObject({ ok: true, value: { header: "[redacted]", query: "[redacted]" } });
    },
  );

  it.each(["rpc", "http", "isError", "success"])(
    "INV-5 INV-6: generic remoteMcp headers auth redacts %s echoes before agents and guest calls",
    async (kind) => {
      const server = httpDownstream((mcp) =>
        mcp.registerTool("read", { description: "Read", annotations: { readOnlyHint: true } }, async () => ({
          content: [{ type: "text", text: "ordinary result" }],
        })),
      );
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const body = request.method === "POST" ? ((await request.clone().json()) as any) : undefined;
        if (body?.method === "tools/call") {
          expect(request.headers.get("x-api-key")).toBe(SECRET);
          const message = diagnostic(SECRET);
          if (kind === "http") return Response.json({ message }, { status: 403 });
          if (kind === "rpc")
            return Response.json({
              jsonrpc: "2.0",
              id: body.id,
              error: { code: -32603, message, data: { echoed: message } },
            });
          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              resultType: "complete",
              isError: kind === "isError",
              content: [{ type: "text", text: message }],
              structuredContent: { echoed: message },
            },
          });
        }
        return server.fetch(input instanceof Request ? input.url : input, init);
      });
      const connector = remoteMcp("remote", {
        url: server.url,
        auth: { type: "headers", headers: { "X-API-Key": SECRET } },
      });
      const ctx = connectorContext();
      try {
        if (kind === "success") {
          const registry = makeRegistry([connector]);
          const result = await new InvocationService(registry, new CatalogService(registry, BASE)).invoke(
            "remote.read",
            {},
            { source: "call_tool" },
          );
          expect(result).toMatchObject({ ok: true });
          expect(JSON.stringify(result)).not.toContain(SECRET);
          expect(JSON.stringify(result)).toContain("[redacted]");
        } else {
          const { outcome } = await exercise(connector);
          if (!outcome.ok) {
            if (kind === "http") expect(outcome.error.code).toBe("provider_permission_denied");
            else expect(outcome.error.message).toContain("[redacted]");
          }
        }
        const raw = await connector.callTool("read", {}, ctx).catch((error) => error);
        expect(JSON.stringify(raw)).not.toContain(SECRET);
        expect(String(raw)).not.toContain(SECRET);
        if (raw instanceof Error) {
          expect(JSON.stringify(Object.getOwnPropertyDescriptors(raw))).not.toContain(SECRET);
        }
      } finally {
        await connector.closeScope?.(ctx);
      }
    },
  );

  it.each(["http", "rpc"])(
    "INV-5 INV-6: api credential slots redact %s diagnostics and query-key echoes",
    async (kind) => {
      const storage = memoryStorage();
      const vault = new CredentialVault(storage, KEY);
      await vault.set("api", SECRET, "test-user");
      vi.stubGlobal("fetch", async (input: string | URL) => {
        expect(new URL(input).searchParams.get("api_key")).toBe(SECRET);
        return Response.json(
          kind === "http"
            ? { message: diagnostic(SECRET) }
            : { error: { code: -32603, message: diagnostic(SECRET), data: { echoed: SECRET } } },
          { status: 400 },
        );
      });
      const connector = api("api", {
        credential: { label: "API key" },
        tools: [
          {
            name: "read",
            description: "Read",
            annotations: { readOnlyHint: true },
            handler: async (_args, ctx) => {
              const key = (await ctx.credential!.getAll())!.value!;
              const url = new URL("https://api.test/read");
              url.searchParams.set("api_key", key);
              const response = await fetch(url);
              const body = (await response.json()) as any;
              throw new ConnectorCallError("invalid_args", body.message ?? body.error.message, {
                cause: new Error(JSON.stringify(body)),
              });
            },
          },
        ],
      });
      const { outcome } = await exercise(connector, { storage, credentialVault: vault });
      if (!outcome.ok) expect(outcome.error.message).toContain("[redacted]");
      const ctx = connectorContext();
      ctx.credential = { get: async () => SECRET, getAll: async () => ({ value: SECRET }) };
      await expect(connector.callTool("read", {}, ctx)).rejects.toSatisfy(
        (error: Error) => !error.message.includes(SECRET) && !(error.cause as Error).message.includes(SECRET),
      );
    },
  );

  it.each(["oauth", "request", "credential", "basic"] as const)(
    "INV-5: remoteMcp %s auth redacts actual sent credentials on a cached connection",
    async (mode) => {
      const server = httpDownstream((mcp) =>
        mcp.registerTool("read", { description: "Read", annotations: { readOnlyHint: true } }, async () => ({
          content: [{ type: "text", text: "ok" }],
        })),
      );
      vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
        const body = init?.method === "POST" ? JSON.parse(String(init.body)) : undefined;
        if (body?.method === "tools/call") {
          const authorization = new Headers(init?.headers).get("authorization")!;
          expect(authorization).toBe(mode === "basic" ? `Basic ${btoa(`account:${SECRET}`)}` : `Bearer ${SECRET}`);
          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -32603, message: diagnostic(SECRET), data: { authorization } },
          });
        }
        return server.fetch(input, init);
      });
      const auth: RemoteMcpAuth =
        mode === "basic"
          ? { type: "headers" as const, headers: { Authorization: `Basic ${btoa(`account:${SECRET}`)}` } }
          : mode === "request"
            ? { type: "request" as const, token: async () => SECRET }
            : { type: mode };
      const connector = remoteMcp("remote", { url: server.url, auth });
      const scope = {};
      const ctx = { ...connectorContext(), requestScope: scope };
      if (mode === "credential") ctx.credential = { get: async () => SECRET, getAll: async () => ({ value: SECRET }) };
      if (mode === "oauth")
        await seedGrant(ctx.storage, {
          issuer: "https://authorization.test",
          tokens: { access_token: SECRET, token_type: "bearer" },
        });
      try {
        await connector.listTools(ctx);
        // Distinct call contexts share the transport, never the secret set.
        for (let call = 0; call < 2; call++) {
          const error = await connector.callTool("read", {}, { ...ctx }).catch((error) => error);
          expect(error).toBeInstanceOf(Error);
          if (!(error instanceof Error)) throw new Error("Expected a downstream failure");
          expect(error.message).toContain("[redacted]");
          expect(JSON.stringify(Object.getOwnPropertyDescriptors(error))).not.toContain(SECRET);
        }
      } finally {
        await connector.closeScope?.(ctx);
      }
    },
  );

  it("INV-5: api OAuth registers both tokens when a call refreshes its grant", async () => {
    const tokenEndpoint = "https://oauth.api.test/token";
    const rotated = `${SECRET}-rotated`;
    let refused = false;
    const storage = memoryStorage();
    await seedGrant(
      storage,
      {
        issuer: tokenEndpoint,
        tokens: { access_token: SECRET, refresh_token: "refresh-credential", token_type: "bearer" },
      },
      undefined,
      scopes.connector("api"),
    );
    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
      if (String(input) === tokenEndpoint) return Response.json({ access_token: rotated, token_type: "bearer" });
      const bearer = new Headers(init?.headers).get("authorization");
      if (bearer === `Bearer ${SECRET}`) {
        refused = true;
        return new Response("", { status: 401 });
      }
      expect(bearer).toBe(`Bearer ${rotated}`);
      const message = `${refused ? `${diagnostic(SECRET)}\n` : ""}${diagnostic(rotated)}`;
      refused = false;
      return Response.json({ message }, { status: 400 });
    });
    const connector = api("api", {
      oauth: {
        authorizationEndpoint: "https://oauth.api.test/authorize",
        tokenEndpoint,
        clientId: "client",
        apiOrigins: ["https://api.test"],
      },
      tools: [
        {
          name: "read",
          description: "Read",
          annotations: { readOnlyHint: true },
          handler: async (_args, ctx) => {
            const response = await ctx.oauth!.fetch("https://api.test/read");
            const body = (await response.json()) as { message: string };
            throw new ConnectorCallError("invalid_args", body.message);
          },
        },
      ],
    });
    const { outcome } = await exercise(connector, { storage });
    if (!outcome.ok) {
      expect(outcome.error.message).toContain("[redacted]");
      expect(outcome.error.message).not.toContain(rotated);
      expect(outcome.error.message).not.toContain("refresh-credential");
    }
  });

  it("INV-5: calls sharing a request scope redact previously sent slot values without widening a different request", async () => {
    const connector = api("api", {
      credential: { label: "Key" },
      tools: [
        {
          name: "read",
          description: "Read",
          annotations: { readOnlyHint: true },
          handler: async (args, ctx) => {
            if (args.authenticate) await ctx.credential!.get();
            throw new ConnectorCallError("invalid_args", SECRET);
          },
        },
      ],
    });
    const scope = {};
    const first: ConnectorContext = {
      ...connectorContext(),
      requestScope: scope,
      credential: { get: async () => SECRET, getAll: async () => ({ value: SECRET }) },
    };
    const second = { ...first };
    await expect(connector.callTool("read", { authenticate: true }, first)).rejects.toThrow("[redacted]");
    await expect(connector.callTool("read", {}, second)).rejects.toThrow("[redacted]");
    const separate = { ...first, requestScope: {} };
    await expect(connector.callTool("read", {}, separate)).rejects.toThrow(SECRET);
  });
});
