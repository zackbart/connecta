import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { ToolCallActivityEvent } from "../src/activity.js";
import { CatalogService } from "../src/catalog-service.js";
import { api } from "../src/connectors/api.js";
import { STORED_CREDENTIAL_SHAPE_MISMATCH_ERROR } from "../src/credential-rules.js";
import { CredentialVault } from "../src/credentials.js";
import { ConnectorCallError } from "../src/errors.js";
import { createMetaTools as buildMetaTools } from "../src/meta-tools.js";
import { GUIDE_SUMMARY_LENGTH } from "../src/skills.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { Connector } from "../src/types.js";
import { connectorWith } from "./fixtures/connectors.js";
import { BASE, connectorIds, registry, type SearchResult, textOf } from "./fixtures/meta-tools.js";
import { activitySink, authConnector, calcConnector, makeRegistry, required } from "./helpers.js";

const CREDENTIAL_KEY = Buffer.alloc(32, 11).toString("base64");

describe("skills", () => {
  const NOTES_GUIDE = `# Notes usage

Prefer \`notes.search\` over listing databases.

- Page results with \`start_cursor\`; never fetch more than 100 at a time.
`;

  function guided(id: string, guide?: Connector["usageGuide"]): Connector {
    return api(id, {
      description: `${id} connector`,
      ...(guide === undefined ? {} : { usageGuide: guide }),
      tools: [
        {
          name: "search",
          description: "Search records",
          inputSchema: { type: "object" },
          annotations: { readOnlyHint: true },
          handler: () => ({ results: [] }),
        },
      ],
    });
  }

  /**
   * A guided read-only tool whose compact discovery schema is too wide to
   * render whole — `schema_truncated` is the one required-review reason an
   * exact schema resolves, so it needs a connector both halves can share.
   */
  function wideGuided(): Connector {
    return api("wide", {
      usageGuide: {
        content: "# Wide API\n\nArguments are documented here.\n",
        summary: "Argument meanings for wide operations.",
      },
      tools: [
        {
          name: "read",
          description: "Read a value",
          inputSchema: {
            type: "object",
            properties: Object.fromEntries(
              Array.from({ length: 100 }, (_, index) => [`argument_${index}_${"x".repeat(20)}`, { type: "string" }]),
            ),
          },
          annotations: { readOnlyHint: true },
          handler: () => ({}),
        },
      ],
    });
  }

  function textFrom(result: { content: { text: string }[] }): string {
    return required(result.content[0]).text;
  }

  it("lists the built-in usage guide plus one entry per guided connector", async () => {
    const mt = createMetaTools(makeRegistry([guided("notes", NOTES_GUIDE), guided("plain")]), BASE);
    const listed = textFrom(await mt.skills({}));
    expect(listed).toContain("`usage` — How to route work between one execute_code program");
    expect(listed).toContain("`connector:notes` — Prefer `notes.search` over listing databases.");
    expect(listed).not.toContain("connector:plain");
  });

  it("preserves a connector guide body behind skill frontmatter", async () => {
    const mt = createMetaTools(makeRegistry([guided("notes", NOTES_GUIDE)]), BASE);
    const fetched = await mt.skills({ name: "connector:notes" });
    expect(fetched.isError).toBeFalsy();
    expect(textFrom(fetched)).toContain(NOTES_GUIDE);
  });

  it("rejects an explicit summary over budget at registry construction", () => {
    expect(() =>
      makeRegistry([
        guided("cloud", {
          content: "# Cloud API\n",
          summary: "x".repeat(GUIDE_SUMMARY_LENGTH + 1),
        }),
      ]),
    ).toThrow(
      'Connector "cloud" usageGuide.summary is 121 characters after whitespace normalization; the discovery bound is 120.',
    );
  });

  it("keeps duplicate guide content and deployment-specific summaries isolated", async () => {
    const content = "# Shared service\n\nUse the deployment's configured alias.\n";
    const first = createMetaTools(
      makeRegistry([
        guided("service", {
          content,
          summary: "First deployment aliases.",
        }),
      ]),
      BASE,
    );
    const second = createMetaTools(
      makeRegistry([
        guided("service", {
          content,
          summary: "Second deployment aliases.",
        }),
      ]),
      BASE,
    );

    expect(textFrom(await first.skills({}))).toContain("`connector:service` — First deployment aliases.");
    expect(textFrom(await second.skills({}))).toContain("`connector:service` — Second deployment aliases.");
    expect(textFrom(await first.skills({ name: "connector:service" }))).toContain(content);
    expect(textFrom(await second.skills({ name: "connector:service" }))).toContain(content);
  });

  it("requires guide review for approval-bound tools and connector-required conventions", async () => {
    const connector = api("generic", {
      usageGuide: {
        content: "# Generic API\n\nRead the operation documentation first.\n",
        summary: "Generic operation aliases and argument shapes.",
        required: true,
      },
      tools: [
        {
          name: "invoke",
          description: "Invoke a generic operation",
          inputSchema: { type: "object" },
          annotations: { readOnlyHint: false },
          handler: () => ({}),
        },
      ],
    });
    const mt = createMetaTools(makeRegistry([connector]), BASE);
    const searched = textOf(await mt.searchTools({ query: "invoke", includeSchemas: "compact" })) as SearchResult;
    expect(required(searched.tools[0]).guideSummary).toBe("Generic operation aliases and argument shapes.");
    expect(required(searched.tools[0]).guideRequired).toBe(true);
    expect(required(searched.tools[0]).guideRequiredReasons).toEqual(["connector_required", "approval_required"]);

    const missed = textOf(
      await mt.searchTools({
        connector: "generic",
        query: "list open invoices",
        includeSchemas: "compact",
      }),
    ) as SearchResult;
    expect(missed.tools).toEqual([]);
    expect(missed.queryAnalysis).toMatchObject({
      guide: "connector:generic",
      guideSummary: "Generic operation aliases and argument shapes.",
      guideRequired: true,
      guideRequiredReasons: ["connector_required"],
      guidance: expect.stringContaining("Fetch queryAnalysis.guide"),
    });
  });

  it("requires guide review when a compact schema is truncated", async () => {
    const mt = createMetaTools(makeRegistry([wideGuided()]), BASE);
    const searched = textOf(await mt.searchTools({ query: "read", includeSchemas: "compact" })) as SearchResult;
    const tool = required(searched.tools[0]);
    expect(tool.inputSchemaTruncated).toBe(true);
    expect(tool.guideRequired).toBe(true);
    expect(tool.guideRequiredReasons).toEqual(["schema_truncated"]);
  });

  it("clears schema_truncated once describe returns the exact schema", async () => {
    // The reason exists because the agent could not read the whole shape.
    // describe renders it whole, so the reason is spent — and the tool
    // descriptions promise exactly this one waiver and no other.
    const described = await new CatalogService(makeRegistry([wideGuided()]), BASE).describe({
      addresses: ["wide.read"],
    });
    const entry = required(described[0]);
    expect(entry.guide).toBe("connector:wide");
    expect(entry.guideSummary).toBe("Argument meanings for wide operations.");
    expect(entry).not.toHaveProperty("guideRequired");
    expect(entry).not.toHaveProperty("guideRequiredReasons");
  });
});

describe("stored credential drift", () => {
  it("refuses drifted credential reads", async () => {
    let tests = 0;
    const connector: Connector = connectorWith({
      id: "drift",
      kind: "api",
      description: "Drifted credential",
      credential: {
        label: "Service credential",
        fields: [
          { name: "apiKey", label: "API key" },
          { name: "accountId", label: "Account id" },
        ],
      },
      async testCredentials() {
        tests++;
        return { ok: true };
      },
      tools: [
        {
          name: "read",
          annotations: { readOnlyHint: true },
          inputSchema: { type: "object" },
        },
      ],
      call: async (_name, _args, ctx) => ctx.credential!.getAll(),
    });
    const storage = memoryStorage();
    const vault = new CredentialVault(storage, CREDENTIAL_KEY);
    await vault.setAll("drift", { apiKey: "old-key" }, "user_1");
    const registry = makeRegistry([connector], {
      storage,
      credentialVault: vault,
    });
    const mt = createMetaTools(registry, BASE);

    // The drift is observed without touching the connector: no test hook runs.
    expect(await registry.credentialDriftFor("drift")).toBe(STORED_CREDENTIAL_SHAPE_MISMATCH_ERROR);
    expect(tests).toBe(0);

    const called = textOf(
      await mt.callTool({
        address: "drift.read",
        resultMode: "value",
      }),
    ) as { ok: boolean; error: { code: string; message: string } };
    expect(called).toMatchObject({
      ok: false,
      error: {
        code: "auth_required",
        message: STORED_CREDENTIAL_SHAPE_MISMATCH_ERROR,
      },
    });
  });
});

interface ObservedConnector {
  status: string;
  message?: string;
  lastSuccessAt?: string;
  consecutiveFailures: number;
}

/**
 * The health a connector's real calls left behind. Read straight off the
 * registry: the log has no meta-tool reader since #273 removed list_connectors,
 * but it is still what `InvocationService` writes on every attempt, and the
 * derived state below is the one every consumer of it has to compute.
 */
function observe(events: ToolCallActivityEvent[], id: string): ObservedConnector {
  const observed = events.filter((event) => event.connectorId === id);
  const last = observed.at(-1);
  const failures = [...observed].reverse().findIndex((event) => event.outcome === "success");
  const consecutiveFailures = last?.outcome === "success" ? 0 : failures < 0 ? observed.length : failures;
  return {
    status: !last ? "unknown" : last.outcome === "success" ? "ok" : "error",
    ...(last?.errorCode ? { message: last.errorCode } : {}),
    ...(last?.outcome === "success" ? { lastSuccessAt: last.occurredAt } : {}),
    consecutiveFailures,
  };
}

describe("catalog-lookup health accounting", () => {
  it("records a typed auth_required from the catalog without changing its code", async () => {
    const expired: Connector = connectorWith({
      id: "expired",
      kind: "mcp",
      tools: async () => {
        throw new ConnectorCallError(
          "auth_required",
          'Connector "expired" requires authorization — call authorize_connector({ connector: "expired" }).',
        );
      },
      call: async () => null,
    });
    const registry = makeRegistry([expired]);
    const activity = activitySink();
    const parsed = textOf(
      await createMetaTools(registry, BASE, { activity: activity.activity }).callTool({
        address: "expired.read",
        resultMode: "value",
      }),
    ) as { ok: boolean; error: { code: string; message: string } };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("auth_required");
    expect(parsed.error.message).toContain("authorize_connector");
    expect(observe(activity.events, "expired")).toMatchObject({
      status: "error",
      consecutiveFailures: 1,
    });
  });
});

describe("authorize_connector", () => {
  it("returns the browser connection URL without starting the flow", async () => {
    authConnector.startAuthCalls.length = 0;
    const mt = createMetaTools(registry(), BASE);
    const parsed = textOf(await mt.authorizeConnector({ connector: "needsauth" })) as {
      connector: string;
      recovery: string;
      status: string;
      authorizationUrl?: string;
      instructions?: string;
    };
    expect(parsed.connector).toBe("needsauth");
    expect(parsed.recovery).toBe("oauth");
    expect(parsed.status).toBe("auth_required");
    expect(parsed.authorizationUrl).toContain(`${BASE}/connect/needsauth?h=`);
    expect(parsed.instructions).toContain("sign in as the user");
    expect(parsed.instructions).toContain("Then retry the original call");
    expect(parsed.instructions).toContain('connecta.search({ connector: "needsauth" }) inside execute_code');
    expect(authConnector.startAuthCalls).toEqual([]);
  });

  it("INV-5 INV-10: configured credentials conditionally proceed and retain a secret-free operator handoff", async () => {
    const connector = api("static", {
      credential: {
        label: "Service credentials",
        description: "Credentials provisioned by the service operator.",
        fields: [
          {
            name: "email",
            label: "Account email",
            description: "The service account email.",
          },
          {
            name: "apiKey",
            label: "API key",
          },
        ],
      },
      tools: [
        {
          name: "read",
          description: "Read a record",
          annotations: { readOnlyHint: true },
          handler: () => {
            throw new ConnectorCallError("auth_required", "The key was rejected");
          },
        },
      ],
    });
    const storage = memoryStorage();
    const vault = new CredentialVault(storage, CREDENTIAL_KEY);
    await vault.setAll(
      "static",
      {
        email: "operator@example.com",
        apiKey: "do-not-return-this-secret",
      },
      "user_1",
    );
    const reg = makeRegistry([connector], { storage, credentialVault: vault });
    const requestScope = {};
    const mt = createMetaTools(reg, BASE, { requestScope });
    const configured = await mt.authorizeConnector({ connector: "static", force: true });
    expect(textOf(configured)).toMatchObject({
      connector: "static",
      recovery: "ready",
      message: expect.stringContaining(
        "If a call to it just failed with an authentication or operator-configuration error",
      ),
      operatorUrl: `${BASE}/`,
      instructions: expect.stringContaining("Have the operator"),
    });
    expect(JSON.stringify(configured)).not.toContain("operator@example.com");
    expect(JSON.stringify(configured)).not.toContain("do-not-return-this-secret");
    const rejected = textOf(await mt.callTool({ address: "static.read", resultMode: "value" })) as any;
    expect(rejected.error).toMatchObject({ code: "auth_required", recovery: "operator_config" });
    const result = await mt.authorizeConnector({ connector: "static" });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toMatchObject({
      connector: "static",
      recovery: "ready",
      message: expect.stringContaining("otherwise proceed with the call"),
      credential: {
        label: "Service credentials",
        fields: [
          { name: "email", guidance: "The service account email." },
          { name: "apiKey", guidance: "API key" },
        ],
      },
      operatorUrl: `${BASE}/`,
      instructions:
        "Have the operator open operatorUrl, set and test the credential, " +
        "then retry the original call. No redeploy is needed. Shared " +
        "credential mutation requires a signed-in human with access to this " +
        "connector.",
    });
    expect(required(result.content[0]).text).not.toContain("do-not-return-this-secret");
    expect(required(result.content[0]).text).not.toContain("operator@example.com");
    await vault.delete("static");
    const missing = await createMetaTools(reg, BASE).authorizeConnector({ connector: "static" });
    expect(textOf(missing)).toMatchObject({ recovery: "operator_config", operatorUrl: `${BASE}/` });
    expect(textOf(missing)).not.toHaveProperty("message");
    // Configured credentials do not need a UI or any downstream probe.
    await vault.setAll("static", { email: "alice@example.com", apiKey: "evk_91c2e0b84d7a6f35" }, "user_1");
    expect(textOf(await buildMetaTools(reg, BASE).authorizeConnector({ connector: "static" }))).toMatchObject({
      recovery: "ready",
    });
  });
});

describe("probe timeout", () => {
  /** A connector whose downstream tool listing never resolves. */
  const hangingConnector: Connector = connectorWith({
    id: "hang",
    kind: "mcp",
    description: "Never resolves",
    tools: async () => new Promise<never>(() => {}),
    call: async () => {
      throw new Error("n/a");
    },
  });

  it("search_tools degrades a hung connector to unavailable within the timeout", async () => {
    // The fake clock controls deadlines, but not the WebCrypto fingerprint
    // after listTools. Wait for the healthy catalog's complete registry read
    // before advancing time, including on a loaded runner.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const reg = makeRegistry([hangingConnector, calcConnector]);
    let healthyReady!: () => void;
    const healthyCatalogReady = new Promise<void>((resolve) => {
      healthyReady = resolve;
    });
    const getTools = reg.getTools.bind(reg);
    const catalogRead = vi.spyOn(reg, "getTools").mockImplementation(async (...args) => {
      const tools = await getTools(...args);
      if (args[0] === "calc") healthyReady();
      return tools;
    });
    onTestFinished(() => catalogRead.mockRestore());
    const mt = createMetaTools(reg, BASE, {
      probeTimeoutMs: 50,
    });
    let settled = false;
    const pending = mt.searchTools({ query: "add impossible" }).finally(() => {
      settled = true;
    });
    await healthyCatalogReady;
    // Returns rather than hanging, at the probe deadline and not before: the
    // healthy connector still resolves, the hung one is simply absent (its
    // rejected catalog is dropped).
    await vi.advanceTimersByTimeAsync(49);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    const parsed = textOf(await pending) as SearchResult;
    const ids = connectorIds(parsed);
    expect(ids).toContain("calc");
    expect(ids).not.toContain("hang");
    expect(parsed.queryAnalysis).toMatchObject({
      unavailableConnectorCount: 1,
      unmatchedTerms: ["impossible"],
      guidance: expect.stringContaining("catalogs that answered"),
    });

    const scopedPending = mt.searchTools({
      connector: "hang",
      query: "impossible",
    });
    await vi.advanceTimersByTimeAsync(50);
    const scoped = textOf(await scopedPending) as SearchResult;
    expect(scoped.queryAnalysis).toMatchObject({
      connectorScope: "hang",
      unavailableConnectorCount: 1,
      catalogError: {
        code: "timeout",
        retryable: true,
      },
      guidance: expect.stringContaining('Connector "hang" could not be searched'),
    });
    expect(required(scoped.queryAnalysis).guidance).not.toContain("No matching capability");
  });

  it("returns a bounded typed catalog failure only for an explicit connector scope", async () => {
    const typed: Connector = connectorWith({
      id: "billing",
      kind: "api",
      tools: async () => {
        throw new ConnectorCallError(
          "unavailable",
          `Upstream returned 503. Operator must restore access. ${"x".repeat(1_000)}`,
          { retryAfterMs: 30_000 },
        );
      },
      call: async () => null,
    });
    const mt = createMetaTools(makeRegistry([typed, calcConnector]), BASE);
    const scoped = textOf(
      await mt.searchTools({
        connector: "billing",
        query: "list invoices",
      }),
    ) as SearchResult;
    expect(scoped.queryAnalysis).toMatchObject({
      unavailableConnectorCount: 1,
      catalogError: {
        code: "unavailable",
        retryable: true,
        retryAfterMs: 30_000,
      },
    });
    const catalogError = required(required(scoped.queryAnalysis).catalogError);
    expect(catalogError.message).toBe('Connector "billing" catalog lookup failed (unavailable).');
    expect(Buffer.byteLength(catalogError.message)).toBeLessThanOrEqual(515);
    // Pinned, not spread: the call-path classifier may grow connector,
    // operation, recovery, or nextAction fields, and none of them belong on a
    // discovery read.
    expect(Object.keys(catalogError).sort()).toEqual(["code", "message", "retryAfterMs", "retryable"]);

    const unscoped = textOf(await mt.searchTools({ query: "add impossible" })) as SearchResult;
    expect(required(unscoped.queryAnalysis).unavailableConnectorCount).toBe(1);
    expect(required(unscoped.queryAnalysis).catalogError).toBeUndefined();
  });
});

describe("empty-query browse of an unavailable catalog", () => {
  /** A connector with a guide whose catalog never resolves. */
  const unavailable = (): Connector =>
    connectorWith({
      id: "billing",
      kind: "api",
      usageGuide: {
        content: "# Billing\n\nInvoice ids are prefixed.\n",
        summary: "Invoice ids are prefixed.",
        required: true,
      },
      tools: async () => {
        throw new ConnectorCallError("unavailable", "Upstream returned 503. Operator must restore access.", {
          retryAfterMs: 30_000,
        });
      },
      call: async () => null,
    });

  /** A connector that answers, correctly, with nothing. */
  const barren: Connector = connectorWith({
    id: "barren",
    kind: "api",
    tools: [],
    call: async () => null,
  });

  it("distinguishes an unavailable catalog from a genuinely empty one", async () => {
    const mt = createMetaTools(makeRegistry([unavailable(), barren]), BASE);
    const empty = textOf(await mt.searchTools({ connector: "barren", query: "" })) as SearchResult;
    const broken = textOf(await mt.searchTools({ connector: "billing", query: "" })) as SearchResult;
    // Both return no entries, and that is where the resemblance ends.
    expect(empty.tools).toEqual([]);
    expect(broken.tools).toEqual([]);
    expect(empty.queryAnalysis).toBeUndefined();
    expect(required(broken.queryAnalysis).catalogError).toBeDefined();
    expect(JSON.stringify(empty)).not.toEqual(JSON.stringify(broken));
  });
});

describe("empty-query browse of an unconfigured connector", () => {
  /** A configured connector that answers, correctly, with nothing. */
  const barren: Connector = connectorWith({
    id: "barren",
    kind: "api",
    tools: [],
    call: async () => null,
  });

  it("INV-4: names the configured connectors visible on this endpoint", async () => {
    const mt = createMetaTools(makeRegistry([calcConnector, barren]), BASE);
    const browsed = textOf(await mt.searchTools({ connector: "ghost", query: "" })) as SearchResult;
    const serialized = JSON.stringify(browsed);
    expect(serialized).toContain("calc");
    expect(serialized).toContain("barren");
  });
});

function createMetaTools(...args: Parameters<typeof buildMetaTools>) {
  return buildMetaTools(args[0], args[1], {
    canManageAuth: () => true,
    oauthConnectUrl: async (id) => `${args[1]}/connect/${id}?h=test-handoff`,
    credentialHandoffUrl: new URL("/", args[1]).toString(),
    ...args[2],
  });
}
