export async function unsupportedImport() {
  // This loader can finish inside any heuristic quiet window. It must fail
  // at entry, including when the provider swallows the resulting exception.
  try {
    await import("./load-probe.js");
  } catch {
    /* Capture remains invalid. */
  }
  return "done";
}
