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
