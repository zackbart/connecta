/** Claude Code sign-in, with CLI isolation and only the fake MCP server per trial. */
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { CodexOptions, CodexRun } from "./codex.js";
import { assertSurface } from "./surface.js";
import type { StreamEvent } from "./trace.js";

export const CLAUDE_MODELS = ["claude-sonnet-5-5"];

export async function claudeVersion(): Promise<string> {
  return await new Promise((resolve) => {
    const child = spawn("claude", ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
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
  const root = await mkdtemp(join(tmpdir(), "connecta-eval-claude-"));
  const cwd = join(root, "empty-workspace");
  const configPath = join(root, "mcp.json");
  try {
    await mkdir(cwd);
    await writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          connecta: {
            type: "http",
            url: options.mcpUrl,
            headers: { Authorization: `Bearer ${options.token}` },
          },
        },
      }),
      { mode: 0o600 },
    );
    const argv = [
      ...(options.testHost?.args ?? []),
      "--print",
      "--verbose",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--model",
      options.model,
      "--tools",
      "",
      "--setting-sources",
      "",
      "--disable-slash-commands",
      "--no-chrome",
      "--settings",
      JSON.stringify({
        disableAllHooks: true,
        autoMemoryEnabled: false,
        enabledPlugins: {
          "cc-plugin-agents-md@builtin": false,
          "cc-plugin-telemetry@builtin": false,
          "cc-plugin-plugin-authoring@builtin": false,
        },
      }),
      "--strict-mcp-config",
      "--mcp-config",
      configPath,
      "--no-session-persistence",
      "--permission-mode",
      "dontAsk",
      "--permission-prompts",
      "none",
      "--allowedTools",
      options.allowedTools.map((tool) => `mcp__connecta__${tool}`).join(","),
      ...(options.deniedTools.length
        ? ["--disallowedTools", options.deniedTools.map((tool) => `mcp__connecta__${tool}`).join(",")]
        : []),
      "--system-prompt",
      "Complete the user's task using only the connecta MCP tools. Do not use shell, files, web, or other services.",
      ...(options.maxBudgetUsd === undefined ? [] : ["--max-budget-usd", String(options.maxBudgetUsd)]),
    ];
    const started = performance.now();
    const child = spawn(options.testHost?.executable ?? "claude", argv, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      // Preserve the owner's home/keychain login without reading credentials;
      // the macOS keychain lookup needs USER as well as HOME.
      // Do not let inherited API keys, alternate providers, bare mode, or an
      // enclosing Claude session override subscription auth or CLI isolation.
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        USER: process.env.USER,
        TZ: "UTC",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
        CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: "1",
        ENABLE_CLAUDEAI_MCP_SERVERS: "false",
      },
    });
    const events: StreamEvent[] = [];
    const turnStarts: number[] = [];
    let stderrTail = "";
    let timedOut = false;
    let model: string | undefined;
    let loadedTools: string[] = [];
    let finishTurn: (() => void) | undefined;
    let ended = false;
    let completionStopRequested = false;
    let terminatedAfterCompletion = false;
    const push = (event: StreamEvent) => {
      events.push(event);
      options.onEvent?.(event);
    };
    let stopWaiting: (() => void) | undefined;
    const stopped = new Promise<undefined>((resolve) => {
      stopWaiting = () => resolve(undefined);
    });
    const kill = () => {
      stopWaiting?.();
      const sent = child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
      return sent;
    };
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      let event: StreamEvent;
      try {
        event = JSON.parse(line) as StreamEvent;
      } catch {
        return;
      }
      push(event);
      if (event.type === "system" && event.subtype === "init") {
        model = typeof event.model === "string" ? event.model : undefined;
        loadedTools = Array.isArray(event.tools) ? event.tools.map(String) : [];
        try {
          // Denied tools can be omitted by Claude's inventory, but no built-in
          // tool, unrelated server, or retired meta-tool is allowed.
          assertSurface(
            [
              ...loadedTools,
              ...options.deniedTools.map((t) => `mcp__connecta__${t}`).filter((t) => !loadedTools.includes(t)),
            ],
            options.surface,
          );
          if ([event.plugins, event.skills].some((value) => Array.isArray(value) && value.length)) {
            // Report only source/name fields, never plugin settings or credentials.
            const plugins = Array.isArray(event.plugins)
              ? event.plugins.map((plugin) => {
                  if (typeof plugin === "string") return plugin;
                  if (plugin && typeof plugin === "object") {
                    if (typeof plugin.source === "string") return plugin.source;
                    if (typeof plugin.name === "string") return plugin.name;
                  }
                  return "<unknown>";
                })
              : [];
            const skills = Array.isArray(event.skills)
              ? event.skills.map((skill) => (typeof skill === "string" ? skill : "<unknown>"))
              : [];
            const inventory = JSON.stringify({ plugins, skills }).replaceAll(options.token, "<redacted>");
            throw new Error(`Claude loaded plugins or skills outside the fake MCP config: ${inventory}`);
          }
          if (model !== options.model) throw new Error(`Claude served ${String(model)} instead of ${options.model}`);
        } catch (error) {
          push({ type: "result", subtype: "error", result: String(error) });
          kill();
          return;
        }
      }
      if (event.type === "result") finishTurn?.();
    });
    child.stderr.on("data", (chunk) => {
      stderrTail = (stderrTail + String(chunk)).slice(-4_000);
    });
    const exited = new Promise<number | null>((resolve) => {
      const end = (code: number | null, signal?: NodeJS.Signals | null) => {
        // A numeric 143 can be an independent exit whose notification was
        // pending when kill() succeeded. Require the OS-reported signal.
        terminatedAfterCompletion = completionStopRequested && signal === "SIGTERM";
        ended = true;
        stopWaiting?.();
        finishTurn?.();
        resolve(code);
      };
      child.on("close", end);
      child.on("error", (error) => {
        push({ type: "result", subtype: "error", result: String(error) });
        end(-1);
      });
    });
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, options.timeoutMs);
    options.signal?.addEventListener("abort", kill, { once: true });
    if (options.signal?.aborted) kill();
    let conversationEnded = false;
    try {
      let prompt: string | undefined = options.firstPrompt;
      let turn = 0;
      while (prompt !== undefined && !ended && !timedOut && !options.signal?.aborted) {
        turnStarts.push(events.length);
        const done = new Promise<void>((resolve) => {
          finishTurn = resolve;
        });
        child.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content: prompt } })}\n`);
        await done;
        finishTurn = undefined;
        turn += 1;
        if (events.at(-1)?.subtype !== "success" || ended || timedOut || options.signal?.aborted) break;
        prompt = await Promise.race([options.nextTurn(turn, events), stopped]);
      }
      conversationEnded =
        prompt === undefined &&
        !timedOut &&
        !options.signal?.aborted &&
        events.filter((e) => e.type === "result").every((e) => e.subtype === "success");
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", kill);
      child.stdin.end();
      if (!ended && child.exitCode === null && child.signalCode === null) {
        completionStopRequested = kill() && conversationEnded;
      }
    }
    const exitCode = await exited;
    return {
      events,
      turnStarts,
      exitCode,
      terminatedAfterCompletion,
      timedOut,
      aborted: options.signal?.aborted ?? false,
      stderrTail: stderrTail.replaceAll(options.token, "<redacted>"),
      wallMs: Math.round(performance.now() - started),
      argv: argv.map((arg) => (arg === configPath ? "<mcp-config>" : arg)),
      model,
      loadedTools,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
