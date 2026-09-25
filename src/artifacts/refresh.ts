// Deployment-triggered artifact refresh. No interval, cron, or background
// fiber lives here: Node and Workers decide when to call runDue().

import type { ArtifactOperations } from "./operations.js";
import type { ArtifactHeadRecord, ArtifactRunRecord } from "./types.js";

const MAX_DUE_PER_TICK = 10;
const MAX_HEADS_PER_TICK = 1_000;
const MAX_MESSAGE_CHARS = 500;

/** Safe metadata only. Logs and downstream errors never enter the viewer. */
export function freshnessOf(head: ArtifactHeadRecord, now = Date.now()) {
  const refresh = head.refresh;
  if (!refresh) return { state: "unconfigured" as const };
  const period = refresh.schedule === "daily" ? 86_400_000
    : refresh.schedule === "weekly" ? 604_800_000 : undefined;
  const dueAt = period === undefined ? undefined
    : new Date(Date.parse(refresh.last?.at ?? refresh.configuredAt) + period).toISOString();
  const stale = refresh.last?.status === "failed" || refresh.last?.status === "superseded" ||
    (dueAt !== undefined && now >= Date.parse(dueAt));
  return {
    state: stale ? "stale" as const : "current" as const,
    schedule: refresh.schedule,
    document: refresh.document,
    programVersion: refresh.program.version,
    ...(dueAt ? { dueAt } : {}),
    ...(refresh.last ? { last: refresh.last } : {}),
    ...(refresh.claim && Date.parse(refresh.claim.until) > now ? { running: true } : {}),
  };
}

export interface ArtifactRefreshRuntime {
  /** The core's bounded read-only program runner; no sandbox code enters this subpath. */
  execute(program: string, owner: NonNullable<ArtifactHeadRecord["refresh"]>["owner"], signal: AbortSignal): Promise<{ content: { type: string; text?: string }[] }>;
  claimMs: number;
}

export type RefreshOutcome =
  | { status: "skipped" }
  | { status: "succeeded" | "unchanged" | "failed" | "superseded"; runId: string; documentVersion?: number; errorCode?: string };

function capture(text: unknown, bytes: number): string | undefined {
  if (typeof text !== "string" || !text) return undefined;
  const encoder = new TextEncoder();
  let clipped = text.slice(0, bytes);
  while (encoder.encode(clipped).byteLength > bytes) clipped = clipped.slice(0, -1);
  return clipped;
}

function responsePayload(result: { content: { type: string; text?: string }[] }): {
  result?: unknown;
  error?: { code?: string; message?: string };
  logs?: string;
} {
  const text = result.content.find((block) => block.type === "text")?.text;
  if (!text) return { error: { code: "executor_failed", message: "Refresh program returned no result." } };
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return parsed as { result?: unknown; error?: { code?: string; message?: string }; logs?: string };
  } catch {
    return { error: { code: "executor_failed", message: "Refresh program returned an invalid result." } };
  }
}

export class ArtifactRefreshService {
  readonly #ops: ArtifactOperations;
  #runtime: ArtifactRefreshRuntime | undefined;

  constructor(ops: ArtifactOperations) {
    this.#ops = ops;
  }

  bind(runtime: ArtifactRefreshRuntime): void {
    if (this.#runtime) throw new Error("One artifacts() module cannot be bound to two deployments.");
    this.#runtime = runtime;
  }

  async run(id: string, trigger: ArtifactRunRecord["trigger"]): Promise<RefreshOutcome> {
    const runtime = this.#runtime;
    if (!runtime) throw new Error("Create a Connecta deployment with this artifacts() module before refreshing.");
    const runId = crypto.randomUUID();
    const claimed = await this.#ops.claimRefresh(id, runId, trigger, trigger === "schedule", runtime.claimMs);
    if (!claimed.ok) {
      if ("skipped" in claimed) return { status: "skipped" };
      throw new Error(claimed.message);
    }
    const run = claimed.run;
    const deadline = Date.parse(claimed.head.refresh!.claim!.until);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(0, deadline - Date.now()));
    let outcome: RefreshOutcome;
    try {
      await this.#ops.store.putRun(id, run);
      if (Date.now() >= deadline) throw new Error("Refresh claim expired before execution.");
      const response = responsePayload(await runtime.execute(claimed.program, claimed.head.refresh!.owner, controller.signal));
      const logs = capture(response.logs, this.#ops.context.limits.runLogBytes);
      if (logs) run.logs = logs;
      if (response.error) {
        run.status = "failed";
        run.errorCode = capture(response.error.code, 80) ?? "executor_failed";
        const message = capture(response.error.message, MAX_MESSAGE_CHARS);
        if (message) run.message = message;
        outcome = { status: "failed", runId, errorCode: run.errorCode };
      } else if (response.result === null || response.result === undefined) {
        run.status = "failed";
        run.errorCode = "invalid_result";
        run.message = "Refresh program must return a non-null JSON value.";
        outcome = { status: "failed", runId, errorCode: run.errorCode };
      } else {
        const document = claimed.head.refresh!.document;
        const baseVersion = claimed.head.documents[document]?.version ?? 0;
        const saved = await this.#ops.setDocuments({
          id,
          documents: { [document]: { baseVersion, value: response.result } },
          by: { kind: "refresh" },
          op: "refresh", runId,
          programVersion: run.programVersion,
        });
        if (saved.ok) {
          run.status = "succeeded";
          const documentVersion = saved.head.documents[document]?.version;
          if (documentVersion !== undefined) run.documentVersion = documentVersion;
          outcome = { status: "succeeded", runId,
            ...(documentVersion !== undefined ? { documentVersion } : {}) };
        } else {
          run.status = saved.code === "conflict" ? "superseded" : "failed";
          run.errorCode = saved.code;
          const message = capture(saved.message, MAX_MESSAGE_CHARS);
          if (message) run.message = message;
          outcome = { status: run.status, runId, errorCode: run.errorCode };
        }
      }
    } catch (error) {
      run.status = "failed";
      run.errorCode = "refresh_failed";
      const message = capture(error instanceof Error ? error.message : String(error), MAX_MESSAGE_CHARS);
      if (message) run.message = message;
      outcome = { status: "failed", runId, errorCode: run.errorCode };
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
    run.finishedAt = new Date().toISOString();
    await this.#ops.finishRefresh(id, run);
    return outcome;
  }

  async runDue(): Promise<{ scanned: number; started: number; succeeded: number; failed: number; capped: boolean }> {
    if (!this.#runtime) throw new Error("Create a Connecta deployment before running refreshes.");
    let after = await this.#ops.store.refreshScanCursor();
    let scanned = 0;
    let started = 0;
    let succeeded = 0;
    let failed = 0;
    while (scanned < MAX_HEADS_PER_TICK && started < MAX_DUE_PER_TICK) {
      const page = await this.#ops.store.heads({
        ...(after ? { after } : {}),
        limit: Math.min(100, MAX_HEADS_PER_TICK - scanned),
      });
      if (!page.heads.length) { after = undefined; break; }
      for (const { id, head } of page.heads) {
        scanned++;
        after = id;
        if (!head.refresh || head.archived) continue;
        const outcome = await this.run(id, "schedule");
        if (outcome.status === "skipped") continue;
        started++;
        if (outcome.status === "succeeded" || outcome.status === "unchanged") succeeded++;
        else failed++;
        if (started >= MAX_DUE_PER_TICK) break;
      }
      if (!page.next || started >= MAX_DUE_PER_TICK) {
        if (!page.next && started < MAX_DUE_PER_TICK && scanned < MAX_HEADS_PER_TICK) after = undefined;
        break;
      }
    }
    await this.#ops.store.setRefreshScanCursor(after);
    return { scanned, started, succeeded, failed,
      capped: scanned >= MAX_HEADS_PER_TICK || started >= MAX_DUE_PER_TICK };
  }
}
