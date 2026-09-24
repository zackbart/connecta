/**
 * Headless Claude Code as the agent under test.
 *
 * One process per trial, driven over `--input-format stream-json` so a task
 * can hold a multi-turn conversation (the operator finishes a handoff between
 * turns) without session persistence. Built-in tools are disabled, only the
 * `connecta` MCP server is loaded, and exactly the approvals the task grants
 * are pre-approved; anything else that would prompt is denied, because nobody
 * is there to answer.
 */
import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

export const SERVER_NAME = "connecta";
export const toolId = (tool: string) => `mcp__${SERVER_NAME}__${tool}`;

export type StreamEvent = Record<string, unknown> & { type: string };

export interface ClaudeRun {
  events: StreamEvent[];
  /** Index into `events` where each user turn was sent. */
  turnStarts: number[];
  exitCode: number | null;
  timedOut: boolean;
  stderrTail: string;
  wallMs: number;
  argv: string[];
}

export interface ClaudeOptions {
  model: string;
  mcpUrl: string;
  token: string;
  allowedTools: string[];
  disallowedTools: string[];
  timeoutMs: number;
  maxBudgetUsd?: number;
  effort?: string;
  /**
   * Called with the events so far after each completed turn. Returns the next
   * user message, or undefined to end the conversation.
   */
  nextTurn(turnIndex: number, events: StreamEvent[]): Promise<string | undefined>;
  firstPrompt: string;
  /** Observe events as they stream, e.g. for rate-limit guards. */
  onEvent?(event: StreamEvent): void;
  /**
   * Claude Code's own cap on one MCP tool result (`MAX_MCP_OUTPUT_TOKENS`).
   * Unset keeps the host default — which is part of what the evals measure: a
   * result over it is spilled to a file the agent, with no file tools, cannot
   * read.
   */
  mcpOutputTokens?: number;
}

export async function claudeVersion(): Promise<string> {
  return await new Promise((resolve) => {
    const child = spawn("claude", ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (chunk) => (out += String(chunk)));
    child.on("close", () => resolve(out.trim()));
    child.on("error", () => resolve("unavailable"));
  });
}

export async function runClaude(options: ClaudeOptions): Promise<ClaudeRun> {
  const cwd = await mkdtemp(join(tmpdir(), "connecta-eval-agent-"));
  const mcpConfig = join(cwd, "mcp.json");
  await writeFile(
    mcpConfig,
    JSON.stringify({
      mcpServers: {
        [SERVER_NAME]: {
          type: "http",
          url: options.mcpUrl,
          headers: { Authorization: `Bearer ${options.token}` },
        },
      },
    }),
    { mode: 0o600 },
  );
  const argv = [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--model", options.model,
    "--mcp-config", mcpConfig,
    "--strict-mcp-config",
    "--setting-sources", "",
    "--tools", "",
    "--allowedTools", options.allowedTools.join(","),
    ...(options.disallowedTools.length
      ? ["--disallowedTools", options.disallowedTools.join(",")]
      : []),
    "--permission-prompts", "none",
    "--no-session-persistence",
    "--no-chrome",
    ...(options.maxBudgetUsd ? ["--max-budget-usd", String(options.maxBudgetUsd)] : []),
    ...(options.effort ? ["--effort", options.effort] : []),
  ];
  const started = performance.now();
  const child = spawn("claude", argv, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
      // Claude Code tells the model today's local date, and the fakes' clock
      // is an instant. Pinning UTC makes that date the fakes' date wherever
      // and whenever the eval runs; otherwise an evening run west of UTC
      // hands the agent yesterday, and date-only cutoffs drift by a day.
      TZ: "UTC",
      ...(options.mcpOutputTokens ? { MAX_MCP_OUTPUT_TOKENS: String(options.mcpOutputTokens) } : {}),
    },
  });
  const events: StreamEvent[] = [];
  const turnStarts: number[] = [];
  let stderrTail = "";
  child.stderr.on("data", (chunk) => {
    stderrTail = (stderrTail + String(chunk)).slice(-4_000);
  });
  const send = (text: string) => {
    turnStarts.push(events.length);
    child.stdin.write(
      `${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`,
    );
  };
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
  }, options.timeoutMs);
  const exited = new Promise<number | null>((resolve) => {
    child.on("close", (code) => resolve(code));
    child.on("error", () => resolve(-1));
  });
  let turn = 0;
  let pending = Promise.resolve();
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    let event: StreamEvent;
    try {
      event = JSON.parse(line) as StreamEvent;
    } catch {
      return;
    }
    events.push(event);
    options.onEvent?.(event);
    if (event.type === "result") {
      turn += 1;
      const current = turn;
      pending = pending.then(async () => {
        const next = await options.nextTurn(current, events);
        if (next === undefined || timedOut) child.stdin.end();
        else send(next);
      });
    }
  });
  send(options.firstPrompt);
  const exitCode = await exited;
  clearTimeout(timer);
  await pending.catch(() => undefined);
  await rm(cwd, { recursive: true, force: true });
  // Even without session persistence, Claude Code spills oversized tool
  // results into a per-cwd project directory. Leave the user's config as found.
  const project = (await realpath(tmpdir())).replace(/[^a-zA-Z0-9]/g, "-");
  const slug = `${project}-${cwd.split("/").at(-1)!.replace(/[^a-zA-Z0-9]/g, "-")}`;
  await rm(join(homedir(), ".claude", "projects", slug), { recursive: true, force: true });
  return {
    events,
    turnStarts,
    exitCode,
    timedOut,
    stderrTail,
    wallMs: Math.round(performance.now() - started),
    argv: argv.map((arg) => (arg === mcpConfig ? "<mcp.json>" : arg)),
  };
}
