import { intercom, type IntercomOptions } from "./index.js";
const options: IntercomOptions = { purpose: "Support fixture", admin: "1001" };
export const fixture = {
  name: "intercom",
  options,
  cases: [{"label":"padded-purpose","options":{"purpose":"  Support fixture  "}},{"label":"eu","options":{"region":"eu"}}],
  create(id = "fixture", overrides: Partial<IntercomOptions> = {}) { return intercom(id, { ...options, ...overrides }); },
  conventions: {"verbs":["reply","add","close","open","snooze","assign","unassign","tag","untag","intercom"],"nestedDescriptionExceptions":[],"auth":"credential"},
};
export const createAuthored = () => fixture.create();
