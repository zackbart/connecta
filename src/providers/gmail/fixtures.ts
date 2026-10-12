import { gmail } from "./index.js";
import { googleOptions } from "../../../test/fixtures/provider-options.js";
const options: Parameters<typeof gmail>[1] = { "purpose":"Audit fixture", ...googleOptions };
export const fixture = {
  name: "gmail",
  options,
  cases: [{"label":"padded-purpose","options":{"purpose":"  Audit fixture  "}},{"label":"empty-title","options":{"title":""}},{"label":"blank-title","options":{"title":" "}},{"label":"default","options":{}}],
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
  forwarded: { partId: "6", mimeType: "message/rfc822", filename: "forwarded.eml", body: { attachmentId: "mail-current", size: 27 } },
};
