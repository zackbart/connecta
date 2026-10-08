// Closed options at every built-in factory. A misspelled option used to be
// accepted and ignored, so `api({ maxResultByte })` booted with the default
// cap and nothing said why. Each factory now walks its options against a
// shape checked against its published type and throws with the path before
// reading a value (INV-11). Custom implementations it accepts — stores,
// handlers, loggers, schemas — pass through uninspected.

import { describe, expect, it } from "vitest";
import { ConfigError } from "../src/config-schema.js";
import { accessTokens } from "../src/access-tokens.js";
import { activityHistory } from "../src/activity.js";
import { d1ActivityStore } from "../src/d1.js";
import { artifacts, kvArtifactStore } from "../src/artifacts.js";
import { api, remoteMcp } from "../src/index.js";
import { cloudflare } from "../src/providers/cloudflare/index.js";
import { docs } from "../src/providers/docs/index.js";
import { linear } from "../src/providers/linear/index.js";
import { notion } from "../src/providers/notion/index.js";
import { planningCenter } from "../src/providers/planning-center/index.js";
import { stripe } from "../src/providers/stripe/index.js";
import { vercel } from "../src/providers/vercel/index.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { Connector, ConnectorContext } from "../src/types.js";
import { operatorUi } from "../src/ui.js";

const SECRET = "SENTINEL-getter-text";
const tool = {
  name: "read",
  description: "Read a thing.",
  annotations: { readOnlyHint: true, vendorHint: "kept" },
  handler: () => null,
};
const loose = <T>(value: unknown) => value as T;
/** A D1 binding that answers nothing: activity stores run no statement at construction. */
const D1 = { prepare: () => ({ bind: () => ({}) }), batch: async () => [] } as never;

describe("built-in factory options", () => {
  it.each([
    ["api() top level", () => api("crm", loose({ tools: [tool], maxResultByte: 10 })), 'api("crm").maxResultByte'],
    ["api() oauth", () => api("crm", loose({
      tools: [tool],
      oauth: { authorizationEndpoint: "https://a.example/a", tokenEndpoint: "https://a.example/t",
        clientId: "c", apiOrigins: ["https://api.example"], pcke: false },
    })), 'api("crm").oauth.pcke'],
    ["api() tool", () => api("crm", loose({ tools: [{ ...tool, readOnly: true }] })), 'api("crm").tools[0].readOnly'],
    ["api() call admission rule", () => api("crm", loose({
      tools: [tool], callAdmission: { rules: [{ maxConcurency: 2 }] },
    })), 'api("crm").callAdmission.rules[0].maxConcurency'],
    ["api() credential field", () => api("crm", loose({
      tools: [tool], credential: { label: "Key", fields: [{ name: "a", label: "A", type: "text" }] },
    })), 'api("crm").credential.fields[0].type'],
    ["api() usage guide", () => api("crm", loose({ tools: [tool], usageGuide: { content: "x", requird: true } })),
      'api("crm").usageGuide.requird'],
    ["remoteMcp() top level", () => remoteMcp("docs", loose({ url: "https://mcp.example/mcp", requireHTTPs: true })),
      'remoteMcp("docs").requireHTTPs'],
    ["remoteMcp() headers auth", () => remoteMcp("docs", loose({
      url: "https://mcp.example/mcp", auth: { type: "headers", header: { "X-Key": "k" } },
    })), 'remoteMcp("docs").auth.header'],
    ["remoteMcp() oauth auth", () => remoteMcp("docs", loose({
      url: "https://mcp.example/mcp", auth: { type: "oauth", scopes: "read" },
    })), 'remoteMcp("docs").auth.scopes'],
    ["a provider", () => linear("tracker", loose({ purpose: "Roadmap", access: "read-only", maxResultByte: 1 })),
      'linear("tracker").maxResultByte'],
    ["a hyphenated provider", () => planningCenter("pco", loose({ purpose: "People", pageSize: 5 })),
      'planningCenter("pco").pageSize'],
    ["a provider's other surface", () => cloudflare("cf", loose({ purpose: "Ops", surface: "mcp", accountId: "a" })),
      'cloudflare("cf").accountId'],
    ["a provider surface default", () => notion("wiki", loose({ purpose: "Docs", callAdmission: { rules: [] } })),
      'notion("wiki").callAdmission'],
    ["a provider's narrowed auth", () => stripe("billing", loose({ purpose: "Revenue", auth: { type: "oauth", scope: "x" } })),
      'stripe("billing").auth.scope'],
    ["a Workspace service account", () => docs("docs", loose({
      purpose: "Docs", subject: "a@example.com",
      serviceAccount: { clientEmail: "a@example.com", privateKey: "k", private_key_id: "id" },
    })), 'docs("docs").serviceAccount.private_key_id'],
    ["operatorUi()", () => operatorUi(loose({ brandng: {} })), "operatorUi().brandng"],
    ["operatorUi() theme", () => operatorUi(loose({ branding: { theme: { accentColor: "#fff" } } })),
      "operatorUi().branding.theme.accentColor"],
    ["operatorUi() favicon", () => operatorUi(loose({ branding: { favicon: { url: "/x.svg" } } })),
      "operatorUi().branding.favicon.url"],
    ["accessTokens()", () => accessTokens(memoryStorage(), loose({ maxActiv: 3 })), "accessTokens().maxActiv"],
    ["activityHistory()", () => activityHistory(loose({ store: { record() {} }, deploymentID: "prod" })),
      "activityHistory().deploymentID"],
    ["d1ActivityStore()", () => d1ActivityStore(D1, loose({ retentionDay: 30 })), "d1ActivityStore().retentionDay"],
    ["artifacts() allowlist", () => artifacts(loose({
      store: kvArtifactStore(memoryStorage()), allowlist: { script: [] },
    })), "artifacts().allowlist.script"],
    ["artifacts() limits", () => artifacts(loose({
      store: kvArtifactStore(memoryStorage()), limits: { document: 1 },
    })), "artifacts().limits.document"],
  ] as const)("INV-11: refuses an unknown option in %s with its path", (_, build, path) => {
    expect(build).toThrow(`Unknown option: ${path}.`);
  });

  it("INV-11: refuses an activity retention that is not a positive number of days", () => {
    for (const retentionDays of [0, -1, Number.NaN, Infinity, "30"]) {
      expect(() => d1ActivityStore(D1, { retentionDays: retentionDays as never }))
        .toThrow("d1ActivityStore().retentionDays must be a positive number of days.");
    }
    expect(() => d1ActivityStore(D1, { retentionDays: 30 })).not.toThrow();
  });

  it("INV-11: refuses an accessor in factory options without running it", () => {
    let reads = 0;
    const options = Object.defineProperty({ tools: [tool] }, "maxResultBytes", {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error(SECRET);
      },
    });
    let error: unknown;
    try {
      api("crm", options);
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).toContain('api("crm").maxResultBytes must be a plain value, not a getter or setter.');
    expect(String(error)).not.toContain(SECRET);
    expect(reads).toBe(0);
  });

  it("accepts every declared option and leaves custom implementations uninspected", () => {
    let storeReads = 0;
    const store = {
      get record() {
        storeReads += 1;
        return () => {};
      },
    };
    expect(() => activityHistory({ store, deploymentId: "prod" })).not.toThrow();
    expect(storeReads).toBeGreaterThan(0);
    expect(() => api("crm", {
      title: "CRM",
      description: "Customer records",
      authScope: "shared",
      maxResultBytes: 1_000,
      callAdmission: { rules: [{ maxConcurrency: 1, budget: { kind: "rolling-window", maxCalls: 1, windowMs: 1 } }] },
      usageGuide: { content: "Use it.", summary: "Use it.", required: false },
      credential: { label: "Key", fields: [{ name: "key", label: "Key", inputType: "password" }] },
      validateArgs: true,
      tools: [tool],
    })).not.toThrow();
    expect(() => remoteMcp("docs", {
      url: "https://mcp.example/mcp",
      auth: { type: "credential", credential: { label: "Key" }, header: "X-Key", scheme: null },
      versionNegotiation: "legacy",
      redirects: "same-origin",
      requireHttps: true,
    })).not.toThrow();
    expect(() => cloudflare("cf", { purpose: "Ops", surface: "mcp", callAdmission: { rules: [] } })).not.toThrow();
    expect(() => operatorUi({
      branding: { productName: "Ops", favicon: { href: "/x.svg" }, theme: { accent: "#123456", colorScheme: "dark" } },
    })).not.toThrow();
  });
});

describe("discriminated factory options", () => {
  const url = "https://mcp.example/mcp";
  const headers = { "X-Key": SECRET };
  const MCP_AUTH = '"headers", "credential", "oauth"';
  const STRIPE_AUTH = '"oauth", "headers", "credential"';
  const SURFACE = '"api", "mcp"';

  // A misspelled or missing discriminant used to select no case, so the walk
  // checked nothing and the factory, finding no known `type`, built the
  // connector with no authentication at all.
  it.each([
    ["remoteMcp() auth with an unknown type", () => remoteMcp("docs", loose({
      url, auth: { type: "header", headers, maxResultByte: 1 },
    })), `remoteMcp("docs").auth.type must be one of ${MCP_AUTH}.`],
    ["remoteMcp() auth with a non-string type", () => remoteMcp("docs", loose({ url, auth: { type: 1, headers } })),
      `remoteMcp("docs").auth.type must be one of ${MCP_AUTH}.`],
    ["remoteMcp() auth with an inherited type", () => remoteMcp("docs", loose({
      url, auth: Object.assign(Object.create({ type: "headers" }), { headers }),
    })), 'remoteMcp("docs").auth must be a plain object.'],
    ["remoteMcp() auth without a type", () => remoteMcp("docs", loose({ url, auth: { headers } })),
      `remoteMcp("docs").auth.type is required: one of ${MCP_AUTH}.`],
    ["remoteMcp() auth that is a string", () => remoteMcp("docs", loose({ url, auth: "headers" })),
      'remoteMcp("docs").auth must be an object.'],
    ["remoteMcp() auth that is null", () => remoteMcp("docs", loose({ url, auth: null })),
      'remoteMcp("docs").auth must be an object.'],
    ["remoteMcp() auth that is an array", () => remoteMcp("docs", loose({ url, auth: [{ type: "headers", headers }] })),
      'remoteMcp("docs").auth must be an object.'],
    ["a provider's remote MCP auth", () => cloudflare("cf", loose({ purpose: "Ops", surface: "mcp", auth: { headers } })),
      `cloudflare("cf") requires auth.type is required: one of ${MCP_AUTH}.`],
    ["a provider's narrowed auth", () => stripe("billing", loose({ purpose: "Revenue", auth: { type: "OAuth" } })),
      `stripe("billing") requires auth.type to be one of ${STRIPE_AUTH}.`],
    ["a provider's narrowed auth without a type", () => stripe("billing", loose({ purpose: "Revenue", auth: {} })),
      `stripe("billing") requires auth.type is required: one of ${STRIPE_AUTH}.`],
    ["notion() surface", () => notion("wiki", loose({ purpose: "Docs", surface: "MCP" })),
      `notion("wiki") requires surface to be one of ${SURFACE}.`],
    ["vercel() surface", () => vercel("deploys", loose({ purpose: "Deploys", surface: "hosted" })),
      `vercel("deploys") requires surface to be one of ${SURFACE}.`],
    ["cloudflare() surface", () => cloudflare("cf", loose({ purpose: "Ops", surface: null })),
      `cloudflare("cf") requires surface to be one of ${SURFACE}.`],
  ] as const)("INV-11: refuses %s with its path and valid values", (_, build, message) => {
    let error: unknown;
    try {
      build();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect(String(error)).toContain(message);
    expect(String(error)).not.toContain(SECRET);
  });

  it.each([
    ["headers", { type: "headers", headers, maxResultByte: 1 }, 'remoteMcp("docs").auth.maxResultByte'],
    ["credential", { type: "credential", header: "X-Key", schema: null }, 'remoteMcp("docs").auth.schema'],
    ["oauth", { type: "oauth", headers }, 'remoteMcp("docs").auth.headers'],
  ] as const)("INV-11: refuses an unknown key in the %s auth case", (_, auth, path) => {
    expect(() => remoteMcp("docs", loose({ url, auth }))).toThrow(`Unknown option: ${path}.`);
  });

  it("INV-11: refuses an accessor discriminant without running it", () => {
    let reads = 0;
    const auth = Object.defineProperty({ headers }, "type", {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error(SECRET);
      },
    });
    expect(() => remoteMcp("docs", loose({ url, auth })))
      .toThrow('remoteMcp("docs").auth.type must be a plain value, not a getter or setter.');
    expect(reads).toBe(0);
  });

  it("still selects every valid case and a union's default", () => {
    expect(remoteMcp("docs", { url, auth: { type: "headers", headers } }).describe?.().auth?.mode).toBe("headers");
    expect(remoteMcp("docs", { url, auth: { type: "oauth" } }).describe?.().auth?.mode).toBe("oauth");
    expect(remoteMcp("docs", loose({ url, auth: undefined })).describe?.().auth?.mode).toBe("none");
    expect(() => notion("wiki", { purpose: "Docs" })).not.toThrow();
    expect(() => notion("wiki", loose({ purpose: "Docs", surface: undefined }))).not.toThrow();
    expect(() => vercel("deploys", { purpose: "Deploys", surface: "mcp" })).not.toThrow();
  });
});

describe("factory options read as plain data", () => {
  it("INV-11: refuses an accessor inside an options array without running it", () => {
    let reads = 0;
    const apiOrigins = Object.defineProperty([], "0", {
      enumerable: true,
      configurable: true,
      get() {
        reads += 1;
        throw new Error(SECRET);
      },
    });
    let error: unknown;
    try {
      api("crm", loose({
        tools: [tool],
        oauth: { authorizationEndpoint: "https://a.example/a", tokenEndpoint: "https://a.example/t", clientId: "c", apiOrigins },
      }));
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).toContain('api("crm").oauth.apiOrigins[0] must be a plain value, not a getter or setter.');
    expect(String(error)).not.toContain(SECRET);
    expect(reads).toBe(0);
  });

  it("INV-11: builds from descriptors alone, so an options Proxy's get trap never runs", () => {
    let gets = 0;
    const hostile = <T extends object>(target: T): T => new Proxy(target, {
      get() {
        gets += 1;
        throw new Error(SECRET);
      },
      has() {
        throw new Error(SECRET);
      },
    });
    const connector = remoteMcp("docs", hostile({
      url: "https://mcp.example/mcp",
      auth: hostile({ type: "headers", headers: { "X-Key": "k" } }),
    }));
    expect(connector.describe?.().auth?.mode).toBe("headers");
    // A tool carries behaviour and passes through as given; see the tool suite.
    expect(() => api("crm", hostile({ tools: [tool] }))).not.toThrow();
    expect(() => linear("tracker", hostile({ purpose: "Roadmap", access: "read-only" }))).not.toThrow();
    expect(gets).toBe(0);
  });

  it("INV-11: refuses options whose inspection throws, by path and without the trap's text", () => {
    const revocable = Proxy.revocable({ url: "https://mcp.example/mcp" }, {});
    revocable.revoke();
    const cases = [
      [() => remoteMcp("docs", loose(new Proxy({}, { ownKeys() { throw new Error(SECRET); } }))), 'remoteMcp("docs")'],
      [() => remoteMcp("docs", loose(revocable.proxy)), 'remoteMcp("docs")'],
      [() => remoteMcp("docs", loose({
        url: "https://mcp.example/mcp",
        auth: new Proxy({ type: "headers" }, { getOwnPropertyDescriptor() { throw new Error(SECRET); } }),
      })), 'remoteMcp("docs").auth'],
    ] as const;
    for (const [build, path] of cases) {
      let error: unknown;
      try {
        build();
      } catch (caught) {
        error = caught;
      }
      expect(String(error)).toContain(`${path} could not be read as plain configuration.`);
      expect(String(error)).not.toContain(SECRET);
    }
  });
});

describe("factory options keep behaviour in place", () => {
  const ctx = loose<ConnectorContext>({ storage: memoryStorage(), logger: console, baseUrl: "https://connecta.example" });
  const call = (connector: Connector, name = "read") => connector.callTool!(name, {}, ctx);
  const annotations = { readOnlyHint: true };

  it("INV-11: calls a class-instance tool's prototype handler on the instance", async () => {
    class ReadTool {
      readonly name = "read";
      readonly description = "Read a thing.";
      readonly annotations = annotations;
      #rows = ["a", "b"];
      handler() {
        return this.#rows.length;
      }
    }
    const instance = new ReadTool();
    await expect(call(api("crm", { tools: [instance] }))).resolves.toBe(2);
  });

  it("INV-11: keeps the receiver of an own handler that reads private fields", async () => {
    class Counter {
      #count = 41;
      readonly name = "read";
      readonly description = "Count a thing.";
      readonly annotations = annotations;
      readonly handler: () => number;
      constructor() {
        this.handler = function (this: Counter) {
          return ++this.#count;
        };
      }
    }
    await expect(call(api("crm", { tools: [new Counter()] }))).resolves.toBe(42);
  });

  it("INV-11: calls bound and arrow handlers as written", async () => {
    const owner = { secret: 7, read(this: { secret: number }) { return this.secret; } };
    const connector = api("crm", {
      tools: [
        { name: "read", description: "Read.", annotations, handler: owner.read.bind(owner) },
        { name: "arrow", description: "Arrow.", annotations, handler: () => owner.secret + 1 },
      ],
    });
    await expect(call(connector, "read")).resolves.toBe(7);
    await expect(call(connector, "arrow")).resolves.toBe(8);
  });

  it("INV-11: still checks a tool's own keys and declared accessors, inherited ones included", () => {
    class Extra {
      readonly name = "read";
      readonly description = "Read.";
      readonly annotations = annotations;
      readonly readOnly = true;
      handler() {}
    }
    expect(() => api("crm", { tools: [loose(new Extra())] })).toThrow('Unknown option: api("crm").tools[0].readOnly.');
    let reads = 0;
    class Computed {
      readonly name = "read";
      readonly annotations = annotations;
      get description(): string {
        reads += 1;
        throw new Error(SECRET);
      }
      handler() {}
    }
    let error: unknown;
    try {
      api("crm", { tools: [new Computed()] });
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).toContain('api("crm").tools[0].description must be a plain value, not a getter or setter.');
    expect(String(error)).not.toContain(SECRET);
    expect(reads).toBe(0);
  });

  it("INV-11: refuses a tool without a handler at construction", () => {
    expect(() => api("crm", loose({ tools: [{ name: "read", description: "Read.", annotations }] })))
      .toThrow('api() tool "crm.read" needs a handler function.');
  });
});

describe("factory options refuse arrays and instances where plain data belongs", () => {
  it("INV-11: refuses array options with a path, unread", () => {
    let reads = 0;
    const options = Object.defineProperty([], "url", {
      enumerable: true,
      get() {
        reads += 1;
        return "https://mcp.example/mcp";
      },
    });
    Object.assign(options, { maxResultByte: 1 });
    expect(() => remoteMcp("docs", loose(options))).toThrow('remoteMcp("docs") must be an object.');
    expect(() => linear("tracker", loose([{ purpose: "Roadmap" }]))).toThrow('linear("tracker") requires an object.');
    expect(reads).toBe(0);
  });

  it.each([
    ["an array call admission", () => api("crm", loose({ tools: [tool], callAdmission: [{ rules: [] }] })),
      'api("crm").callAdmission must be an object.'],
    ["an array usage guide", () => api("crm", loose({ tools: [tool], usageGuide: [{ content: "x" }] })),
      'api("crm").usageGuide must be an object.'],
    ["an array admission rule budget", () => api("crm", loose({
      tools: [tool], callAdmission: { rules: [{ budget: [] }] },
    })), 'api("crm").callAdmission.rules[0].budget must be an object.'],
    ["an array of headers", () => remoteMcp("docs", loose({
      url: "https://mcp.example/mcp", auth: { type: "headers", headers: [["X-Key", "k"]] },
    })), 'remoteMcp("docs").auth.headers must be an object.'],
    ["a class instance as options", () => linear("tracker", loose(new (class { purpose = "Roadmap"; })())),
      'linear("tracker") requires a plain object.'],
    ["a class instance as branding", () => operatorUi(loose({ branding: new (class { productName = "Ops"; })() })),
      "operatorUi().branding must be a plain object."],
  ] as const)("INV-11: refuses %s with its path", (_, build, message) => {
    expect(build).toThrow(message);
  });

  it("accepts null-prototype option records", () => {
    const options = Object.assign(Object.create(null) as object, { purpose: "Roadmap", access: "read-only" });
    expect(() => linear("tracker", loose(options))).not.toThrow();
  });
});

describe("factory string maps read as plain data", () => {
  const oauth = { authorizationEndpoint: "https://a.example/a", tokenEndpoint: "https://a.example/t", clientId: "c" };
  const getter = (counter: { reads: number }) => ({
    enumerable: true,
    get() {
      counter.reads += 1;
      throw new Error(SECRET);
    },
  });

  it.each([
    ["api() authorizationParams", (map: object) => api("crm", loose({ tools: [tool], oauth: { ...oauth, authorizationParams: map } })),
      'api("crm").oauth.authorizationParams.prompt'],
    ["api() tokenRequestHeaders", (map: object) => api("crm", loose({ tools: [tool], oauth: { ...oauth, tokenRequestHeaders: map } })),
      'api("crm").oauth.tokenRequestHeaders.prompt'],
    ["remoteMcp() headers", (map: object) => remoteMcp("docs", loose({
      url: "https://mcp.example/mcp", auth: { type: "headers", headers: map },
    })), 'remoteMcp("docs").auth.headers.prompt'],
    ["stripe() headers", (map: object) => stripe("billing", loose({
      purpose: "Revenue", mode: "sandbox", auth: { type: "headers", headers: map },
    })), 'stripe("billing") requires auth.headers.prompt'],
  ] as const)("INV-11: refuses an accessor or a non-string in %s by path, unrun and unechoed", (_, build, path) => {
    const counter = { reads: 0 };
    let error: unknown;
    try {
      build(Object.defineProperty({}, "prompt", getter(counter)));
    } catch (caught) {
      error = caught;
    }
    const relation = path.startsWith("stripe(") ? " to be " : " must be ";
    expect(String(error)).toContain(`${path}${relation}a plain value, not a getter or setter.`);
    expect(String(error)).not.toContain(SECRET);
    expect(counter.reads).toBe(0);
    expect(() => build({ prompt: { toString: () => SECRET } })).toThrow(`${path}${relation}a string.`);
    try {
      build({ prompt: { toString: () => SECRET } });
    } catch (caught) {
      expect(String(caught)).not.toContain(SECRET);
    }
  });

  it("copies string maps so later changes do not reach the connector", () => {
    const headers: Record<string, string> = { "X-Key": "k" };
    const connector = remoteMcp("docs", { url: "https://mcp.example/mcp", auth: { type: "headers", headers } });
    headers["X-Late"] = "late";
    expect(connector.describe?.().auth).toMatchObject({ mode: "headers", headerNames: ["X-Key"] });
  });
});
