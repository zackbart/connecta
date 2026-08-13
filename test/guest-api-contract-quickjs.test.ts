// The QuickJS arm of the guest API contract. The same case table runs against
// the Dynamic Worker executor in test/guest-api-contract.test.ts.

import { afterAll, describe, expect, it } from "vitest";
import { quickJsExecutor } from "../src/executors/quickjs.js";
import {
  CAPABILITY_PROBE_CODE,
  CONTRACT_CASES,
  contractHarness,
} from "./guest-contract-cases.js";

// A generous guest-CPU budget: these programs loop and stringify, and the
// clause under test is never the 250ms default.
const executor = quickJsExecutor({ cpuTimeMs: 5_000 });
const deadlineExecutor = quickJsExecutor({
  timeoutMs: 500,
  cpuTimeMs: 5_000,
});

afterAll(async () => {
  await executor.close?.();
  await deadlineExecutor.close?.();
});

describe("guest API contract (QuickJS executor)", () => {
  for (const contractCase of CONTRACT_CASES) {
    it(`[${contractCase.clauses}] ${contractCase.name}`, async () => {
      const harness = contractHarness();
      const chosen = contractCase.deadline ? deadlineExecutor : executor;
      const outcome = await harness.run(chosen, contractCase.code);
      const follow = contractCase.follows
        ? await harness.run(chosen, contractCase.follows)
        : undefined;
      contractCase.check(outcome, harness.state, follow);
    });
  }

  it("[P2, X5] pins the QuickJS capability set", async () => {
    const outcome = await contractHarness().run(executor, CAPABILITY_PROBE_CODE);

    expect(outcome.isError, outcome.text).toBe(false);
    expect(outcome.result).toEqual({
      globals: {
        fetch: "undefined",
        setTimeout: "undefined",
        clearTimeout: "undefined",
        process: "undefined",
        crypto: "undefined",
        WebSocket: "undefined",
        require: "undefined",
        Deno: "undefined",
        Bun: "undefined",
      },
      dataFetch: "absent",
      externalHttp: "absent",
      externalHttps: "absent",
      webSocket: "absent",
      netConnect: "import blocked",
      imports: {
        fs: "blocked",
        path: "blocked",
        crypto: "blocked",
        net: "blocked",
        module: "blocked",
        workers: "blocked",
      },
      builtins: {
        fs: "process absent",
        path: "process absent",
        crypto: "process absent",
        net: "process absent",
        module: "process absent",
        workers: "process absent",
      },
      env: {
        entrypoint: { type: "undefined", keys: 0 },
        global: { type: "undefined", keys: 0 },
        process: { type: "undefined", keys: 0 },
        workers: { type: "undefined", keys: 0 },
      },
    });
  });
});
