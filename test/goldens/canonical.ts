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
