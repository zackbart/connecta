// Node-only: the shared value-safety harness reads the maintainer detection script in scripts/.
//
// Mutation tests for the harness itself: a table with a wrong path must fail
// it, whether the path names nothing in the pinned schema, misses the flagged
// field, or reaches the field in the wrong shape.
import { describe, expect, it } from "vitest";
import { OperationIndex, type OpenApiData } from "../src/providers/_shared/rest/operation-index.js";
import { redact, type ValueSafetyTable } from "../src/providers/_shared/rest/value-safety.js";
import { reviewProblems, type Candidates, type ValueSafetyReview } from "./fixtures/value-safety.js";
import stripeCandidates from "../src/providers/stripe/value-safety.candidates.json";
import stripeSource from "../src/providers/stripe/openapi.source.json";
import { openapi as stripeOpenapi } from "../src/providers/stripe/openapi.generated.js";
import { STRIPE_VALUE_SAFETY } from "../src/providers/stripe/value-safety.js";

const script = (await import(new URL("../scripts/value-safety.mjs", import.meta.url).href)) as {
  VALUE_SAFETY_FORMAT: number;
};

const DATA: OpenApiData = {
  source: "https://vendor.example/openapi.json",
  revision: "r1",
  digest: "sha256:0",
  version: "1",
  servers: ["https://api.vendor.example"],
  tags: ["hooks"],
  ops: [
    ["GET", "/v1/hooks/{id}", "GetHook", "Get a hook", 0],
    ["GET", "/v1/pins", "ListPins", "List pins", 0],
  ],
  details: JSON.stringify({ d: [], o: [0, 0] }),
};

/** A review whose table and stamp agree; `paths` replaces the hook and pin verdicts' paths. */
function review(hook: string[], pins: string[]): ValueSafetyReview {
  const table: ValueSafetyTable = {
    title: "Acme",
    operations: {
      "GET /v1/hooks/{id}": redact("A signing secret and a bearer destination.", hook),
      "GET /v1/pins": redact("Each entry of a name-keyed map carries a PIN.", pins),
    },
  };
  const candidates: Candidates = {
    format: script.VALUE_SAFETY_FORMAT,
    digest: DATA.digest,
    options: {},
    candidates: {
      "GET /v1/hooks/{id}": { fields: ["secret"], named: true },
      "GET /v1/pins": { fields: ["data{}.pin"], named: false },
    },
    // What providers:spec found in the pinned schema: a hook has `secret` and
    // `url`; pins are a map whose values have `pin`.
    reviewed: {
      operations: {
        "GET /v1/hooks/{id}": ["origin:url", "secret"].filter((path) => hook.includes(path)),
        "GET /v1/pins": ["data.*.pin"].filter((path) => pins.includes(path)),
      },
      resources: {},
    },
  };
  return { table, index: new OperationIndex(DATA, { vendor: "acme", title: "Acme" }), source: DATA, candidates };
}

describe("value-safety harness mutations", () => {
  it("INV-5: passes a table whose paths resolve, cover, and reach their fields", () => {
    expect(Object.values(reviewProblems(review(["secret", "origin:url"], ["data.*.pin"]))).flat()).toEqual([]);
  });

  it("INV-5: fails a path that names nothing in the pinned response schema", () => {
    const problems = reviewProblems(review(["secret", "url.missing"], ["data.*.pin"]));
    expect(problems.unresolved).toContainEqual(expect.stringContaining("GET /v1/hooks/{id}: url.missing"));
  });

  it("INV-5: fails a path that misses the flagged field", () => {
    const problems = reviewProblems(review(["secrt", "origin:url"], ["data.*.pin"]));
    expect(problems.uncovered).toEqual(["GET /v1/hooks/{id}: secret"]);
    expect(problems.unresolved).toContainEqual(expect.stringContaining("secrt"));
  });

  it("INV-5: fails a path that reaches the flagged field in the wrong shape", () => {
    // `data.pin` names a field of the map itself, not of each entry, so a PIN
    // in the schema's shape survives; the stamp is beside the point here.
    const mutated = review(["secret", "origin:url"], ["data.pin"]);
    const problems = reviewProblems({
      ...mutated,
      candidates: {
        ...mutated.candidates,
        reviewed: {
          operations: { ...mutated.candidates.reviewed!.operations, "GET /v1/pins": ["data.pin"] },
          resources: {},
        },
      },
    });
    expect(problems.shapeLeaks).toEqual(["GET /v1/pins: data{}.pin is covered by no redact path that reaches it"]);
  });

  it("INV-5: fails Stripe's table when a webhook's bearer URL path is mutated away", () => {
    const key = "GET /v1/webhook_endpoints/{webhook_endpoint}";
    const verdict = STRIPE_VALUE_SAFETY.operations[key]!;
    expect(verdict.verdict).toBe("redact");
    const paths = verdict.verdict === "redact" ? verdict.paths : [];
    expect(paths).toContain("origin:url");
    const mutated: ValueSafetyTable = {
      ...STRIPE_VALUE_SAFETY,
      operations: {
        ...STRIPE_VALUE_SAFETY.operations,
        [key]: redact(
          verdict.reason,
          paths.map((path) => (path === "origin:url" ? "url.missing" : path)),
        ),
      },
    };
    const problems = reviewProblems({
      table: mutated,
      index: new OperationIndex(stripeOpenapi, { vendor: "stripe", title: "Stripe" }),
      source: stripeSource,
      candidates: stripeCandidates,
      resourceExamples: { "checkout.session": { customer: "cus_1" } },
    });
    expect(problems.unresolved).toContainEqual(expect.stringContaining(`${key}: url.missing`));
  });
});
