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
      it(
        `INV-7: ${entry.name} / ${seam} revokes every owner and late completion${entry.reviewer ? " / reviewer20" : ""}`,
        { timeout: 20_000 },
        async () => {
          for (const owner of entry.owners ?? (["call", "request"] as const))
            for (const completion of entry.completions ?? (["resolve", "reject"] as const)) {
              try {
                await exercise(entry.create, seam, owner, completion);
              } catch (error) {
                if (error instanceof Error) error.message = `close ${owner}, late ${completion}: ${error.message}`;
                throw error;
              } finally {
                // Each table row keeps the same mock isolation as the former individual tests.
                vi.restoreAllMocks();
                vi.unstubAllGlobals();
              }
            }
        },
      );
});
