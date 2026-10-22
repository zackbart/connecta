// Closed options at every built-in factory. A misspelled option used to be
// accepted and ignored, so `api({ maxResultByte })` booted with the default
// cap and nothing said why. Each factory now walks its options against a
// shape checked against its published type and throws with the path before
// reading a value (INV-11). Custom implementations it accepts — stores,
// handlers, loggers, schemas — pass through uninspected.

import { describe, expect, it } from "vitest";
import { ConfigError } from "../src/config-schema.js";
import { activityHistory } from "../src/activity.js";
import { api, remoteMcp } from "../src/index.js";
import { cloudflare } from "../src/providers/cloudflare/index.js";
import { linear } from "../src/providers/linear/index.js";
import { notion } from "../src/providers/notion/index.js";
import { stripe } from "../src/providers/stripe/index.js";
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

describe("built-in factory options", () => {
  it.each([
    ["api() top level", () => api("crm", loose({ tools: [tool], maxResultByte: 10 })), 'api("crm").maxResultByte'],
    [
      "remoteMcp() headers auth",
      () =>
        remoteMcp(
          "docs",
          loose({
            url: "https://mcp.example/mcp",
            auth: { type: "headers", header: { "X-Key": "k" } },
          }),
        ),
      'remoteMcp("docs").auth.header',
    ],
    [
      "a provider's other auth case",
      () => stripe("billing", loose({ purpose: "Revenue", auth: { type: "oauth" }, mode: "sandbox" })),
      'stripe("billing").mode',
    ],
    ["operatorUi()", () => operatorUi(loose({ brandng: {} })), "operatorUi().brandng"],
  ] as const)("INV-11: refuses an unknown option in %s with its path", (_, build, path) => {
    expect(build).toThrow(`Unknown option: ${path}.`);
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
    expect(() =>
      api("crm", {
        title: "CRM",
        description: "Customer records",
        authScope: "shared",
        maxResultBytes: 1_000,
        callAdmission: { rules: [{ maxConcurrency: 1, budget: { kind: "rolling-window", maxCalls: 1, windowMs: 1 } }] },
        usageGuide: { content: "Use it.", summary: "Use it.", required: false },
        credential: { label: "Key", fields: [{ name: "key", label: "Key", inputType: "password" }] },
        validateArgs: true,
        tools: [tool],
      }),
    ).not.toThrow();
    expect(() =>
      remoteMcp("docs", {
        url: "https://mcp.example/mcp",
        auth: { type: "credential", credential: { label: "Key" }, header: "X-Key", scheme: null },
        versionNegotiation: "legacy",
        redirects: "same-origin",
        requireHttps: true,
      }),
    ).not.toThrow();
    expect(() =>
      cloudflare("cf", { purpose: "Ops", auth: { type: "oauth" }, callAdmission: { rules: [{ maxConcurrency: 2 }] } }),
    ).not.toThrow();
    expect(() =>
      notion("wiki", {
        purpose: "Docs",
        auth: { type: "token" },
        callAdmission: { rules: [{ budget: { kind: "rolling-window", maxCalls: 600, windowMs: 60_000 } }] },
      }),
    ).not.toThrow();
    expect(() =>
      operatorUi({
        branding: {
          productName: "Ops",
          favicon: { href: "/x.svg" },
          theme: { accent: "#123456", colorScheme: "dark" },
        },
      }),
    ).not.toThrow();
  });
});

describe("discriminated factory options", () => {
  const url = "https://mcp.example/mcp";
  const headers = { "X-Key": SECRET };
  const MCP_AUTH = '"request", "headers", "credential", "oauth"';
  const STRIPE_AUTH = '"oauth", "apiKey"';

  // A misspelled or missing discriminant used to select no case, so the walk
  // checked nothing and the factory, finding no known `type`, built the
  // connector with no authentication at all.
  it.each([
    [
      "remoteMcp() auth with an unknown type",
      () =>
        remoteMcp(
          "docs",
          loose({
            url,
            auth: { type: "header", headers, maxResultByte: 1 },
          }),
        ),
      `remoteMcp("docs").auth.type must be one of ${MCP_AUTH}.`,
    ],
    [
      "remoteMcp() auth without a type",
      () => remoteMcp("docs", loose({ url, auth: { headers } })),
      `remoteMcp("docs").auth.type is required: one of ${MCP_AUTH}.`,
    ],
    [
      // 0.28 defaulted some providers to REST; a silent OAuth default would be a trap.
      "a provider's required auth when omitted",
      () => stripe("billing", loose({ purpose: "Revenue" })),
      `stripe("billing") requires auth.type is required: one of ${STRIPE_AUTH}.`,
    ],
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

  it("INV-11: refuses an accessor discriminant without running it", () => {
    let reads = 0;
    const auth = Object.defineProperty({ headers }, "type", {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error(SECRET);
      },
    });
    expect(() => remoteMcp("docs", loose({ url, auth }))).toThrow(
      'remoteMcp("docs").auth.type must be a plain value, not a getter or setter.',
    );
    expect(reads).toBe(0);
  });
});

describe("factory options read as plain data", () => {
  it("INV-11: refuses options whose inspection throws, by path and without the trap's text", () => {
    const revocable = Proxy.revocable({ url: "https://mcp.example/mcp" }, {});
    revocable.revoke();
    const cases = [
      [
        () =>
          remoteMcp(
            "docs",
            loose(
              new Proxy(
                {},
                {
                  ownKeys() {
                    throw new Error(SECRET);
                  },
                },
              ),
            ),
          ),
        'remoteMcp("docs")',
      ],
      [() => remoteMcp("docs", loose(revocable.proxy)), 'remoteMcp("docs")'],
      [
        () =>
          remoteMcp(
            "docs",
            loose({
              url: "https://mcp.example/mcp",
              auth: new Proxy(
                { type: "headers" },
                {
                  getOwnPropertyDescriptor() {
                    throw new Error(SECRET);
                  },
                },
              ),
            }),
          ),
        'remoteMcp("docs").auth',
      ],
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
  const ctx = loose<ConnectorContext>({
    storage: memoryStorage(),
    logger: console,
    baseUrl: "https://connecta.example",
  });
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
    expect(() => api("crm", loose({ tools: [{ name: "read", description: "Read.", annotations }] }))).toThrow(
      'api() tool "crm.read" needs a handler function.',
    );
  });
});

describe("factory options refuse arrays and instances where plain data belongs", () => {
  it.each([
    [
      "an array of headers",
      () =>
        remoteMcp(
          "docs",
          loose({
            url: "https://mcp.example/mcp",
            auth: { type: "headers", headers: [["X-Key", "k"]] },
          }),
        ),
      'remoteMcp("docs").auth.headers must be an object.',
    ],
    [
      "a class instance as options",
      () =>
        linear(
          "tracker",
          loose(
            new (class {
              purpose = "Roadmap";
            })(),
          ),
        ),
      'linear("tracker") requires a plain object.',
    ],
  ] as const)("INV-11: refuses %s with its path", (_, build, message) => {
    expect(build).toThrow(message);
  });
});

describe("factory string maps read as plain data", () => {
  const getter = (counter: { reads: number }) => ({
    enumerable: true,
    get() {
      counter.reads += 1;
      throw new Error(SECRET);
    },
  });

  it.each([
    [
      "remoteMcp() headers",
      (map: object) =>
        remoteMcp(
          "docs",
          loose({
            url: "https://mcp.example/mcp",
            auth: { type: "headers", headers: map },
          }),
        ),
      'remoteMcp("docs").auth.headers.prompt',
    ],
  ] as const)("INV-11: refuses an accessor or a non-string in %s by path, unrun and unechoed", (_, build, path) => {
    const counter = { reads: 0 };
    let error: unknown;
    try {
      build(Object.defineProperty({}, "prompt", getter(counter)));
    } catch (caught) {
      error = caught;
    }
    const relation = " must be ";
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
});
