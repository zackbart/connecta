// Node-only: the shared value-safety review harness loads the maintainer detector from scripts/.
import { expect, it } from "vitest";
import { reviewProblems } from "../../../test/fixtures/value-safety.js";
import { valueSafety } from "../_shared/rest/value-safety.js";
import { SHEETS_VALUE_SAFETY } from "./safety.js";
import { sheetsIndex } from "./lib/hatch.js";
import source from "./evidence/openapi.json";
import candidates from "./evidence/value-safety.json";

it("INV-5: reviews every Sheets candidate while retaining cell content and withholding private access", () => {
  const problems = reviewProblems({ table: SHEETS_VALUE_SAFETY, index: sheetsIndex, source, candidates });
  for (const rows of Object.values(problems)) expect(rows).toEqual([]);
  const safety = valueSafety(SHEETS_VALUE_SAFETY, () => sheetsIndex);
  const value = {
    values: [["user text", 1, true, null, "https://example.com/?key=ordinary"]],
    client_secret: "private",
    keyValueData: { columnIndex: 0 },
  };
  const safe = safety.redact(value, "GET", "/spreadsheets/{spreadsheetId}/values/{range}") as typeof value;
  expect(safe.values).toEqual(value.values);
  expect(safe.keyValueData).toEqual(value.keyValueData);
  expect(safe.client_secret).toBe("[redacted]");
});
