// Imported dynamically by the probe inside a capture. Both load-time values
// and module state must restart for each order and each subsequent capture.
const loadedAt = Date.now();
const now = performance.now.bind(performance);
const timeout = setTimeout.bind(globalThis);
let calls = 0;
export async function sample() {
  const before = now();
  await new Promise((resolve) => timeout(resolve, 5));
  return { loadedAt, calls: ++calls, before, after: now() };
}
