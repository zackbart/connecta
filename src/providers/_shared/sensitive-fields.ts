// A provider's sensitive fields leave every result unless deployment code
// returns them; no tool argument can. Shared by the providers whose raw rows
// and hatches would otherwise reach what their projections drop.

/** What `raw: true` and the hatches return, under the deployment's `sensitiveFields` choice. */
export function unprojectedResults(sensitiveFields: "drop" | "return", names: readonly string[]): <T>(body: T) => T {
  if (sensitiveFields === "return") return (body) => body;
  const dropped = new Set(names);
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value)
        .filter(([name]) => !dropped.has(name))
        .map(([name, entry]) => [name, strip(entry)]),
    );
  };
  return <T>(body: T) => strip(body) as T;
}

/** Refuse anything but the two choices, at construction (INV-11). */
export function sensitiveFieldsOption(provider: string, value: unknown): "drop" | "return" {
  if (value === undefined) return "drop";
  if (value === "drop" || value === "return") return value;
  throw new Error(`${provider}() sensitiveFields must be "drop" or "return".`);
}
