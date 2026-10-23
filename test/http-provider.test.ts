import { NODE, WORKERS } from "./fixtures/runtime-tags.js";
import { Context, Effect, Schema } from "effect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { attachCallClassification } from "../src/call-classification.js";
import { attachCaller } from "../src/connector-caller.js";
import { keys, optionsOf } from "../src/config-schema.js";
import { ConnectorCallError } from "../src/errors.js";
import { configureGuardedTransport } from "../src/guarded-transport.js";
import { Refusal, RequestRefused, type VendorErrors } from "../src/http/errors.js";
import { bearer } from "../src/http/oauth.js";
import { defineApiProvider } from "../src/http/provider.js";
import { Budget, Caller, Classification, Credentials, Signal } from "../src/http/services.js";
import { read, write } from "../src/http/tools.js";
import { get, vendor } from "../src/http/vendor.js";
import { PROVIDER_COMMON, type ProviderOptions } from "../src/provider.js";
import { boundaryFor, originalCallIdentity, tracksRequests } from "../src/provider-call-facts.js";
import { OperationIndex } from "../src/providers/_shared/rest/operation-index.js";
import { runEdge } from "../src/runtime/run.js";
import { setViewService } from "../src/runtime/call.js";
import type { ConnectorContext } from "../src/types.js";
import { connectorContext } from "./fixtures/misc.js";
import { seedGrant } from "./fixtures/oauth.js";
import { makeRegistry } from "./helpers.js";
import tithelyCalls from "./goldens/tithely/calls.json";

type Options = ProviderOptions & { baseUrl?: string; defaultPageSize?: number; sensitiveFields?: "drop" | "return" };
const who = get("who", "/who", { success: Schema.Unknown });
const api = vendor("Tickets", who, get("ticket", "/tickets/:id", { params: { id: Schema.String } }));
const errors: VendorErrors = {
  provider: "Tickets",
  facts: () => ({}),
  detail: ({ status }) => `Tickets answered ${status}.`,
  statuses: {
    401: () => ({ code: "auth_required", words: (detail) => `${detail} Replace the candidate.` }),
    403: () => ({ code: "provider_permission_denied", words: (detail) => `${detail} Grant access.` }),
    404: () => ({ code: "not_found" }),
  },
  unreadable: "Tickets returned unreadable JSON.",
};
const safety = (options: Readonly<Options>) => ({
  review: "Fixture replies have no stored secrets.",
  sensitiveFields: { names: ["private"], choice: options.sensitiveFields ?? "drop" } as const,
});
const definition = {
  name: "tickets",
  title: "Tickets",
  skill: { content: "Resolve ids before writing.", instructionsHeading: "Workspace instructions" },
  options: optionsOf<Options>()({ ...PROVIDER_COMMON, ...keys("baseUrl", "defaultPageSize", "sensitiveFields") }),
  vendor: api,
  baseUrl: (options: Readonly<Options>) => options.baseUrl ?? "https://tickets.example/v1",
  maxResponseBytes: 1024,
  pageSize: { default: 10, max: 50 },
  credential: { label: "Token" },
  authenticate: Credentials.use((credentials) => credentials.values).pipe(
    Effect.mapError((error) => new Refusal({ error })),
    Effect.map((values) => ({ Authorization: `Bearer ${values?.["value"] ?? values?.["token"]}` })),
  ),
  errors,
  safety,
  probe: { operation: who, request: {}, describe: (reply: unknown) => JSON.stringify(reply) },
  guide: (options: Readonly<Options>) => ({ context: [options.purpose] }),
  tools: ({ connection }: Parameters<Parameters<typeof defineApiProvider<Options>>[0]["tools"]>[0]) => [
    read(connection, {
      name: "who",
      description: "Read the account.",
      input: Schema.Struct({}),
      output: Schema.Unknown,
      run: () => connection.send(who, {}).pipe(Effect.map(({ data }) => data)),
    }),
    write(connection, {
      name: "send",
      description: "Send a ticket.",
      input: Schema.Struct({}),
      output: Schema.Unknown,
      destructive: false,
      run: () =>
        connection
          .sendPath({ method: "POST", path: "/tickets", template: "/tickets" })
          .pipe(Effect.map(({ data }) => data)),
    }),
    write(connection, {
      name: "refuse",
      description: "Refuse before dispatch.",
      input: Schema.Struct({}),
      output: Schema.Unknown,
      destructive: false,
      run: () => Effect.fail(new Refusal({ error: new ConnectorCallError("invalid_args", "Choose a ticket.") })),
    }),
  ],
};

beforeEach(() => configureGuardedTransport({ send: (url, init) => globalThis.fetch(url, init) }));
afterEach(() => {
  configureGuardedTransport(undefined);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("INV-11: checks provider, confinement, ceiling, page and privacy configuration before dispatch", NODE, () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const definitions = [
    { maxResponseBytes: 0 },
    { maxResponseBytes: 1.5 },
    { maxResponseBytes: Infinity },
    { pageSize: { default: 0, max: 10 } },
    { pageSize: { default: 11, max: 10 } },
    { pageSize: { default: 1, max: 1.5 } },
    { pageSize: null as never },
    {
      oauth: () => ({
        authorizationEndpoint: "https://tickets.example/auth",
        tokenEndpoint: "https://tickets.example/token",
        clientId: "fixture",
        apiOrigins: ["https://tickets.example"],
      }),
    },
  ];
  for (const change of definitions) expect(() => defineApiProvider({ ...definition, ...change })).toThrow();
  const factory = defineApiProvider(definition);
  const options: unknown[] = [
    { purpose: "" },
    { purpose: "Support", unknown: true },
    { purpose: "Support", readOnly: "yes" },
    ...[
      "relative",
      "http://tickets.example",
      "https://user:pass@tickets.example",
      "https://tickets.example?q=1",
      "https://tickets.example/#hash",
    ].map((baseUrl) => ({ purpose: "Support", baseUrl })),
    ...[0, 51, 1.5, "10", null, Infinity].map((defaultPageSize) => ({ purpose: "Support", defaultPageSize })),
    { purpose: "Support", sensitiveFields: "all" },
  ];
  for (const input of options) expect(() => factory("tickets", input as Options), JSON.stringify(input)).toThrow();
  expect(() =>
    defineApiProvider({ ...definition, safety: () => ({ sensitiveFields: { names: [], choice: "drop" } }) })(
      "tickets",
      { purpose: "Support" },
    ),
  ).toThrow(/review/);
  expect(fetch).not.toHaveBeenCalled();
});

it("INV-11: renders guides, carries common options and snapshots code-derived kit facts", NODE, () => {
  const pages: number[] = [];
  const index = new OperationIndex(
    {
      source: "https://tickets.example/spec",
      revision: "fixture",
      digest: "sha256:fixture",
      version: "1",
      servers: ["https://tickets.example"],
      tags: ["account"],
      ops: [["GET", "/who", "who", "Read the account", 0]],
      details: '{"d":[],"o":[0]}',
    },
    { vendor: "tickets", title: "Tickets" },
  );
  const hatch = { name: "tickets", index, verdicts: { "GET /who": "read" as const } };
  const pageSize = { default: 10, max: 50 };
  const completeGuide = { content: "Legacy fragments and instructions.\n", summary: "Triage", required: true };
  const factory = defineApiProvider({
    ...definition,
    displayTitle: (options) => `${options.purpose} tickets`,
    description: (options) => `Tickets for ${options.purpose}.`,
    guide: (options) => (options.purpose === "Triage" ? completeGuide : definition.guide(options)),
    pageSize,
    hatch,
    tools: (kit) => {
      pages.push(kit.pageSize);
      return definition.tools(kit);
    },
  });
  pageSize.default = 99;
  hatch.verdicts["GET /who"] = "refuse" as never;
  const first = factory("tickets", {
    purpose: "  Support  ",
    instructions: "Use alice's queue.",
    authScope: "personal",
    readOnly: true,
    maxResultBytes: 256,
    title: "Team tickets",
  });
  const second = factory("other", { purpose: "Triage", defaultPageSize: 50, instructions: "Already rendered." });
  expect(pages).toEqual([10, 50]);
  expect(first).toMatchObject({
    title: "Team tickets",
    description: "Tickets for Support.",
    authScope: "personal",
    readOnly: true,
    maxResultBytes: 256,
  });
  expect(second.title).toBe("Triage tickets");
  expect(second.usageGuide).toEqual(completeGuide);
  expect(first.usageGuide).toMatchObject({
    content:
      "# Tickets usage\n\nSupport\n\nResolve ids before writing.\n\n## Workspace instructions\n\nUse alice's queue.\n",
  });
  expect(factory.definition.kit).toEqual({
    operations: ["GET /tickets/{id}", "GET /who"],
    pageSize: { default: 10, max: 50 },
    hatch: { name: "tickets", verdicts: { "GET /who": "read" } },
  });
  expect(Object.isFrozen(factory.definition.kit?.hatch?.verdicts)).toBe(true);
  expect(first.describe?.().source.provider).toBe("tickets");
  expect(first.staticTools?.map(({ name }) => name)).toEqual([
    "who",
    "send",
    "refuse",
    "tickets_api_search",
    "tickets_api_details",
    "tickets_api_read",
  ]);
  const { pageSize: _pageSize, ...unpaged } = definition;
  expect(defineApiProvider({ ...unpaged, tools: () => [] })("tickets", { purpose: "Support" }).id).toBe("tickets");
  expect(() =>
    defineApiProvider({
      ...unpaged,
      tools: (kit) => {
        void kit.pageSize;
        return [];
      },
    })("tickets", { purpose: "Support" }),
  ).toThrow(/Declare pageSize/);
});

it("INV-5 INV-9: keeps the canonical tracked api boundary and routes tools through result safety", NODE, async () => {
  type Row = Pick<Parameters<typeof defineApiProvider<Options>>[0], "headers" | "admit"> & {
    name: string;
    tool: string;
    refused?: true;
    accept?: true;
  };
  const rows: Row[] = [
    { name: "safe result", tool: "who" },
    { name: "empty write ledger", tool: "refuse", refused: true },
    { name: "Tithe.ly golden Accept", tool: "who", headers: { Accept: "application/json" }, accept: true },
    {
      name: "admit before credentials",
      tool: "who",
      admit: () => Effect.fail(new RequestRefused({ message: "Admission refused." })),
      refused: true,
    },
  ];
  for (const row of rows) {
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (row.accept)
        expect(new Headers(init?.headers).get("accept")).toBe(tithelyCalls[0]!.steps[0]![0]!.headers.accept);
      return Response.json({ envelope: { visible: "yes", private: "drop" } });
    });
    vi.stubGlobal("fetch", fetch);
    const connector = defineApiProvider({
      ...definition,
      ...(row.headers === undefined ? {} : { headers: row.headers }),
      ...(row.admit === undefined ? {} : { admit: row.admit }),
      result: (body) => Effect.succeed((body as { envelope: unknown }).envelope),
    })("tickets", { purpose: "Support" });
    expect(tracksRequests(connector), row.name).toBe(true);
    expect(originalCallIdentity(connector)).toBe(connector);
    expect(boundaryFor(connector)?.boundary).toBe(connector);
    expect(boundaryFor(connector)?.own).toBe(connector.callTool);
    const ctx = connectorContext();
    const getCredential = vi.fn(async () => "stored");
    const getCredentials = vi.fn(async () => ({ value: "stored" }));
    ctx.credential = { get: getCredential, getAll: getCredentials };
    if (row.refused) {
      await expect(connector.callTool(row.tool, {}, ctx)).rejects.toMatchObject({
        code: "invalid_args",
        retryable: false,
        writeOutcome: undefined,
      });
      expect(getCredential).not.toHaveBeenCalled();
      expect(getCredentials).not.toHaveBeenCalled();
    } else expect(await connector.callTool(row.tool, {}, ctx)).toEqual({ visible: "yes" });
    expect(fetch).toHaveBeenCalledTimes(row.refused ? 0 : 1);
  }
});

it("INV-4 INV-5 INV-7: probes authenticate with candidate services and close retained capabilities", NODE, async () => {
  for (const mode of ["single", "named"] as const) {
    let retained!: Context.Context<Caller | Credentials | Budget | Classification | Signal>;
    const authenticate = Effect.context<Caller | Credentials | Budget | Classification | Signal>().pipe(
      Effect.tap((services) =>
        Effect.sync(() => {
          retained = services;
        }),
      ),
      Effect.andThen(definition.authenticate),
    );
    const connector = defineApiProvider({
      ...definition,
      authenticate,
      probe: {
        ...definition.probe,
        check: (values, options) => {
          expect(options.purpose).toBe("Support");
          return Object.values(values).includes("invalid") ? "Replace this candidate." : undefined;
        },
        describe: (reply, options) => `${options.purpose}: ${JSON.stringify(reply)}`,
      },
      credential:
        mode === "single"
          ? { label: "Token" }
          : {
              label: "Keys",
              fields: [
                { name: "token", label: "Token" },
                { name: "account", label: "Account" },
              ],
            },
    })("tickets", { purpose: "Support" });
    const ctx: ConnectorContext = connectorContext();
    ctx.requestScope = {};
    ctx.credential = { get: vi.fn(async () => "stored"), getAll: vi.fn(async () => ({ value: "stored" })) };
    attachCaller(ctx, { identity: { actor: { kind: "user", id: "alice" }, interactive: true }, authenticated: true });
    attachCallClassification(ctx, "write");
    let charged = 0;
    setViewService(ctx, Budget, {
      charge: Effect.sync(() => {
        charged++;
      }),
    });
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer candidate-token");
      expect(Context.get(retained, Caller)).toBeUndefined();
      expect(Context.get(retained, Classification)).toBe("read");
      await runEdge(Context.get(retained, Budget).charge);
      expect(await runEdge(Context.get(retained, Credentials).values)).toEqual(
        mode === "single" ? { value: "candidate-token" } : { token: "candidate-token", account: "candidate-account" },
      );
      return Response.json({ visible: "candidate-token", private: "hidden" });
    });
    vi.stubGlobal("fetch", fetch);
    const answer =
      mode === "single"
        ? await connector.testCredential!("candidate-token", ctx)
        : await connector.testCredentials!({ token: "candidate-token", account: "candidate-account" }, ctx);
    expect(answer).toEqual({ ok: true, message: 'Support: {"visible":"[redacted]"}' });
    const refused =
      mode === "single"
        ? await connector.testCredential!("invalid", ctx)
        : await connector.testCredentials!({ token: "invalid" }, ctx);
    expect(refused).toEqual({ ok: false, message: "Replace this candidate." });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(ctx.credential.getAll).not.toHaveBeenCalled();
    expect(charged).toBe(0);
    expect(Context.get(retained, Signal)?.aborted).toBe(true);
    await expect(runEdge(Context.get(retained, Credentials).values)).rejects.toBeInstanceOf(ConnectorCallError);
    await expect(runEdge(Context.get(retained, Budget).charge)).rejects.toBeDefined();
  }
});

it("INV-5 INV-7: maps probe refusals through vendor rules and closes failed probes", NODE, async () => {
  let signal: AbortSignal | undefined;
  let hookDefect = false;
  let withheld = false;
  const defect = new ConnectorCallError("invalid_args", "stored-secret-never-sent");
  const authenticate = definition.authenticate.pipe(
    Effect.tap(() =>
      Signal.use((value) =>
        Effect.sync(() => {
          signal = value;
        }),
      ),
    ),
  );
  const connector = defineApiProvider({
    ...definition,
    authenticate,
    safety: (options) => ({
      ...safety(options),
      reviewed: { redact: (data) => data, withholdsErrors: () => withheld },
    }),
    result: (data) => (hookDefect ? Effect.die(defect) : Effect.succeed(data)),
  })("tickets", { purpose: "Support" });
  for (const [status, detail, hook] of [
    [401, "Replace the candidate.", undefined],
    [403, "Grant access.", undefined],
    [200, "unreadable JSON", undefined],
    [200, "A provider hook withholding vendor text failed.", "withheld"],
    [200, defect.message, "open"],
  ] as const) {
    hookDefect = hook !== undefined;
    withheld = hook === "withheld";
    const fetch = vi.fn(async () => new Response(status === 200 && !hookDefect ? "not JSON" : "{}", { status }));
    vi.stubGlobal("fetch", fetch);
    const result = connector.testCredentials!({ value: "candidate" }, connectorContext());
    if (hookDefect) {
      if (withheld) {
        await expect(result).rejects.toThrow(detail);
        await expect(result).rejects.not.toBeInstanceOf(ConnectorCallError);
      } else await expect(result).rejects.toBe(defect);
    } else {
      expect(await result).toEqual({ ok: false, message: expect.stringContaining(detail) });
    }
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(signal?.aborted).toBe(true);
  }

  // A custom probe may use a private transport, so none of these defects has
  // a kit dispatch from which the visibility policy could be recovered.
  for (const hook of ["run", "describe", "failure"] as const) {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const connector = defineApiProvider({
      ...definition,
      probe: {
        ...definition.probe,
        run: () =>
          Signal.use((value) => {
            signal = value;
            return hook === "run"
              ? Effect.die(defect)
              : hook === "failure"
                ? Effect.fail(new Refusal({ error: defect }))
                : Effect.succeed({});
          }),
        describe: () => {
          throw defect;
        },
        failure: () => {
          throw defect;
        },
      },
    })("tickets", { purpose: "Support" });
    const result = connector.testCredentials!({ value: "candidate" }, connectorContext());
    await expect(result).rejects.toThrow("A provider hook withholding vendor text failed.");
    await expect(result).rejects.not.toBeInstanceOf(ConnectorCallError);
    expect(fetch).not.toHaveBeenCalled();
    expect(signal?.aborted).toBe(true);
  }
});

it("INV-7 INV-9: binds OAuth to each call and refreshes reads while sending writes once", WORKERS, async () => {
  const { credential: _credential, ...withoutCredential } = definition;
  const oauth = {
    authorizationEndpoint: "https://tickets.example/auth",
    tokenEndpoint: "https://tickets.example/token",
    clientId: "fixture",
    apiOrigins: ["https://tickets.example"],
  };
  const connector = defineApiProvider({ ...withoutCredential, authenticate: bearer, oauth: () => oauth })("tickets", {
    purpose: "Support",
  });
  for (const [tool, attempts] of [
    ["who", 2],
    ["send", 1],
  ] as const) {
    const registry = makeRegistry([connector]);
    const ctx = registry.contextFor("tickets", "https://connecta.example", {});
    await seedGrant(ctx.storage, {
      issuer: oauth.tokenEndpoint,
      tokens: { access_token: "old", refresh_token: "refresh", token_type: "Bearer" },
    });
    let requests = 0;
    const tokens: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: RequestInit) => {
        if (String(url) === oauth.tokenEndpoint) return Response.json({ access_token: "fresh", token_type: "Bearer" });
        tokens.push(new Headers(init?.headers).get("authorization")!);
        return ++requests === 1 ? Response.json({}, { status: 401 }) : Response.json({ ok: true });
      }),
    );
    if (tool === "who") expect(await connector.callTool(tool, {}, ctx)).toEqual({ ok: true });
    else
      await expect(connector.callTool(tool, {}, ctx)).rejects.toMatchObject({
        code: "connector_call_failed",
        retryable: false,
        writeOutcome: "unknown",
      });
    expect(requests).toBe(attempts);
    expect(tokens).toEqual(tool === "who" ? ["Bearer old", "Bearer fresh"] : ["Bearer old"]);
  }
  // CCB's static compatibility mode has a separate, smaller challenge
  // ceiling. Native declared/streamed refusals must stop before renewal.
  const compatibility = defineApiProvider({
    ...withoutCredential,
    maxResponseBytes: 8 * 1024 * 1024,
    oauthWrite401: "grant",
    authenticate: bearer,
    oauth: () => oauth,
  })("tickets", { purpose: "Support" });
  for (const tool of ["who", "send"] as const)
    for (const [bytes, declared] of [
      [2 * 1024 * 1024, false],
      [2 * 1024 * 1024, true],
      [9 * 1024 * 1024, false],
      [9 * 1024 * 1024, true],
    ] as const) {
      const ctx = makeRegistry([compatibility]).contextFor("tickets", "https://connecta.example", {});
      await seedGrant(ctx.storage, {
        issuer: oauth.tokenEndpoint,
        tokens: { access_token: "old", refresh_token: "refresh", token_type: "Bearer" },
      });
      let requests = 0;
      let renewals = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: unknown) => {
          if (String(url) === oauth.tokenEndpoint) {
            renewals++;
            return Response.json({ access_token: "fresh", token_type: "Bearer" });
          }
          requests++;
          return declared
            ? new Response(null, { status: 401, headers: { "content-length": String(bytes) } })
            : new Response(new Uint8Array(bytes), { status: 401 });
        }),
      );
      await expect(compatibility.callTool(tool, {}, ctx)).rejects.toMatchObject({
        code: tool === "who" ? "connector_call_failed" : "downstream_oauth_required",
        message:
          tool === "who"
            ? "The OAuth challenge exceeded its response ceiling."
            : 'Connector "tickets"\'s API answered this write with HTTP 401. Renewing the credential failed (connector_call_failed), and the write was not sent again, so whether it took effect is unknown: check the target before repeating it.',
        retryable: false,
        writeOutcome: tool === "who" ? undefined : "unknown",
      });
      expect(requests).toBe(1);
      expect(renewals).toBe(0);
    }
});
