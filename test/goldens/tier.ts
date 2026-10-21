// One canonical capture per provider on both runtimes. Keep the harness's
// source and mutation checks, with one schedule instead of a jitter matrix.
// These exports also serve the harness suites while its stress cases are pruned.
export const fullTier = false;
export const bothOrders = false;
export const captureOrders = "canonical";
export const tierSeeds = <T>(seeds: T[]): T[] => seeds.slice(0, 1);

/** Project only harness observation positions; vendor fields remain verbatim. */
export function canonicalGolden(bytes: string, file: "catalog" | "calls" | "failures" | "setup" = "calls"): string {
  if (file === "catalog") return bytes;
  let projected = false;
  const observation = (row: Record<string, unknown>) => {
    if (!Object.hasOwn(row, "variants")) return row;
    projected = true;
    const { variants: _variants, ...canonical } = row;
    return canonical;
  };
  let value = JSON.parse(bytes);
  if (file === "calls") value = value.map(observation);
  else if (file === "setup") {
    if (!Array.isArray(value)) {
      projected = true;
      value = value.steps;
    }
  } else {
    for (const kind of ["read", "write"]) {
      value[kind].cases = Object.fromEntries(
        Object.entries(value[kind].cases as Record<string, Record<string, unknown>>).map(([name, row]) => [
          name,
          observation(row),
        ]),
      );
    }
  }
  return projected ? `${JSON.stringify(value, null, 2)}\n` : bytes;
}
