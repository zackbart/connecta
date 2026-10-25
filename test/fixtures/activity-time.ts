// Keep generated activity recent and its ordering stable across slow I/O.
// Explicit historical and retention cases supply their own timestamps.
const base = Math.trunc(Date.now() / 1000) * 1000;

export function activityFixtureTime(index: number): string {
  return new Date(base + index * 1_000).toISOString();
}
