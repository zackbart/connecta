/** Recover only fake audit roles explicitly evidenced in sanitized snapshots. */
import type { SavedGradeInputs } from "./saved.js";

export function auditGradeInputs(saved: SavedGradeInputs): SavedGradeInputs {
  const replacements = new Map<string, string>();
  const collect = (value: unknown): void => {
    if (typeof value === "string") {
      // A page can start/end mid-row. Only complete JSON rows establish a role.
      for (const line of value.split("\n")) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          /* Not a complete exported row. */
          continue;
        }
        collect(parsed);
      }
    } else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === "object") {
      const event = value as Record<string, unknown>;
      if (event.target === "prod-db" && typeof event.actor === "string" && /^redacted-email-\d+$/.test(event.actor)) {
        const actor =
          event.action === "project.deleted"
            ? "dana.whitfield@example.com"
            : event.action === "project.delete_requested"
              ? "sam.ortiz@example.com"
              : undefined;
        if (actor) {
          if (replacements.has(event.actor) && replacements.get(event.actor) !== actor)
            throw new Error("Conflicting sanitized audit actor roles");
          replacements.set(event.actor, actor);
        }
      }
      for (const item of Object.values(event)) collect(item);
    }
  };
  for (const program of saved.world.programs)
    for (const call of program.calls)
      if (
        call.outcome === "ok" &&
        (call.name === "connecta.result" || (call.name === "connecta.call" && call.args[0] === "audit.export_events"))
      )
        collect(call.result);
  if (!replacements.size) return saved;
  // Replace whole markers consistently in state, answers and source observations.
  // No original evidence is edited and no historical check verdict is retained.
  return JSON.parse(
    JSON.stringify(saved).replace(/\bredacted-email-\d+\b/g, (token) => replacements.get(token) ?? token),
  ) as SavedGradeInputs;
}
