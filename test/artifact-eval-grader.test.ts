import { describe, expect, it } from "vitest";
import { hasExactOpenBugRows } from "../eval/tasks/artifacts.js";

const expected = [
  { id: "WEB-1", project: "web" },
  { id: "WEB-2", project: "web" },
  { id: "API-1", project: "api" },
];
const rows = expected.map(issue => ({ ...issue, title: "Bug" }));

describe("raw issue document counts", () => {
  it("accepts complete rows kept in a named document", () => {
    expect(hasExactOpenBugRows({ bugs: { issues: rows } }, expected)).toBe(true);
  });

  it("rejects missing, duplicate, and wrong-project rows", () => {
    expect(hasExactOpenBugRows({ bugs: { issues: rows.slice(1) } }, expected)).toBe(false);
    expect(hasExactOpenBugRows({ bugs: { issues: [rows[0], rows[0], rows[2]] } }, expected)).toBe(false);
    expect(hasExactOpenBugRows({ bugs: { issues: [rows[0], rows[1], { ...rows[2], project: "web" }] } }, expected)).toBe(false);
  });

  it("rejects closed or nonbug rows even when their ids match", () => {
    expect(hasExactOpenBugRows({ bugs: { issues: [rows[0], rows[1], { ...rows[2], status: "closed" }] } }, expected)).toBe(false);
    expect(hasExactOpenBugRows({ bugs: { issues: [rows[0], rows[1], { ...rows[2], labels: ["feature"] }] } }, expected)).toBe(false);
  });
});
