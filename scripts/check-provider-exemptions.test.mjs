import assert from "node:assert/strict";
import { test } from "node:test";
import { checkExemptions } from "./check-provider-exemptions.mjs";

test("allows exemption removals but rejects additions, replacements and reinsertions per step", () => {
  const base = { step1: ["crm"], step2: ["crm", "tickets"] };
  checkExemptions(base, base);
  checkExemptions({ step1: [], step2: ["tickets"] }, base);
  for (const head of [
    { step1: ["crm", "notes"], step2: base.step2 },
    { step1: ["notes"], step2: base.step2 },
    { step1: ["tickets"], step2: base.step2 },
    { step1: base.step1, step2: ["crm", "tickets", "notes"] },
  ]) {
    assert.throws(() => checkExemptions(head, base), /Provider exemptions may only shrink/);
  }
  assert.throws(() => checkExemptions(base, { step1: [], step2: base.step2 }), /only shrink/);
});
