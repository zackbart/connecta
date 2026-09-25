/** Raw issue rows also state the counts when they exactly cover the open bugs. */
export function hasExactOpenBugRows(
  documents: unknown,
  expected: { id: string; project: string }[],
): boolean {
  const byId = new Map(expected.map(issue => [issue.id, issue.project]));
  if (byId.size !== expected.length) return false;
  const exact = (rows: unknown[]): boolean => {
    if (rows.length !== expected.length) return false;
    const seen = new Set<string>();
    for (const row of rows) {
      if (row === null || typeof row !== "object" || Array.isArray(row)) return false;
      const issue = row as Record<string, unknown>;
      if (typeof issue.id !== "string" || typeof issue.project !== "string" ||
        byId.get(issue.id) !== issue.project || seen.has(issue.id) ||
        (issue.status !== undefined && issue.status !== "open") ||
        (issue.labels !== undefined &&
          (!Array.isArray(issue.labels) || !issue.labels.includes("bug")))) return false;
      seen.add(issue.id);
    }
    return seen.size === byId.size;
  };
  const visit = (value: unknown): boolean => {
    if (Array.isArray(value)) return exact(value) || value.some(visit);
    return value !== null && typeof value === "object" &&
      Object.values(value as Record<string, unknown>).some(visit);
  };
  return visit(documents);
}

