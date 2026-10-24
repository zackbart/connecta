import { PLANNING_CENTER_APPS, isApp, type PlanningCenterApp } from "../api.js";
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
