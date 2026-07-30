// Agent drivers. Each driver runs one prompt in one throwaway session against
// one gate server and returns the same normalized transcript, so the metrics
// layer never learns which harness produced a sample.
//
// Both drivers are configured to strip everything that is not connecta: no user
// configuration, no built-in tools, no session persistence, no host features,
// and — for the Claude driver — the corpus system prompt in place of the
// harness's own. What is being measured is connecta's surface, not the coding
// agent wrapped around it.
//
// The transcript is the client seat: every tool call the model issued, every
// result it saw, and the provider's own token accounting. Nothing here asks
// connecta to record a payload.

import { spawn, execFileSync } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 300_000;

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function commandVersion(command, args) {
  try {
    return execFileSync(command, args, { encoding: "utf8" }).trim();
  } catch (error) {
    throw new Error(
      `Driver command "${command}" is not runnable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Run a child process that streams newline-delimited JSON on stdout, handing
 * each parsed line to `onEvent`. Rejects on timeout; resolves with the exit
 * code otherwise, since a nonzero exit is itself a measurement.
 */
async function streamJsonProcess(command, args, options, onEvent) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stderr = "";
  let buffered = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdout.on("data", (chunk) => {
    buffered += chunk;
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) break;
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (line.trim() === "") continue;
      const event = parseJson(line);
      if (event) onEvent(event);
    }
  });
  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Driver "${command}" exceeded ${options.timeoutMs} ms.`));
    }, options.timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code ?? -1);
    });
  });
  return { exitCode, stderr: stderr.slice(-4_000) };
}

function mcpToolName(driver, rawName) {
  if (driver === "claude") {
    const match = rawName.match(/^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/);
    if (match) return { server: match[1], tool: match[2] };
    return { server: null, tool: rawName };
  }
  return { server: null, tool: rawName };
}

// ---------------------------------------------------------------------------
// claude
// ---------------------------------------------------------------------------

const claudeDriver = {
  name: "claude",
  version: () => commandVersion("claude", ["--version"]),
  async run({ prompt, systemPrompt, mcpUrl, token, model, timeoutMs, cwd }) {
    const mcpConfig = JSON.stringify({
      mcpServers: {
        connecta: {
          type: "http",
          url: mcpUrl,
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    });
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--strict-mcp-config",
      "--mcp-config",
      mcpConfig,
      // Nothing from the operator's machine leaks into a sample.
      "--setting-sources",
      "",
      "--disable-slash-commands",
      "--no-session-persistence",
      // No built-in tools: the connecta server is the entire capability set.
      "--tools",
      "",
      "--allowedTools",
      "mcp__connecta",
      "--permission-mode",
      "bypassPermissions",
      "--system-prompt",
      systemPrompt,
      ...(model ? ["--model", model] : []),
      prompt,
    ];
    const started = performance.now();
    const events = [];
    const pending = new Map();
    let finalText = "";
    let resolvedModel;
    let usage;
    let usageByModel = {};
    let costUsd;
    let permissionDenials = 0;
    let apiErrorStatus = null;
    const at = () => Math.round(performance.now() - started);

    const { exitCode, stderr } = await streamJsonProcess(
      "claude",
      args,
      { cwd, env: process.env, timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS },
      (event) => {
        if (event.type === "system" && event.subtype === "init") {
          resolvedModel = event.model;
          return;
        }
        if (event.type === "assistant") {
          for (const block of event.message?.content ?? []) {
            if (block.type === "text" && typeof block.text === "string") {
              if (block.text.trim() !== "") {
                finalText = block.text;
                events.push({ kind: "assistant_text", atMs: at(), text: block.text });
              }
              continue;
            }
            if (block.type === "tool_use") {
              const { server, tool } = mcpToolName("claude", block.name ?? "");
              pending.set(block.id, { server, tool, atMs: at() });
              events.push({
                kind: "tool_call",
                atMs: at(),
                server,
                tool,
                args: block.input ?? {},
              });
            }
          }
          return;
        }
        if (event.type === "user") {
          for (const block of event.message?.content ?? []) {
            if (block.type !== "tool_result") continue;
            const call = pending.get(block.tool_use_id) ?? {
              server: null,
              tool: "unknown",
              atMs: at(),
            };
            pending.delete(block.tool_use_id);
            events.push({
              kind: "tool_result",
              atMs: at(),
              server: call.server,
              tool: call.tool,
              isError: block.is_error === true,
              durationMs: at() - call.atMs,
              result: block.content ?? null,
            });
          }
          return;
        }
        if (event.type === "result") {
          usage = event.usage ?? {};
          costUsd = event.total_cost_usd;
          permissionDenials = Array.isArray(event.permission_denials)
            ? event.permission_denials.length
            : 0;
          apiErrorStatus = event.api_error_status ?? null;
          if (typeof event.result === "string" && event.result.trim() !== "") {
            finalText = event.result;
          }
          // The session model comes from the init event, not from modelUsage:
          // a harness that quietly bills a helper model for a side task puts a
          // second entry in there, and picking one arbitrarily would mislabel
          // the sample. Keep the whole breakdown instead.
          usageByModel = Object.fromEntries(
            Object.entries(event.modelUsage ?? {}).map(([name, entry]) => [
              name,
              {
                inputTokens: entry.inputTokens ?? 0,
                outputTokens: entry.outputTokens ?? 0,
                costUSD: entry.costUSD ?? 0,
              },
            ]),
          );
          if (resolvedModel === undefined) {
            const dominant = Object.entries(usageByModel).sort(
              (left, right) => right[1].outputTokens - left[1].outputTokens,
            )[0];
            if (dominant) resolvedModel = dominant[0];
          }
        }
      },
    );

    return {
      driver: "claude",
      requestedModel: model ?? null,
      resolvedModel: resolvedModel ?? model ?? "claude-default",
      usageByModel,
      events,
      usage: claudeUsage(usage),
      finalText,
      exitCode,
      wallMs: Math.round(performance.now() - started),
      costUsd: typeof costUsd === "number" ? costUsd : null,
      permissionDenials,
      apiErrorStatus,
      stderr,
    };
  },
};

function claudeUsage(usage) {
  const iterations = Array.isArray(usage?.iterations) ? usage.iterations : [];
  const sum = (select) =>
    iterations.reduce((total, entry) => total + (select(entry) ?? 0), 0);
  // `iterations` is per API call, so it is the honest transcript total across a
  // multi-turn tool loop. The top-level counters describe the last call only.
  const requestTokens = iterations.length
    ? sum((entry) => entry.input_tokens) +
      sum((entry) => entry.cache_read_input_tokens) +
      sum((entry) => entry.cache_creation_input_tokens)
    : (usage?.input_tokens ?? 0) +
      (usage?.cache_read_input_tokens ?? 0) +
      (usage?.cache_creation_input_tokens ?? 0);
  const responseTokens = iterations.length
    ? sum((entry) => entry.output_tokens)
    : (usage?.output_tokens ?? 0);
  const cachedInputTokens = iterations.length
    ? sum((entry) => entry.cache_read_input_tokens)
    : (usage?.cache_read_input_tokens ?? 0);
  return {
    requestTokens,
    responseTokens,
    totalTokens: requestTokens + responseTokens,
    cachedInputTokens,
    modelCalls: iterations.length,
  };
}

// ---------------------------------------------------------------------------
// codex
// ---------------------------------------------------------------------------

const CODEX_DISABLED_FEATURES = [
  "apps",
  "plugins",
  "browser_use",
  "computer_use",
  "in_app_browser",
  "image_generation",
  "multi_agent",
  "goals",
  "tool_suggest",
  "skill_search",
];

const codexDriver = {
  name: "codex",
  version: () => commandVersion("codex", ["--version"]),
  async run({ prompt, systemPrompt, mcpUrl, token, model, timeoutMs, cwd }) {
    const args = [
      "exec",
      "--json",
      "--ephemeral",
      "--ignore-user-config",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "--cd",
      cwd,
      "--config",
      `mcp_servers.connecta.url="${mcpUrl}"`,
      "--config",
      'mcp_servers.connecta.bearer_token_env_var="CONNECTA_GATE_TOKEN"',
      "--config",
      'approval_policy="never"',
      ...CODEX_DISABLED_FEATURES.flatMap((feature) => ["--disable", feature]),
      ...(model ? ["--model", model] : []),
      // Codex has no system-prompt replacement flag, so the corpus prompt rides
      // in front of the ask. Recorded in the results either way.
      `${systemPrompt}\n\n${prompt}`,
    ];
    const started = performance.now();
    const events = [];
    const startedItems = new Map();
    let finalText = "";
    let usage = {};
    let turns = 0;
    const at = () => Math.round(performance.now() - started);

    const { exitCode, stderr } = await streamJsonProcess(
      "codex",
      args,
      {
        cwd,
        env: { ...process.env, CONNECTA_GATE_TOKEN: token },
        timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS,
      },
      (event) => {
        if (event.type === "item.started") {
          startedItems.set(event.item?.id, at());
          if (event.item?.type === "mcp_tool_call") {
            events.push({
              kind: "tool_call",
              atMs: at(),
              server: event.item.server ?? null,
              tool: event.item.tool,
              args: event.item.arguments ?? {},
            });
          }
          return;
        }
        if (event.type === "item.completed") {
          const item = event.item ?? {};
          const itemStarted = startedItems.get(item.id);
          if (item.type === "mcp_tool_call") {
            events.push({
              kind: "tool_result",
              atMs: at(),
              server: item.server ?? null,
              tool: item.tool,
              isError: item.status !== "completed" || item.error != null,
              durationMs: itemStarted === undefined ? null : at() - itemStarted,
              result: item.result ?? null,
            });
            return;
          }
          if (item.type === "agent_message") {
            finalText = item.text ?? "";
            events.push({ kind: "assistant_text", atMs: at(), text: finalText });
            return;
          }
          events.push({
            kind: "other_action",
            atMs: at(),
            type: item.type ?? "unknown",
          });
          return;
        }
        if (event.type === "turn.completed") {
          usage = event.usage ?? {};
          turns += 1;
        }
      },
    );

    const requestTokens = usage.input_tokens ?? 0;
    const responseTokens = usage.output_tokens ?? 0;
    return {
      driver: "codex",
      requestedModel: model ?? null,
      resolvedModel: model ?? "codex-default",
      usageByModel: {},
      events,
      usage: {
        requestTokens,
        responseTokens,
        totalTokens: requestTokens + responseTokens,
        cachedInputTokens: usage.cached_input_tokens ?? 0,
        modelCalls: turns,
      },
      finalText,
      exitCode,
      wallMs: Math.round(performance.now() - started),
      costUsd: null,
      permissionDenials: 0,
      apiErrorStatus: null,
      stderr,
    };
  },
};

export const DRIVERS = { claude: claudeDriver, codex: codexDriver };

export function driverFor(name) {
  const driver = DRIVERS[name];
  if (!driver) {
    throw new Error(
      `Unknown driver "${name}". Choose ${Object.keys(DRIVERS).join(" or ")}.`,
    );
  }
  return driver;
}

/**
 * "driver:model" — the unit results are separated by, because a model id alone
 * does not identify the harness that shaped the transcript.
 */
export function parseModelSpec(spec) {
  const separator = spec.indexOf(":");
  if (separator <= 0 || separator === spec.length - 1) {
    throw new Error(
      `Model spec "${spec}" must be "driver:model", e.g. "claude:opus" or "codex:gpt-5".`,
    );
  }
  const driver = spec.slice(0, separator);
  const model = spec.slice(separator + 1);
  driverFor(driver);
  return { driver, model, spec };
}
