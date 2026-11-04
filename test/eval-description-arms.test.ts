// Node-only: reads eval modules and provider fixtures from the checkout.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  armViolations,
  DESCRIPTION_ARMS,
  exampleArguments,
  OVERRIDES,
  parseDescriptionArm,
  toolUnderArm,
  withDescriptionArm,
} from "../eval/deploy/description-arms/index.js";
import { PROTECTED } from "../eval/deploy/description-arms/protected.js";
import { propertyText } from "../eval/deploy/description-arms/properties.js";
import { DESCRIPTION_PLAN } from "../eval/description-plan.js";
import { NAMED_OPERATIONS, signTest, trialAttempts, descriptionMetrics } from "../eval/report/descriptions.js";
import { ACTIVE_TASKS } from "../eval/tasks/index.js";
import { workerRefusal } from "../eval/deploy/targets.js";
import { compare } from "../eval/compare.js";
import { CCB_NAMED } from "../src/providers/ccb/api.js";
import { QUICKBOOKS_NAMED } from "../src/providers/quickbooks/api.js";
import { createAuthored as ccbTools } from "../src/providers/ccb/fixtures.js";
import { createAuthored as cloudflareTools } from "../src/providers/cloudflare/fixtures.js";
import { createAuthored as githubTools } from "../src/providers/github/fixtures.js";
import { createAuthored as quickbooksTools } from "../src/providers/quickbooks/fixtures.js";
import { createAuthored as sheetsTools } from "../src/providers/sheets/fixtures.js";
import { createAuthored as stripeTools } from "../src/providers/stripe/fixtures.js";
import { validateToolInput } from "../src/validate.js";
import type { TrialResult } from "../eval/agent/run.js";
import type { AgentResultFile } from "../eval/report/summary.js";
import type { JsonSchema } from "../src/types.js";

const FACTORIES = {
  stripe: stripeTools,
  github: githubTools,
  cloudflare: cloudflareTools,
  ccb: ccbTools,
  quickbooks: quickbooksTools,
  sheets: sheetsTools,
} as const;
const catalog = (provider: keyof typeof FACTORIES) => FACTORIES[provider]().staticTools!;
const providers = Object.keys(FACTORIES) as (keyof typeof FACTORIES)[];
const schemaProblems = (schema: unknown, args: unknown): string[] => {
  const refused = validateToolInput(schema as JsonSchema, args, { address: "arm.example" });
  return refused ? [refused.message] : [];
};

describe("description arms", () => {
  it("cover exactly the planned providers", () => {
    expect(Object.keys(OVERRIDES).sort()).toEqual([...providers].sort());
    expect(new Set(DESCRIPTION_PLAN.stageA.tasks.map((task) => task.provider))).toEqual(new Set(providers));
  });

  it.each(providers)("are valid against %s's real catalog", (provider) => {
    for (const arm of DESCRIPTION_ARMS)
      expect(armViolations(provider, catalog(provider), arm, schemaProblems), arm).toEqual([]);
  });

  it("treat a dropped protected clause as invalid", () => {
    const tool = catalog("quickbooks").find((entry) => entry.name === "create_invoice")!;
    const clause = PROTECTED.quickbooks!.create_invoice!.find((entry) => entry.id === "no blind retry")!;
    expect(clause.pattern.test(toolUnderArm(tool, "quickbooks", "terse").description!)).toBe(true);
    const stripped = {
      ...tool,
      description: tool.description!.replace(/never blindly create again/i, "try again if needed"),
    };
    expect(armViolations("quickbooks", [stripped], "control", schemaProblems).join("\n")).toContain("no blind retry");
    const full = catalog("quickbooks").filter((entry) => entry.name !== "create_invoice");
    expect(armViolations("quickbooks", full, "terse", schemaProblems).join("\n")).toContain("unknown tool");
  });

  it("change only description strings and reach the served catalog", async () => {
    const connector = FACTORIES.stripe();
    const before = structuredClone(connector.staticTools!);
    withDescriptionArm(connector, "stripe", "terse");
    const write = connector.staticTools!.find((tool) => tool.name === "stripe_api_write")!;
    expect(write.description).not.toEqual(before.find((tool) => tool.name === "stripe_api_write")!.description);
    expect(write.annotations).toEqual(before.find((tool) => tool.name === "stripe_api_write")!.annotations);
    expect((write.inputSchema as { required: string[] }).required).toEqual(
      (before.find((tool) => tool.name === "stripe_api_write")!.inputSchema as { required: string[] }).required,
    );
    const served = await connector.listTools({
      storage: undefined,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      baseUrl: "https://connecta.example",
      credential: { get: async () => "token" },
    } as never);
    expect(served.find((tool) => tool.name === "stripe_api_write")!.description).toEqual(write.description);
  });

  it("leave control and other providers untouched", () => {
    const connector = FACTORIES.stripe();
    const before = JSON.stringify(connector.staticTools);
    withDescriptionArm(connector, "stripe", "control");
    withDescriptionArm(connector, "stripe", undefined);
    withDescriptionArm(connector, "planning-center", "terse");
    withDescriptionArm(connector, undefined, "terse");
    expect(JSON.stringify(connector.staticTools)).toEqual(before);
  });

  it("refuse an example its own schema refuses", () => {
    const tool = catalog("stripe").find((entry) => entry.name === "stripe_api_write")!;
    expect(schemaProblems(tool.inputSchema, { method: "POST" }).join()).toContain("path");
    expect(schemaProblems(tool.inputSchema, { method: "POST", path: "/v1/refunds" })).toEqual([]);
  });

  it("refuse an unknown arm, and read an example whole", () => {
    expect(() => parseDescriptionArm("short")).toThrow("--description-arm");
    expect(parseDescriptionArm()).toBe("control");
    expect(exampleArguments('Do it. Example: {"a":{"b":"}"}}. More.')).toEqual({ a: { b: "}" } });
    expect(exampleArguments("No example.")).toBeUndefined();
  });

  it("apply property rules without losing safety text", () => {
    expect(propertyText("terse", "Opaque nextCursor from the previous page. Pass it back unchanged.")).toBeUndefined();
    expect(propertyText("example", "Opaque nextCursor from the previous page. Pass it back unchanged.")).toBe(
      "nextCursor from the previous page.",
    );
    expect(
      propertyText(
        "disambiguation",
        'Dot paths to keep. Paths start at each item in items, e.g. ["id"]. It only narrows the result.',
      ),
    ).toBe('Dot paths from each item in items, e.g. ["id"].');
    const untouched = "Positive decimal currency units with exactly two fractional digits, never integer cents.";
    for (const arm of ["terse", "disambiguation", "example"] as const)
      expect(propertyText(arm, untouched)).toBe(untouched);
  });

  it("stay unreachable from public configuration", () => {
    const sources: string[] = [];
    const visit = (directory: string) => {
      for (const entry of readdirSync(directory)) {
        const path = join(directory, entry);
        if (statSync(path).isDirectory()) {
          if (entry !== "eval") visit(path);
        } else if (/\.(ts|tsx|json|mjs)$/.test(entry) && !/\.generated\./.test(entry)) sources.push(path);
      }
    };
    visit("src");
    visit("templates");
    visit("bin");
    for (const path of sources) {
      const text = readFileSync(path, "utf8");
      expect(text.includes("description-arm") || text.includes("descriptionArm"), path).toBe(false);
    }
    const manifest = JSON.parse(readFileSync("package.json", "utf8")) as { files: string[] };
    expect(manifest.files.some((entry) => entry === "eval" || entry.startsWith("eval/"))).toBe(false);
  });
});

describe("description plan", () => {
  it("fixes tasks the Worker can serve, within budget", () => {
    const ids = DESCRIPTION_PLAN.stageA.tasks.map((task) => task.id);
    for (const id of [...ids, ...DESCRIPTION_PLAN.stageB.tasks]) {
      const task = ACTIVE_TASKS.find((entry) => entry.id === id);
      expect(task, id).toBeDefined();
      expect(workerRefusal(task!), id).toBeUndefined();
    }
    expect(DESCRIPTION_PLAN.stageB.tasks.every((id) => (ids as readonly string[]).includes(id))).toBe(true);
    const cell = DESCRIPTION_PLAN.hosts.length * DESCRIPTION_PLAN.repeats;
    const planned =
      DESCRIPTION_PLAN.stageA.arms.length * ids.length * cell +
      DESCRIPTION_PLAN.stageB.arms.length * DESCRIPTION_PLAN.stageB.tasks.length * cell;
    expect(planned).toBeLessThanOrEqual(DESCRIPTION_PLAN.budget);
  });
});

const named = (table: Record<string, string>) =>
  Object.entries(table)
    .filter(([key, tool]) => key.startsWith("GET ") && tool !== "get_report" && tool !== "get_record")
    .map(([key]) => key)
    .sort();

describe("description measures", () => {
  it("keep the named-operation table to the providers' declarations", () => {
    expect([...NAMED_OPERATIONS.ccb!].sort()).toEqual(named(CCB_NAMED as Record<string, string>));
    for (const operation of NAMED_OPERATIONS.quickbooks!) expect(Object.keys(QUICKBOOKS_NAMED)).toContain(operation);
    for (const [provider, file] of [
      ["stripe", "src/providers/stripe/index.ts"],
      ["cloudflare", "src/providers/cloudflare/index.ts"],
    ] as const)
      for (const operation of NAMED_OPERATIONS[provider]!)
        expect(readFileSync(file, "utf8"), operation).toContain(`"${operation}":`);
  });

  const trial = (toolUses: unknown[], programs: unknown[] = []) =>
    ({
      saved: { trace: { toolUses }, world: { programs } },
      metrics: { metaTools: { search_tools: 1 }, tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 } },
    }) as unknown as TrialResult;

  it("count first-attempt invalid_args per tool across direct, native and program calls", () => {
    const measured = descriptionMetrics(
      trial(
        [
          {
            tool: "call_tool",
            input: { address: "stripe_sandbox.stripe_api_read", args: { path: "/v1/balance" } },
            isError: true,
            resultText: '{"error":{"code":"invalid_args"}}',
          },
          {
            tool: "call_tool",
            input: { address: "stripe_sandbox.stripe_api_read", args: { path: "/v1/x" } },
            isError: false,
          },
          {
            tool: "stripe__stripe_api_write",
            native: { address: "stripe.stripe_api_write", readOnly: false },
            input: { method: "POST", path: "/v1/refunds" },
            isError: false,
          },
          { tool: "execute_code", input: { code: "run()" }, isError: false },
        ],
        [
          {
            code: "run()",
            calls: [
              { name: "connecta.search", args: [], outcome: "ok" },
              { name: "connecta.call", args: ["ccb.get_group", {}], outcome: "error", errorCode: "invalid_args" },
              { name: "connecta.call", args: ["ccb.get_group", { groupId: 1 }], outcome: "ok" },
            ],
          },
        ],
      ),
    );
    expect(measured).toMatchObject({
      firstAttempts: 3,
      firstAttemptInvalidArgs: 2,
      invalidArgs: 2,
      hatchCalls: 3,
      hatchMisuse: 1,
      hatchNamedBypass: 1,
      searches: 2,
    });
  });

  it("orders attempts by call, keeping programs the trace cannot match", () => {
    const attempts = trialAttempts(
      trial([], [{ code: "orphan", calls: [{ name: "connecta.call", args: ["a.b", {}], outcome: "ok" }] }]),
    );
    expect(attempts.map((attempt) => attempt.address)).toEqual(["a.b"]);
  });

  it("computes the exact sign test", () => {
    expect(signTest(0, 0)).toBe(1);
    expect(signTest(6, 0)).toBeCloseTo(0.03125);
    expect(signTest(5, 0)).toBeCloseTo(0.0625);
    expect(signTest(2, 2)).toBe(1);
  });
});

describe("compare's refuse-to-pair rule", () => {
  const file = (
    surface: "six" | "native",
    descriptionArm: "control" | "terse",
    extra: Partial<AgentResultFile["config"]> = {},
  ) =>
    ({
      kind: "connecta-eval/agent",
      version: 1,
      meta: { git: {} },
      config: {
        runner: "claude",
        target: "worker",
        surface,
        descriptionArm,
        models: [],
        tasks: [],
        repeats: 1,
        ...extra,
      },
      trials: [],
    }) as unknown as AgentResultFile;

  it("refuses arms across surfaces, with no override", () => {
    expect(() => compare(file("six", "control"), file("native", "terse"), { allowMismatch: true })).toThrow(
      "ran on different surfaces",
    );
  });

  it("refuses unprovenanced arms and historical files naming no arm as anything but control", () => {
    expect(() => compare(file("six", "control"), file("six", "terse"))).toThrow("Comparison refused");
    const historical = file("six", "control");
    delete historical.config.descriptionArm;
    expect(() => compare(historical, file("six", "terse"))).toThrow("Comparison refused");
  });

  it("refuses a surface comparison that also varies text", () => {
    expect(() => compare(file("native", "terse"), file("six", "control"))).toThrow("different surfaces");
  });
});
