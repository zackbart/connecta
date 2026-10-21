import { describe, expect, it } from "vitest";
import { api, remoteMcp } from "../src/index.js";
import type { Connector, ConnectorCallAdmissionPolicy } from "../src/types.js";
import { calcConnector, makeRegistry } from "./helpers.js";
import { providerFixtures } from "./providers.generated.js";
import type { ContractFixture } from "./fixtures/provider-contract.js";

const valid: ConnectorCallAdmissionPolicy = { rules: [{ maxConcurrency: 2 }] };
// Falsy values never disable admission; one malformed rule, budget, and key.
const invalid = [null, { rules: [{ maxConcurrency: 0 }] }, { rules: [{ budget: false }] }];
// Each provider passes a defined policy through the shared schema; `null`
// catches a `??` or `||` default, and one malformed rule catches a bypass.
const invalidForProviders = [null, { rules: [{ maxConcurrency: 0 }] }];

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
    { ...calcConnector, id: "undefined", callAdmission: undefined } as unknown as Connector,
    { ...calcConnector, id: "limited", callAdmission: valid },
  ]);
  expect(Object.keys(registry.callAdmissionSnapshot())).toEqual(["limited"]);
  expect(remoteMcp("remote", { url: "https://mcp.example/mcp" }).callAdmission).toBeUndefined();
  expect(api("local", { tools: [] }).callAdmission).toBeUndefined();
});

// One configurable policy and one fixed OAuth policy exercise the shared
// provider construction path; provider fixtures cover the other auth variants.
const scenarios = (providerFixtures as readonly ContractFixture[]).flatMap((fixture) =>
  fixture.cases
    .filter((scenario) => fixture.name === "stripe" && ["default", "oauth"].includes(scenario.label))
    .map((scenario) => ({
      name: `${fixture.name}/${scenario.label}`,
      provider: fixture.name,
      create: (options: Record<string, unknown> = {}) => fixture.create("fixture", { ...scenario.options, ...options }),
      options: scenario.options,
    })),
);

// Published defaults, including providers whose default is no admission.
function documentedDefault(provider: string, options: Record<string, unknown>) {
  switch (provider) {
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
  it.each(invalidForProviders.map((callAdmission) => ({ callAdmission })))(
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
