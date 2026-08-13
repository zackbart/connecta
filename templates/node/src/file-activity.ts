/**
 * Payload-free tool activity, kept in a JSON-lines file beside the state file.
 *
 * Deployment-owned on purpose: Connecta ships the `ActivityStore` contract, not
 * a backend, because retention is a decision only the operator can make. This
 * is the Node counterpart of the Worker example's D1 store, sized for one
 * container rather than a fleet — a write appends one line, and the log is
 * bounded by a count of events instead of by age, so nothing has to be
 * scheduled.
 *
 * Nothing wires it by default. `src/index.ts` carries the commented lines that
 * turn it on; README.md § "Turn on the operator surface" explains why they are
 * commented.
 */
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type {
  ActivityPage,
  ActivityStore,
  ToolCallActivityEvent,
} from "@zackbart/connecta";
import { InvalidActivityCursorError } from "@zackbart/connecta";

/**
 * Events allowed past `maxEvents` before the log is rewritten. Trimming on the
 * write that first crosses the ceiling would rewrite the whole file on every
 * call from then on; this pays that cost once per slack window instead.
 */
const COMPACTION_SLACK = 500;

export interface FileActivityOptions {
  /** Newest events retained after a compaction. Default 5,000. */
  maxEvents?: number;
}

/** Newest first, with the id breaking ties inside a millisecond. */
function newestFirst(
  a: ToolCallActivityEvent,
  b: ToolCallActivityEvent,
): number {
  const byTime = Date.parse(b.occurredAt) - Date.parse(a.occurredAt);
  return byTime !== 0 ? byTime : b.id.localeCompare(a.id);
}

function encodeCursor(event: ToolCallActivityEvent): string {
  return Buffer.from(`${Date.parse(event.occurredAt)}:${event.id}`).toString(
    "base64",
  );
}

function decodeCursor(value: string): { occurredAtMs: number; id: string } {
  const decoded = Buffer.from(value, "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  const occurredAtMs = Number(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);
  if (separator < 1 || !Number.isSafeInteger(occurredAtMs) || !id) {
    throw new InvalidActivityCursorError();
  }
  return { occurredAtMs, id };
}

/** Strictly older than the cursor position, in the order above. */
function isBefore(
  event: ToolCallActivityEvent,
  position: { occurredAtMs: number; id: string },
): boolean {
  const occurredAtMs = Date.parse(event.occurredAt);
  if (occurredAtMs !== position.occurredAtMs) {
    return occurredAtMs < position.occurredAtMs;
  }
  return event.id.localeCompare(position.id) < 0;
}

/**
 * One append-only record per completed downstream call. Events carry no
 * arguments, results, generated code, or raw error messages — the store never
 * has a payload to leak. Writes are best-effort by contract: a throw here is
 * logged by Connecta and never reaches the tool result.
 */
export function fileActivityStore(
  path: string,
  opts: FileActivityOptions = {},
): ActivityStore {
  const maxEvents = Math.max(1, Math.trunc(opts.maxEvents ?? 5_000));
  // Activity records who called what, so it is owner-only like the state file.
  const tighten = () => {
    try {
      chmodSync(path, 0o600);
    } catch {
      // Non-POSIX filesystem or a race on the file — leave the mode as-is.
    }
  };
  let events: ToolCallActivityEvent[] = [];
  // Damage found at load that the file itself still carries: a dropped line, or
  // a last line with no newline after it. Both are repaired by rewriting the
  // file from what parsed, because the alternative is appending onto a
  // fragment and losing the *next* event too — one that never had anything
  // wrong with it.
  let repairNeeded = false;
  if (existsSync(path)) {
    tighten();
    // A half-written trailing line is the normal cost of an append log, and
    // one unreadable line is not a reason to lose the history above it. Unlike
    // the state file there is nothing irreplaceable here — this is a record of
    // calls that already happened — so damaged lines are dropped, loudly.
    const raw = readFileSync(path, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    let dropped = 0;
    for (const line of lines) {
      try {
        events.push(JSON.parse(line) as ToolCallActivityEvent);
      } catch {
        dropped += 1;
      }
    }
    if (dropped > 0) {
      console.error(
        `[connecta] activity log ${path}: dropped ${dropped} unreadable ` +
          `line(s) of ${lines.length}.`,
      );
    }
    repairNeeded = dropped > 0 || (raw.length > 0 && !raw.endsWith("\n"));
  }
  const ensureDirectory = () => {
    const dir = dirname(path);
    if (dir) mkdirSync(dir, { recursive: true, mode: 0o700 });
  };
  const compact = () => {
    events = [...events].sort(newestFirst).slice(0, maxEvents);
    ensureDirectory();
    const tmp = `${path}.tmp`;
    // 0o600 on the temp file; the rename preserves it, so the live log is
    // never briefly world-readable.
    writeFileSync(
      tmp,
      events.map((event) => `${JSON.stringify(event)}\n`).join(""),
      { mode: 0o600 },
    );
    renameSync(tmp, path);
    tighten();
  };
  // Repair before the first append rather than at the next restart: the
  // fragment is on disk until something rewrites the file, and an append onto
  // it corrupts a good event into an unreadable line.
  if (repairNeeded) compact();
  return {
    record(event) {
      events.push(event);
      if (events.length > maxEvents + COMPACTION_SLACK) {
        compact();
        return;
      }
      ensureDirectory();
      appendFileSync(path, `${JSON.stringify(event)}\n`, { mode: 0o600 });
      tighten();
    },

    async list({ cursor, limit }): Promise<ActivityPage> {
      const boundedLimit = Math.min(100, Math.max(1, Math.trunc(limit)));
      const position = cursor ? decodeCursor(cursor) : undefined;
      const ordered = [...events]
        .sort(newestFirst)
        .filter((event) => !position || isBefore(event, position));
      const visible = ordered.slice(0, boundedLimit);
      const last = visible.at(-1);
      return {
        events: visible,
        ...(ordered.length > visible.length && last
          ? { nextCursor: encodeCursor(last) }
          : {}),
      };
    },
  };
}
