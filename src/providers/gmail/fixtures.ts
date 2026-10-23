import { gmail } from "./index.js";
import { googleOptions } from "../../../test/fixtures/provider-options.js";
const options: Parameters<typeof gmail>[1] = { "purpose":"Audit fixture", ...googleOptions };
export const fixture = {
  name: "gmail",
  options,
  cases: [{"label":"padded-purpose","options":{"purpose":"  Audit fixture  "}},{"label":"default","options":{}}],
  create(id = "fixture", overrides: Partial<Parameters<typeof gmail>[1]> = {}) { return gmail(id, { ...options, ...overrides } as Parameters<typeof gmail>[1]); },
  assertSmoke(connector: ReturnType<typeof gmail>) {
    if (connector.staticTools?.some((tool) => /send/.test(tool.name))) throw new Error("Gmail provider published a send tool");
  },
  conventions: {"verbs":["search","list","get","create","update"],"nestedDescriptionExceptions":[],"auth":"delegated"},
};


/** Credential-free Gmail API response shapes used by attachment regressions. */
export const attachmentFixtures = {
  csv: { partId: "1", mimeType: "text/csv", filename: "people.csv", headers: [{ name: "Content-Type", value: "text/csv; charset=utf-8" }], body: { attachmentId: "csv-current", size: 17 } },
  calendar: { partId: "2", mimeType: "text/calendar", filename: "invite.ics", body: { attachmentId: "calendar-current", size: 42 } },
  latin1: { partId: "3", mimeType: "text/plain", filename: "cafe.txt", headers: [{ name: "Content-Type", value: 'text/plain; charset="iso-8859-1"' }], body: { attachmentId: "latin-current", size: 4 } },
  inline: { partId: "4", mimeType: "text/csv", filename: "small.csv", body: { size: 4, data: "YSxiCg" } },
  pdf: { partId: "5", mimeType: "application/pdf", filename: "report.pdf", body: { attachmentId: "pdf-current", size: 15 } },
  parsedForwarded: {
    partId: "7", mimeType: "message/rfc822", filename: "parsed.eml", body: { size: 0, data: "" },
    parts: [{
      mimeType: "multipart/alternative", body: { size: 0 },
      headers: [
        { name: "From", value: "ann@example.com" }, { name: "To", value: "bob@example.com" },
        { name: "Date", value: "Mon, 12 Oct 2026 10:00:00 +0000" }, { name: "Subject", value: "Forwarded café" },
      ],
      parts: [
        { mimeType: "text/html", body: { size: 9, data: "PHA-SGk8L3A-" } },
        { mimeType: "text/plain", body: { size: 2, data: "SGk" } },
      ],
    }],
  },
  forwarded: { partId: "6", mimeType: "message/rfc822", filename: "forwarded.eml", body: { attachmentId: "mail-current", size: 27 } },
};

export const createAuthored = () => fixture.create();
