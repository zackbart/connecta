import { describe, expect, it } from "vitest";
import { api, remoteMcp } from "../src/index.js";
import type { Connector, ConnectorCallAdmissionPolicy } from "../src/types.js";
import { calcConnector, makeRegistry } from "./helpers.js";
import { providerFixtures } from "./providers.generated.js";
import type { ContractFixture } from "./fixtures/provider-contract.js";

const valid: ConnectorCallAdmissionPolicy = { rules: [{ maxConcurrency: 2 }] };
const invalid = [
  false,
  null,
  0,
  "",
  [],
  {},
  { rules: [] },
  { rules: [null] },
  { rules: [{ maxConcurrency: 0 }] },
  { rules: [{ maxConcurrency: 1, maxQueueSize: null }] },
  { rules: [{ budget: false }] },
  { rules: [{ budget: { kind: "rolling-window", maxCalls: 0, windowMs: 1 } }] },
  { rules: [{ maxConcurrency: 1, partitionKey: "workspace" }] },
];

const factories = [
  {
    name: "remoteMcp",
    create: (callAdmission?: unknown) =>
      remoteMcp("service", {
        url: "https://mcp.example/mcp",
        callAdmission: callAdmission as ConnectorCallAdmissionPolicy,
      }),
  },
  {
    name: "api",
    create: (callAdmission?: unknown) =>
      api("service", { tools: [], callAdmission: callAdmission as ConnectorCallAdmissionPolicy }),
  },
  {
    name: "custom connector registry",
    create: (callAdmission?: unknown) => makeRegistry([{ ...calcConnector, callAdmission } as Connector]),
  },
];

describe.each(factories)("$name admission options", ({ create }) => {
  it.each(invalid.map((callAdmission) => ({ callAdmission })))(
    "INV-11: refuses malformed callAdmission %j at construction",
    ({ callAdmission }) => {
      expect(() => create(callAdmission)).toThrow(/callAdmission/);
    },
  );

  it("INV-11: accepts omission, undefined, and a valid policy", () => {
    expect(() => create()).not.toThrow();
    expect(() => create(undefined)).not.toThrow();
    expect(() => create(valid)).not.toThrow();
  });
});

it("INV-11: registers a custom policy and leaves only omitted or undefined policies unadmitted", () => {
  const registry = makeRegistry([
    { ...calcConnector, id: "omitted" },
    { ...calcConnector, id: "undefined", callAdmission: undefined },
    { ...calcConnector, id: "limited", callAdmission: valid },
  ]);
  expect(Object.keys(registry.callAdmissionSnapshot())).toEqual(["limited"]);
  expect(remoteMcp("remote", { url: "https://mcp.example/mcp" }).callAdmission).toBeUndefined();
  expect(api("local", { tools: [] }).callAdmission).toBeUndefined();
});

// The generated membership list and each provider's own cases cover every
// maintained provider and its auth/mode variants without a second provider list.
const scenarios = (providerFixtures as readonly ContractFixture[]).flatMap((fixture) =>
  fixture.cases.map((scenario) => ({
    name: `${fixture.name}/${scenario.label}`,
    provider: fixture.name,
    create: (options: Record<string, unknown> = {}) => fixture.create("fixture", { ...scenario.options, ...options }),
    options: scenario.options,
  })),
);

// Published defaults, including providers whose default is no admission.
function documentedDefault(provider: string, options: Record<string, unknown>) {
  const auth = options.auth as { type?: string } | undefined;
  switch (provider) {
    case "ccb":
      return { maxConcurrency: undefined, budget: { kind: "rolling-window", maxCalls: 60, windowMs: 60_000 } };
    case "cloudflare":
      return auth?.type === "oauth"
        ? undefined
        : { maxConcurrency: 6, budget: { kind: "rolling-window", maxCalls: 1200, windowMs: 300_000 } };
    case "mixpanel":
      return options.via === "mcp"
        ? undefined
        : { maxConcurrency: 5, budget: { kind: "rolling-window", maxCalls: 60, windowMs: 3_600_000 } };
    case "notion":
      return auth?.type === "oauth"
        ? undefined
        : { maxConcurrency: 3, budget: { kind: "rolling-window", maxCalls: 180, windowMs: 60_000 } };
    case "overflow":
      return { maxConcurrency: 4, budget: { kind: "rolling-window", maxCalls: 120, windowMs: 60_000 } };
    case "planning-center":
      return { maxConcurrency: 5, budget: { kind: "rolling-window", maxCalls: 100, windowMs: 20_000 } };
    case "stripe": {
      const production = options.mode === "production";
      return {
        maxConcurrency: production ? 8 : 4,
        budget: { kind: "rolling-window", maxCalls: production ? 100 : 25, windowMs: 1000 },
      };
    }
    default:
      return undefined;
  }
}

describe.each(scenarios)("$name admission options", ({ create, provider, options }) => {
  it.each(invalid.map((callAdmission) => ({ callAdmission })))(
    "INV-11: refuses malformed callAdmission %j at provider construction",
    ({ callAdmission }) => {
      expect(() => create({ callAdmission })).toThrow(/callAdmission/);
    },
  );

  it("INV-11: keeps the documented default for omitted and undefined policies", () => {
    // Some fixture scenarios exercise an override. Remove it for this check.
    const omitted = { ...options };
    delete omitted.callAdmission;
    const fixture = (providerFixtures as readonly ContractFixture[]).find((fixture) => fixture.name === provider)!;
    const connector = fixture.create("fixture", omitted);
    const rule = connector.callAdmission?.rules[0];
    const summary = rule === undefined ? undefined : { maxConcurrency: rule.maxConcurrency, budget: rule.budget };
    expect(summary).toEqual(documentedDefault(provider, omitted));
    try {
      const overridden = create({ callAdmission: valid });
      expect(overridden.callAdmission).toEqual(valid);
    } catch (error) {
      // Fixed-policy variants do not expose an override at all. They must
      // reject the option by name, never accept and silently ignore it.
      expect(String(error)).toMatch(/Unknown option.*\.callAdmission/);
      return;
    }
    expect(fixture.create("fixture", { ...omitted, callAdmission: undefined }).callAdmission).toEqual(
      connector.callAdmission,
    );
  });
});
