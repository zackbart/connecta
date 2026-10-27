// A provider's sensitive fields leave every result unless deployment code
// returns them; no tool argument can. Shared by the providers whose raw rows
// and hatches would otherwise reach what their projections drop.

/** Refuse anything but the two choices, at construction (INV-11). */
export function sensitiveFieldsOption(provider: string, value: unknown): "drop" | "return" {
  if (value === undefined) return "drop";
  if (value === "drop" || value === "return") return value;
  throw new Error(`${provider}() sensitiveFields must be "drop" or "return".`);
}
