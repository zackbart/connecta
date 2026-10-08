// The one six-tool surface (#273, #672): what every deployment advertises and
// the structural configuration mistakes construction refuses.

import { describe, expect, it } from "vitest";
import { machineAuth } from "./helpers/machine-auth.js";
import { customExecutor, createConnecta } from "../src/index.js";
import { CONNECTA_INSTRUCTIONS, USAGE_SKILL } from "../src/skills.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { Executor } from "../src/types.js";
import { calcApi, makeDeployment, mcpRpc, readJsonRpc } from "./fixtures/http.js";

const TOKEN = "surface-token";
const BASE = "https://connecta.test";
const REMOVED_TOOLS = ["list_connectors", "describe_tools", "batch_call", "resume_execution"];

const stubExecutor: Executor = customExecutor(
  {
    execute: async () => ({ result: null }),
  },
  { lifecycle: "self-managed" },
);

function connectors() {
  return [calcApi()];
}

const deploymentConfig = {
  connectors: connectors(),
  auth: machineAuth(TOKEN),
  storage: memoryStorage(),
  publicUrl: BASE,
  executor: stubExecutor,
};

describe("construction", () => {
  it("requires an executor and names both runtime configurations", () => {
    const construct = () =>
      (createConnecta as (config: unknown) => unknown)({
        connectors: connectors(),
      });
    expect(construct).toThrow("ConnectaConfig.executor is required");
    // The refusal has to say what to configure on either runtime, or the
    // operator's next move is a guess. Assert the load-bearing fragments
    // rather than the whole sentence, which is free to grow.
    for (const fragment of ["quickJsExecutor()", "@zackbart/connecta/quickjs", "DynamicWorkerExecutor"]) {
      expect(construct).toThrow(fragment);
    }
  });

  it("rejects the removed surface option even when its value is undefined", () => {
    for (const surface of [undefined, "classic", "code-first"]) {
      expect(() =>
        (createConnecta as (config: unknown) => unknown)({
          connectors: connectors(),
          executor: stubExecutor,
          surface,
        }),
      ).toThrow("ConnectaConfig.surface");
    }
  });

  it("rejects the batch cap that left with batch_call", () => {
    expect(() =>
      (createConnecta as (config: unknown) => unknown)({
        connectors: connectors(),
        executor: stubExecutor,
        calls: { maxBatchResultBytes: 1_000 },
      }),
    ).toThrow("ConnectaConfig.calls.maxBatchResultBytes");
  });
});

describe("the advertised surface", () => {
  const SEVEN = ["authorize_connector", "call_destructive_tool", "call_tool", "execute_code", "search_tools", "skills"];

  it("advertises exactly six tools, whatever the storage", async () => {
    for (const storage of [memoryStorage()]) {
      const body = await readJsonRpc(
        await mcpRpc(makeDeployment({ ...deploymentConfig, storage }), "tools/list", {}, { token: TOKEN }),
      );
      const tools = body.result.tools as Array<{ name: string; description: string }>;
      expect(tools.map((tool) => tool.name).sort()).toEqual(SEVEN);
      const execute = tools.find((tool) => tool.name === "execute_code")?.description;
      expect(execute).toContain("Read-only pool: programs read; writes use call_destructive_tool.");
      expect(execute).toContain("call_destructive_tool");
    }
  });

  it("does not advertise direct-call field projection", async () => {
    const body = await readJsonRpc(
      await mcpRpc(
        makeDeployment(deploymentConfig),
        "tools/list",
        {},
        {
          token: TOKEN,
        },
      ),
    );
    for (const name of ["call_tool", "call_destructive_tool"]) {
      const tool = body.result.tools.find((entry: { name: string }) => entry.name === name);
      expect(tool.inputSchema.properties).not.toHaveProperty("fields");
    }
    expect(CONNECTA_INSTRUCTIONS).not.toContain("use fields");
    expect(USAGE_SKILL).not.toContain("Projection misses");
  });

  it("never advertises or teaches a removed top-level tool", async () => {
    const connecta = makeDeployment(deploymentConfig);
    const listed = await readJsonRpc(await mcpRpc(connecta, "tools/list", {}, { token: TOKEN }));
    const initialized = await readJsonRpc(
      await mcpRpc(
        connecta,
        "initialize",
        {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "surface-test", version: "0" },
        },
        { token: TOKEN },
      ),
    );
    // The skill is swept as it is *served*, not as it is imported: pinning the
    // served text to the constant first is what makes the sweep below evidence
    // about this deployment rather than about a string literal.
    const skill = await readJsonRpc(
      await mcpRpc(
        connecta,
        "tools/call",
        {
          name: "skills",
          arguments: { name: "usage" },
        },
        { token: TOKEN },
      ),
    );
    const servedSkill = skill.result.content[0].text as string;
    expect(servedSkill).toBe(USAGE_SKILL);
    expect(servedSkill).toContain('connector: "ci"');
    expect(servedSkill).toContain("No imports, require, filesystem, fetch, or timers");

    const advertised = [
      initialized.result.instructions,
      ...listed.result.tools.map((tool: { name: string; description: string }) => `${tool.name} ${tool.description}`),
      servedSkill,
    ].join("\n");
    expect(initialized.result.instructions).toBe(CONNECTA_INSTRUCTIONS);
    for (const removed of REMOVED_TOOLS) {
      expect(advertised).not.toContain(removed);
    }
  });

  it("keeps route guidance bounded without rendering instructions", async () => {
    const connecta = makeDeployment(deploymentConfig);
    const initialized = await readJsonRpc(
      await mcpRpc(
        connecta,
        "initialize",
        {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "surface-test", version: "0" },
        },
        { token: TOKEN },
      ),
    );
    const instructions = initialized.result.instructions as string;
    expect(instructions).toBe(CONNECTA_INSTRUCTIONS);
    expect(instructions).not.toContain("connecta.ui");
    // Always-loaded guidance is a context tax. Keep its total explicit rather
    // than letting one successful experiment license unbounded additions.
    expect(instructions.length).toBeLessThanOrEqual(1_000);
  });

  it("rejects calls to every removed top-level tool", async () => {
    const connecta = makeDeployment(deploymentConfig);
    for (const removed of REMOVED_TOOLS) {
      const body = await readJsonRpc(
        await mcpRpc(
          connecta,
          "tools/call",
          {
            name: removed,
            arguments: {},
          },
          { token: TOKEN },
        ),
      );
      // The MCP server owns this refusal: an unregistered name is a JSON-RPC
      // error, not a tool result. What matters is that it fails loudly and
      // names the tool that was called, rather than resolving to something
      // else or refusing anonymously.
      expect(body.error ?? body.result?.isError).toBeTruthy();
      expect(JSON.stringify(body)).toContain(removed);
    }
  });
});
