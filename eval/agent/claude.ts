/** Claude Code, with one isolated home and only the fake MCP server per trial. */
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { CodexOptions, CodexRun } from "./codex.js";
import { assertSurface } from "./surface.js";
import type { StreamEvent } from "./trace.js";

export const CLAUDE_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5-20251001"];

export async function claudeVersion(): Promise<string> {
  return await new Promise(resolve => {
    const child = spawn("claude", ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    child.stdout.on("data", chunk => { output += String(chunk); });
    child.on("close", () => resolve(output.trim()));
    child.on("error", () => resolve("unavailable"));
  });
}

interface ClaudeOptions extends Omit<CodexOptions, "testHost" | "effort"> {
  maxBudgetUsd?: number;
  testHost?: { executable: string; args: string[] };
}

export async function runClaude(options: ClaudeOptions): Promise<CodexRun> {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new Error("Claude timeout must be positive");
  if (options.signal?.aborted) throw new Error("Claude trial aborted");
  if (!options.testHost && !process.env.ANTHROPIC_API_KEY) {
    throw new Error("Claude eval requires ANTHROPIC_API_KEY; it does not reuse user settings or subscription credentials");
  }
  const root = await mkdtemp(join(tmpdir(), "connecta-eval-claude-"));
  const cwd = join(root, "empty-workspace");
  const configHome = join(root, "claude-home");
  const configPath = join(root, "mcp.json");
  try {
    await mkdir(cwd);
    await mkdir(configHome);
    await writeFile(configPath, JSON.stringify({ mcpServers: { connecta: {
      type: "http", url: options.mcpUrl, headers: { Authorization: `Bearer ${options.token}` },
    } } }), { mode: 0o600 });
    const argv = [
      ...(options.testHost?.args ?? []),
      "--print", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json",
      "--model", options.model, "--tools", "", "--setting-sources", "",
      "--strict-mcp-config", "--mcp-config", configPath, "--no-session-persistence",
      "--permission-mode", "dontAsk", "--permission-prompts", "none",
      "--allowedTools", options.allowedTools.map(tool => `mcp__connecta__${tool}`).join(","),
      ...(options.deniedTools.length ? ["--disallowedTools", options.deniedTools.map(tool => `mcp__connecta__${tool}`).join(",")] : []),
      "--system-prompt", "Complete the user's task using only the connecta MCP tools. Do not use shell, files, web, or other services.",
      ...(options.maxBudgetUsd === undefined ? [] : ["--max-budget-usd", String(options.maxBudgetUsd)]),
    ];
    const started = performance.now();
    const child = spawn(options.testHost?.executable ?? "claude", argv, {
      cwd, stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH, HOME: root, CLAUDE_CONFIG_DIR: configHome, TZ: "UTC",
        ...(options.testHost ? {} : { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }),
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
    });
    const events: StreamEvent[] = [];
    const turnStarts: number[] = [];
    let stderrTail = "";
    let timedOut = false;
    let model: string | undefined;
    let loadedTools: string[] = [];
    let finishTurn: (() => void) | undefined;
    let ended = false;
    const push = (event: StreamEvent) => { events.push(event); options.onEvent?.(event); };
    let stopWaiting: (() => void) | undefined;
    const stopped = new Promise<undefined>(resolve => { stopWaiting = () => resolve(undefined); });
    const kill = () => {
      stopWaiting?.();
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    };
    const lines = createInterface({ input: child.stdout });
    lines.on("line", line => {
      let event: StreamEvent;
      try { event = JSON.parse(line) as StreamEvent; } catch { return; }
      if (event.type === "system" && event.subtype === "init") {
        model = typeof event.model === "string" ? event.model : undefined;
        loadedTools = Array.isArray(event.tools) ? event.tools.map(String) : [];
        try {
          // Denied tools can be omitted by Claude's inventory, but no built-in
          // tool, unrelated server, or retired meta-tool is allowed.
          assertSurface([...new Set([...loadedTools, ...options.deniedTools.map(t => `mcp__connecta__${t}`)])]);
          if (model !== options.model) throw new Error(`Claude served ${String(model)} instead of ${options.model}`);
        } catch (error) {
          push({ type: "result", subtype: "error", result: String(error) });
          kill();
          return;
        }
      }
      push(event);
      if (event.type === "result") finishTurn?.();
    });
    child.stderr.on("data", chunk => { stderrTail = (stderrTail + String(chunk)).slice(-4_000); });
    const exited = new Promise<number | null>(resolve => {
      const end = (code: number | null) => {
        ended = true;
        stopWaiting?.();
        finishTurn?.();
        resolve(code);
      };
      child.on("close", end);
      child.on("error", error => {
        push({ type: "result", subtype: "error", result: String(error) });
        end(-1);
      });
    });
    const timer = setTimeout(() => { timedOut = true; kill(); }, options.timeoutMs);
    options.signal?.addEventListener("abort", kill, { once: true });
    if (options.signal?.aborted) kill();
    try {
      let prompt: string | undefined = options.firstPrompt;
      let turn = 0;
      while (prompt !== undefined && !ended && !timedOut && !options.signal?.aborted) {
        turnStarts.push(events.length);
        const done = new Promise<void>(resolve => { finishTurn = resolve; });
        child.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content: prompt } })}\n`);
        await done;
        finishTurn = undefined;
        turn += 1;
        if (events.at(-1)?.subtype !== "success" || ended || timedOut || options.signal?.aborted) break;
        prompt = await Promise.race([options.nextTurn(turn, events), stopped]);
      }
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", kill);
      child.stdin.end();
      if (!ended) kill();
    }
    const exitCode = await exited;
    return { events, turnStarts, exitCode, timedOut, aborted: options.signal?.aborted ?? false,
      stderrTail: stderrTail.replaceAll(options.token, "<redacted>"),
      wallMs: Math.round(performance.now() - started), argv: argv.map(arg => arg === configPath ? "<mcp-config>" : arg),
      model, loadedTools };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
