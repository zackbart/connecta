// Node-only: the shared value-safety review harness loads the maintainer detector from scripts/.
import { expect, it } from "vitest";
import { reviewProblems } from "../../../test/fixtures/value-safety.js";
import { GMAIL_VALUE_SAFETY, gmailSafety } from "./safety.js";
import { index } from "./lib/index.js";
import source from "./evidence/openapi.json";
import candidates from "./evidence/value-safety.json";

it("INV-5: reviews every Gmail candidate, keeps mail content and withholds settings credentials", () => {
  const problems = reviewProblems({ table: GMAIL_VALUE_SAFETY, index, source, candidates });
  for (const rows of Object.values(problems)) expect(rows).toEqual([]);
  const safety = gmailSafety().reviewed!;
  // Mail is the requested content and keeps its original object, so named
  // projections still find the encoded-field provenance attached to it.
  const message = {
    id: "m1",
    payload: { headers: [{ name: "Authorization", value: "Bearer looks-like-a-token" }] },
    raw: "cmF3",
  };
  expect(safety.redact(message, { method: "GET", template: "/messages/{id}" })).toBe(message);
  expect(safety.withholdsErrors({ method: "POST", template: "/messages/send" })).toBe(false);
  const alias = safety.redact(
    { sendAsEmail: "a@example.com", signature: "<b>A</b>", smtpMsa: { password: "secret" } },
    { method: "GET", template: "/settings/sendAs/{sendAsEmail}" },
  ) as Record<string, any>;
  expect(alias).toEqual({ sendAsEmail: "a@example.com", signature: "<b>A</b>", smtpMsa: { password: "[redacted]" } });
  // A request carrying the SMTP credential keeps the vendor's error text withheld.
  expect(safety.withholdsErrors({ method: "POST", template: "/settings/sendAs" })).toBe(true);
  expect(safety.withholdsErrors({ method: "PUT", template: "/settings/vacation" })).toBe(false);
});
