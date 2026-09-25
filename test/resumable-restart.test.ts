// A paused run survives a restart (#565): pause through one deployment,
// close it, open a second over the same file store, and resume there to
// completion. Real QuickJS, real MCP requests — and the replay has to
// reproduce the first play's clock and random draws to get past its own
// pending write.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { quickJsExecutor } from "../src/executors/quickjs.js";
import { createConnecta } from "../src/index.js";
import { fileStorage } from "../src/storage/file.js";
import type { Connector } from "../src/types.js";
import { mcpRpc, readJsonRpc } from "./fixtures/http.js";
import { required } from "./helpers.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function tracker(log: string[]): Connector {
  return {
    id: "tracker",
    kind: "api",
    description: "Issues",
    async listTools() {
      return [
        { name: "list_issues", annotations: { readOnlyHint: true } },
        { name: "close_issue", annotations: { destructiveHint: true } },
      ];
    },
    async callTool(name, args) {
      log.push(`${name}:${JSON.stringify(args)}`);
      if (name === "list_issues") return { issues: [{ id: 7 }, { id: 8 }] };
      return { closed: (args as { id: number }).id };
    },
  };
}

const PROGRAM = `async () => {
  const { issues } = await connecta.call("tracker.list_issues", {});
  const marker = Math.floor(Math.random() * 1e9);
  const at = Date.now();
  const closed = [];
  for (const issue of issues) {
    await connecta.call("tracker.close_issue", { id: issue.id, marker, at });
    closed.push(issue.id);
  }
  return { closed, marker, at };
}`;

async function call(
  deployment: ReturnType<typeof createConnecta>,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError?: boolean; structuredContent: Record<string, any> }> {
  const json = await readJsonRpc(
    await mcpRpc(deployment, "tools/call", { name, arguments: args }),
  );
  return required(json.result, JSON.stringify(json));
}

describe("resumable writes across a restart", () => {
  it("resumes a run paused before the deployment closed", async () => {
    const directory = mkdtempSync(join(tmpdir(), "connecta-resume-"));
    directories.push(directory);
    const path = join(directory, "store.json");

    const firstLog: string[] = [];
    const firstStore = fileStorage(path);
    const first = createConnecta({
      connectors: [tracker(firstLog)],
      executor: quickJsExecutor({ cpuTimeMs: 5_000 }),
      storage: firstStore,
      logger: "silent",
      execute: { resumableWrites: true },
    });
    const pausedResult = await call(first, "execute_code", { code: PROGRAM });
    expect(pausedResult.isError, JSON.stringify(pausedResult)).not.toBe(true);
    const pause = pausedResult.structuredContent.paused as {
      token: string;
      address: string;
      args: { id: number; marker: number; at: number };
    };
    expect(pause.address).toBe("tracker.close_issue");
    expect(pause.args.id).toBe(7);
    expect(firstLog).toEqual(["list_issues:{}"]);
    await first.close();
    firstStore.close();

    const secondLog: string[] = [];
    const secondStore = fileStorage(path);
    const second = createConnecta({
      connectors: [tracker(secondLog)],
      executor: quickJsExecutor({ cpuTimeMs: 5_000 }),
      storage: secondStore,
      logger: "silent",
      execute: { resumableWrites: true },
    });
    try {
      const done = await call(second, "resume_execution", {
        token: pause.token,
        address: pause.address,
        args: pause.args,
        approval: "tool",
      });
      expect(done.isError, JSON.stringify(done)).not.toBe(true);
      // The replay drew the same marker and read the same clock, so it
      // re-issued exactly the approved write; the list was not read again.
      expect(done.structuredContent.result).toEqual({
        closed: [7, 8],
        marker: pause.args.marker,
        at: pause.args.at,
      });
      expect(secondLog).toEqual([
        `close_issue:${JSON.stringify(pause.args)}`,
        `close_issue:${JSON.stringify({ ...pause.args, id: 8 })}`,
      ]);
    } finally {
      await second.close();
      secondStore.close();
    }
  });
});
