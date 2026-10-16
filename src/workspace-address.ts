// The one rule for a Google Workspace address, shared by the Workspace
// providers' fixed `subject` and a pool's `owner` (#837, decisions/0006), so
// config accepts exactly the addresses a delegated token can be minted for.

/** A plausible mailbox: one `@`, no whitespace or control characters. */
const ADDRESS = /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+\.[^\s@<>()",;:\\[\]]+$/;

/** Whether `value`, already trimmed, is a Workspace email address. */
export function isWorkspaceAddress(value: unknown): value is string {
  return typeof value === "string" && ADDRESS.test(value);
}
