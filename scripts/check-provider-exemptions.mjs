import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

export function checkExemptions(head, base) {
  for (const step of ["step1", "step2"]) {
    const added = head[step].filter((name) => !base[step].includes(name));
    assert.deepEqual(added, [], `Provider exemptions may only shrink (${step})`);
  }
}

if (import.meta.main) {
  checkExemptions(
    JSON.parse(readFileSync("test/provider-pending-baseline.json", "utf8")),
    JSON.parse(readFileSync(0, "utf8")),
  );
}
