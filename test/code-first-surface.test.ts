// Executor setup guidance and the bound on always-loaded agent instructions.

import { describe, expect, it } from "vitest";
import { machineAuth } from "./helpers/machine-auth.js";
import { customExecutor, createConnecta } from "../src/index.js";
import { CONNECTA_INSTRUCTIONS } from "../src/skills.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { Executor } from "../src/types.js";
import { calcApi, makeDeployment, mcpRpc, readJsonRpc } from "./fixtures/http.js";

const TOKEN = "surface-token";
const BASE = "https://connecta.test";

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
});

describe("the advertised surface", () => {
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
});
