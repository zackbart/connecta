import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ActivityPage,
  ActivityStore,
  ToolCallActivityEvent,
} from "../src/index.js";
import { fileActivityStore } from "../templates/node/src/file-activity.js";

/**
 * The Node template's activity store is deployment-owned code the template
 * ships compiled rather than commented, so it is ours to keep honest: a
 * container is killed mid-append eventually, and the failure this suite exists
 * for is the quiet one — an event that reads back fine until the next restart
 * drops it (#345).
 */
let directory: string;
let logPath: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "connecta-activity-"));
  logPath = join(directory, "activity.jsonl");
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function event(
  index: number,
  overrides: Partial<ToolCallActivityEvent> = {},
): ToolCallActivityEvent {
  return {
    schemaVersion: 1,
    id: `${index}`.padStart(8, "0"),
    occurredAt: new Date(1_700_000_000_000 + index * 1_000).toISOString(),
    requestId: `request-${index}`,
    actor: { kind: "bearer", id: "operator" },
    connectorId: "time",
    toolName: "get_now",
    address: "time.get_now",
    source: "call_tool",
    outcome: "success",
    durationMs: 3,
    attempts: 1,
    serverName: "connecta",
    serverVersion: "0.15.0",
    ...overrides,
  };
}

function lines(): string[] {
  return readFileSync(logPath, "utf8").split("\n").filter(Boolean);
}

/** `list` is the optional half of `ActivityStore`; this store implements it. */
async function read(
  store: ActivityStore,
  args: { limit: number; cursor?: string },
): Promise<ActivityPage> {
  const list = store.list;
  if (!list) throw new Error("the template store must implement list()");
  return list.call(store, args);
}

async function idsOnDisk(): Promise<string[]> {
  const page = await read(fileActivityStore(logPath), { limit: 100 });
  return page.events.map((entry) => entry.id);
}

describe("template file activity store", () => {
  it("keeps what it recorded across a restart", async () => {
    const store = fileActivityStore(logPath);
    store.record(event(1));
    store.record(event(2));
    expect(await idsOnDisk()).toEqual(["00000002", "00000001"]);
  });

  it("repairs a torn trailing line instead of appending onto it", async () => {
    // A container killed between the write and the newline: the last line is a
    // JSON fragment with nothing after it.
    writeFileSync(
      logPath,
      `${JSON.stringify(event(1))}\n${JSON.stringify(event(2))}\n{"schemaVer`,
    );
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = fileActivityStore(logPath);
    warn.mockRestore();

    // The fragment is gone from the file, not merely from memory: two whole
    // lines, each of them parseable, and a newline to append after.
    const repaired = readFileSync(logPath, "utf8");
    expect(repaired.endsWith("\n")).toBe(true);
    expect(lines()).toHaveLength(2);
    expect(() => lines().map((line) => JSON.parse(line))).not.toThrow();

    // And the next event survives the restart that follows it — the whole
    // point: appending onto the fragment would have made this one unreadable.
    store.record(event(3));
    expect(await idsOnDisk()).toEqual([
      "00000003",
      "00000002",
      "00000001",
    ]);
  });

  it("repairs a complete last line that never got its newline", async () => {
    writeFileSync(
      logPath,
      `${JSON.stringify(event(1))}\n${JSON.stringify(event(2))}`,
    );
    const store = fileActivityStore(logPath);
    store.record(event(3));
    expect(lines()).toHaveLength(3);
    expect(await idsOnDisk()).toEqual([
      "00000003",
      "00000002",
      "00000001",
    ]);
  });

  it("leaves an intact log alone at startup", () => {
    const intact = `${JSON.stringify(event(1))}\n${JSON.stringify(event(2))}\n`;
    writeFileSync(logPath, intact);
    fileActivityStore(logPath);
    // No rewrite: an undamaged file is not worth rewriting on every boot.
    expect(readFileSync(logPath, "utf8")).toBe(intact);
  });

  it("pages newest first without repeating or skipping an event", async () => {
    const store = fileActivityStore(logPath);
    for (let index = 1; index <= 7; index += 1) store.record(event(index));

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const result = await read(store, {
        limit: 3,
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...result.events.map((entry) => entry.id));
      cursor = result.nextCursor;
      if (!cursor) break;
    }

    expect(cursor).toBeUndefined();
    expect(seen).toEqual([
      "00000007",
      "00000006",
      "00000005",
      "00000004",
      "00000003",
      "00000002",
      "00000001",
    ]);
  });

  it("compacts to the newest maxEvents once past the slack window", async () => {
    const store = fileActivityStore(logPath, { maxEvents: 10 });
    // 511 events: ten retained plus a 500-event slack window, plus the write
    // that crosses it.
    for (let index = 1; index <= 511; index += 1) store.record(event(index));

    expect(lines()).toHaveLength(10);
    const page = await read(store, { limit: 100 });
    expect(page.events).toHaveLength(10);
    expect(page.events[0]?.id).toBe("00000511");
    expect(page.events.at(-1)?.id).toBe("00000502");
    // The file is the same truth as memory after a compaction.
    expect(await idsOnDisk()).toEqual(page.events.map((entry) => entry.id));
  });

  it("holds the slack window in the file before compacting", () => {
    const store = fileActivityStore(logPath, { maxEvents: 10 });
    for (let index = 1; index <= 510; index += 1) store.record(event(index));
    expect(lines()).toHaveLength(510);
  });
});
