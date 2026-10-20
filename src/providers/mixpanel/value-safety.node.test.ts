// Node-only: recompiles the reviewed vendor fixture with maintainer scripts and runs the filesystem-backed value-safety harness.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import candidates from "./value-safety.candidates.json";
import { openapi } from "./operations.js";
import { MIXPANEL_VALUE_SAFETY } from "./value-safety.js";
import { OperationIndex } from "../_shared/rest/operation-index.js";
import { connectorContext } from "../../../test/fixtures/misc.js";
import { describeValueSafety } from "../../../test/fixtures/value-safety.js";
import { mixpanel } from "./index.js";

// The vendor publishes YAML; this source is the reviewed composite whose
// digest the compiled operation index carries. Per-document pins remain in
// drift.json. Candidates were produced by scripts/value-safety.mjs.
describeValueSafety("Mixpanel", {
  table: MIXPANEL_VALUE_SAFETY,
  index: new OperationIndex(openapi, { vendor: "mixpanel", title: "Mixpanel" }),
  source: { digest: openapi.digest, options: { valueSafety: true } },
  candidates,
  counts: { refuse: 0, redact: 0, safe: 9 },
  connector: () =>
    mixpanel("raw", { purpose: "Product reporting", via: "api", auth: { type: "credential" }, defaultProjectId: 42 }),
  ctx: () => ({
    ...connectorContext(),
    credential: {
      get: async () => "mp9Qx2.sa:pQ6?eT8+dW3=G5/f",
      getAll: async () => ({ value: "mp9Qx2.sa:pQ6?eT8+dW3=G5/f" }),
    },
  }),
  echo: {
    tool: "mixpanel_api_read",
    args: { path: "/api/app/me" },
    respond: (marker) => Response.json({ error: `Mixpanel rejected ${marker}` }, { status: 400 }),
  },
});

describe("Mixpanel reviewed vendor fixture", () => {
  it("pins the reviewed YAML conversion and reproduces the operation index and safety candidates", async () => {
    const bytes = readFileSync(new URL("./contracts.fixture.json", import.meta.url));
    const document = JSON.parse(bytes.toString());
    const resolveRefs = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        if (key === "$ref" && typeof child === "string" && child.startsWith("#/")) {
          const resolved = child
            .slice(2)
            .split("/")
            .reduce(
              (node: Record<string, unknown> | undefined, part) =>
                node?.[part.replaceAll("~1", "/").replaceAll("~0", "~")] as Record<string, unknown> | undefined,
              document,
            );
          expect(resolved, child).toBeDefined();
        } else resolveRefs(child);
      }
    };
    resolveRefs(document);
    expect(`sha256:${createHash("sha256").update(JSON.stringify(document)).digest("hex")}`).toBe(openapi.digest);
    const generator = await import(new URL("../../../scripts/generate-openapi.mjs", import.meta.url).href);
    const detector = await import(new URL("../../../scripts/value-safety.mjs", import.meta.url).href);
    const source = {
      url: openapi.source,
      revision: openapi.revision,
      digest: openapi.digest,
      options: { depth: 3, descriptions: 0, maxEnum: 30, valueSafety: true },
    };
    expect(generator.buildOperationIndex(document, source)).toEqual(openapi);
    const result = detector.renderValueSafety(document, source, { table: MIXPANEL_VALUE_SAFETY, absent: {} });
    expect(result.problems).toEqual([]);
    expect(JSON.parse(result.text)).toEqual(candidates);
  });
});
