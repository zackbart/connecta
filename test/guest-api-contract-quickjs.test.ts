// The QuickJS arm of the guest API contract. The same case table runs against
// the Dynamic Worker executor in test/guest-api-contract.test.ts.

import { afterAll, describe, it } from "vitest";
import { quickJsExecutor } from "../src/executors/quickjs.js";
import { CONTRACT_CASES, contractHarness } from "./guest-contract-cases.js";

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
});
