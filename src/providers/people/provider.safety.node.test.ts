// Node-only: the shared value-safety review harness loads the maintainer detector from scripts/.
import { expect, it } from "vitest";
import { reviewProblems } from "../../../test/fixtures/value-safety.js";
import { valueSafety } from "../_shared/rest/value-safety.js";
import { PEOPLE_VALUE_SAFETY } from "./safety.js";
import { peopleIndex } from "./lib/hatch.js";
import source from "./evidence/openapi.json";
import candidates from "./evidence/value-safety.json";

it("INV-5: reviews every People candidate, keeping contact data and withholding photo destinations and client data", () => {
  const problems = reviewProblems({ table: PEOPLE_VALUE_SAFETY, index: peopleIndex, source, candidates });
  for (const rows of Object.values(problems)) expect(rows).toEqual([]);
  const safety = valueSafety(PEOPLE_VALUE_SAFETY, () => peopleIndex);
  const person = {
    resourceName: "people/c1",
    emailAddresses: [{ value: "bob@example.com" }],
    urls: [{ value: "https://example.com/?key=ordinary" }],
    userDefined: [{ key: "Badge", value: "4471" }],
    photos: [{ url: "https://lh3.googleusercontent.com/private-photo" }],
    coverPhotos: [{ url: "https://lh3.googleusercontent.com/private-cover" }],
    clientData: [{ key: "crm-id", value: "app-private-value" }],
  };
  for (const [template, wrap] of [
    ["/people/{peopleId}", (p: object) => p],
    ["/people:searchContacts", (p: object) => ({ results: [{ person: p }] })],
    ["/people/{peopleId}/connections", (p: object) => ({ connections: [p], nextPageToken: "next" })],
    ["/otherContacts", (p: object) => ({ otherContacts: [p] })],
    ["/people:listDirectoryPeople", (p: object) => ({ people: [p] })],
  ] as const) {
    const text = JSON.stringify(safety.redact(wrap(person), "GET", template));
    expect(text, template).not.toMatch(/private-photo|private-cover|app-private-value/);
    for (const kept of ["bob@example.com", "https://example.com/?key=ordinary", "4471", "crm-id"])
      expect(text, template).toContain(kept);
  }
  expect(
    JSON.stringify(
      safety.redact({ contactGroups: [{ clientData: [{ key: "k", value: "secret" }] }] }, "GET", "/contactGroups"),
    ),
  ).not.toContain("secret");
});
