import type { CcbEnvironment, CcbMode } from "../index.js";
export function routingLine(environment: CcbEnvironment, mode: CcbMode, writable: boolean): string {
  return [
    environment === "sandbox" ? "Sandbox church data" : "Production church data",
    mode === "identity"
      ? "acting as each signed-in person with their own CCB permissions (Identity Auth)"
      : "church-wide under one administrator-approved grant (System Auth)",
    writable ? "reads plus approval-gated writes" : "read-only",
  ].join(", ");
}

export function usageGuide(
  purpose: string,
  environment: CcbEnvironment,
  mode: CcbMode,
  scopes: readonly string[],
  writable: boolean,
  sensitiveFields: "drop" | "return",
  instructions: string | undefined,
  skill: typeof import("../skill.generated.js").skill,
): string {
  const extra = instructions?.trim();
  return `# Church Community Builder (Pushpay ChMS)

${routingLine(environment, mode, writable)}: ${purpose}${skill.fragments.guide_0}${mode === "identity" ? "- Results are what the signed-in person may see in CCB. A 403 means that person lacks the permission, not that the connection is broken.\n" : ""}${skill.fragments.guide_1}${writable ? " `ccb_api_mutate` reaches every POST, PUT, PATCH, and DELETE and always needs approval." : " This connection is read-only, so it ships no write tool."} Paths are below the API origin, such as \`/church/membership_types\`. ${sensitiveFields === "return" ? "This connection returns sensitive fields: `raw: true` and the hatches return CCB's full rows." : "Every result, `raw: true` and the hatches included, leaves the sensitive fields out."}
Granted scopes: ${scopes.join(" ")}. A call outside them fails with 403.
${extra ? `\n## ${skill.instructionsHeading}\n\n${extra}\n` : ""}`;
}
