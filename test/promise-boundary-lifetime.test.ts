import { afterEach, describe, it, vi } from "vitest";
import { ENTRIES } from "./helpers/promise-boundary/entries.js";
import { exercise } from "./helpers/promise-boundary/harness.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("published Promise boundary lifetime matrix", () => {
  for (const entry of ENTRIES)
    for (const seam of entry.seams)
      for (const owner of entry.owners ?? (["call", "request"] as const))
        for (const completion of entry.completions ?? (["resolve", "reject"] as const))
          it(`INV-7: ${entry.name} / ${seam} / close ${owner} / late ${completion}${entry.reviewer ? " / reviewer20" : ""}`, async () => {
            await exercise(entry.create, seam, owner, completion);
          });
});
