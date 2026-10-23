/**
 * Items of a possibly cut-off JSON array, or complete NDJSON lines: a bounded
 * log read stops mid-body, and the rows it finished are still the answer.
 */
export function completeRows(body: string): unknown[] {
  const trimmed = body.trimStart();
  if (!trimmed.startsWith("[")) {
    const rows: unknown[] = [];
    for (const line of body.split("\n")) {
      if (line.trim() === "") continue;
      try {
        rows.push(JSON.parse(line));
      } catch {
        // A line the read cut off, or one Vercel did not finish.
      }
    }
    return rows;
  }
  try {
    const whole = JSON.parse(trimmed) as unknown;
    if (Array.isArray(whole)) return whole;
  } catch {
    // Cut off: scan for the complete top-level items below.
  }
  const rows: unknown[] = [];
  let depth = 0;
  let start = -1;
  let quoted = false;
  let escaped = false;
  for (let at = 1; at < trimmed.length; at += 1) {
    const character = trimmed[at];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') {
      quoted = true;
      if (depth === 0 && start < 0) start = at;
    } else if (character === "{" || character === "[") {
      if (depth === 0) start = at;
      depth += 1;
    } else if (character === "}" || character === "]") {
      depth -= 1;
      if (depth < 0) break;
      if (depth === 0 && start >= 0) {
        try {
          rows.push(JSON.parse(trimmed.slice(start, at + 1)));
        } catch {
          // Not a complete item.
        }
        start = -1;
      }
    }
  }
  return rows;
}

export interface LogLimits {
  waitMs: number;
  maxRows?: number;
  accept?: (row: unknown) => boolean;
}
/** Count completed rows only; retained text is just the unfinished line. */
export function rowStop(limits: LogLimits): (chunk: Uint8Array) => boolean {
  const decoder = new TextDecoder();
  let pending = "";
  let rows = 0;
  return (chunk) => {
    if (limits.maxRows === undefined) return false;
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim() === "") continue;
      let row: unknown;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (limits.accept && !limits.accept(row)) continue;
      if (++rows >= limits.maxRows) return true;
    }
    return false;
  };
}
