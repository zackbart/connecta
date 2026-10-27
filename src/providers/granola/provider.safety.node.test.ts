// Node-only: the shared safety reviewer imports the maintainer detection script.
import { expect, it } from "vitest";
import { reviewProblems } from "../../../test/fixtures/value-safety.js";
import candidates from "./evidence/value-safety.json";
import source from "./evidence/openapi.json";
import { index } from "./api.js";
import { GRANOLA_VALUE_SAFETY } from "./safety.js";

it("INV-5: accounts for every credential candidate and verifies reviewed paths against Granola's pinned response schemas", () => {
  const problems = reviewProblems({ table: GRANOLA_VALUE_SAFETY, index, source, candidates });
  expect(Object.values(problems).flat()).toEqual([]);
});
