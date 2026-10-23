import type { skill as Skill } from "../skill.generated.js";
import {
  PLANNING_CENTER_APPS,
  PLANNING_CENTER_API_VERSIONS,
  APP_TITLES,
  isApp,
  type PlanningCenterApp,
} from "../api.js";
/** `a, b, and c`, the way the guide and description list products. */
export function series(items: readonly string[]): string {
  return items.length < 3 ? items.join(" and ") : `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

/** The products the description names: those with named tools for staff work. */
export const DESCRIBED_APPS = [
  "people",
  "services",
  "groups",
  "check-ins",
  "calendar",
  "registrations",
  "giving",
] as const satisfies readonly PlanningCenterApp[];

/** What a person id joins in each other product, for the guide's identity rule. */
const PERSON_JOINS = [
  ["services", "Services schedules"],
  ["groups", "Groups memberships"],
  ["giving", "Giving donations"],
  ["check-ins", "Check-Ins"],
] as const satisfies readonly (readonly [PlanningCenterApp, string])[];

/**
 * The maintained guide for the products this connection reaches. Every
 * product-specific line is its own fragment, so an excluded product is
 * neither described, pinned, nor named by a tool the guide points to, and an
 * exclusion adds the line stating what the hatches refuse. With nothing
 * excluded, the text is the whole guide as before; the `published` fragment
 * is that same text without a purpose.
 */
export function usageGuide(
  purpose: string,
  instructions: string | undefined,
  excluded: ReadonlySet<PlanningCenterApp>,
  skill: typeof Skill,
): string {
  const fragments = skill.fragments;
  const has = (app: PlanningCenterApp) => !excluded.has(app);
  const pair = (a: PlanningCenterApp, b: PlanningCenterApp, both: string, onlyA: string, onlyB: string) =>
    has(a) && has(b) ? both : has(a) ? onlyA : has(b) ? onlyB : "";
  const apps = PLANNING_CENTER_APPS.filter(has);
  const joins = PERSON_JOINS.filter(([app]) => has(app)).map(([, label]) => label);
  const organizationInstructions = instructions?.trim();
  return [
    fragments.heading,
    apps
      .filter((app) => app !== "api")
      .map((app) => APP_TITLES[app])
      .join(", "),
    fragments.purpose,
    purpose,
    fragments.identity,
    joins.length > 0 ? series(joins) : "every People record",
    fragments.conventions,
    has("services") ? fragments.plans : "",
    fragments.writes,
    excluded.size === 0 ? fragments.people : fragments.people_without_lists,
    has("services") ? fragments.services : "",
    has("groups") ? fragments.groups : "",
    pair("check-ins", "registrations", fragments.check_ins_registrations, fragments.check_ins, fragments.registrations),
    has("calendar") ? fragments.calendar : "",
    has("giving") ? fragments.giving : "",
    pair("publishing", "api", fragments.publishing_api, fragments.publishing, fragments.api),
    fragments.hatches,
    apps.map((app) => `${app} ${PLANNING_CENTER_API_VERSIONS[app]}`).join(", "),
    fragments.pins,
    excluded.size === 0 ? "" : fragments.disabled,
    fragments.limits,
    organizationInstructions ? `\n## ${skill.instructionsHeading}\n\n${organizationInstructions}\n` : "",
  ].join("");
}

/**
 * `excludeApps` as a set, refusing at construction what cannot be meant
 * (INV-11): a product Planning Center does not have, a misspelling, or People.
 */
export function excludedApps(value: unknown): ReadonlySet<PlanningCenterApp> {
  const excluded = new Set<PlanningCenterApp>();
  if (value === undefined) return excluded;
  const excludable = PLANNING_CENTER_APPS.filter((app) => app !== "people").join(", ");
  if (!Array.isArray(value)) {
    throw new Error(`planningCenter() excludeApps must be an array of app names from: ${excludable}.`);
  }
  for (const entry of value) {
    if (entry === "people") {
      throw new Error(
        'planningCenter() excludeApps cannot exclude "people": every product joins through People person ids, and the credential test reads /people/v2/me.',
      );
    }
    if (typeof entry !== "string" || !isApp(entry)) {
      const lower = typeof entry === "string" ? entry.trim().toLowerCase() : "";
      throw new Error(
        `planningCenter() excludeApps has unknown app ${JSON.stringify(entry)}; expected any of ${excludable}.${
          isApp(lower) && lower !== "people" ? ` App names are lowercase path segments: "${lower}".` : ""
        }`,
      );
    }
    excluded.add(entry);
  }
  return excluded;
}
