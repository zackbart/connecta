// Node-only: spawns a fake Claude CLI to verify eval isolation, stream protocol and cancellation.
import * as childProcess from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CODE_TOOLS, type Surface } from "../eval/agent/surface.js";
import { runClaude } from "../eval/agent/claude.js";
import * as claude from "../eval/agent/claude.js";
import { runBatch } from "../eval/agent/run.js";
import { regradeTrial } from "../eval/agent/regrade.js";
import { ACTIVE_TASKS } from "../eval/tasks/index.js";
import type { ActiveTask } from "../eval/tasks/types.js";
import { parseTrace } from "../eval/agent/trace.js";
import { infraError } from "../eval/agent/infra.js";
import type { CodexOptions } from "../eval/agent/codex.js";

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, spawn: vi.fn(original.spawn) };
});

const CLI = String.raw`
const fs = require('node:fs');
const readline = require('node:readline');
const mode = process.argv[2], argv = process.argv.slice(3);
const value = flag => argv[argv.indexOf(flag) + 1];
const send = event => process.stdout.write(JSON.stringify(event) + '\n');
const model = value('--model');
const isCode = mode === 'code' || mode.endsWith('-code');
const tools = (isCode ? ['authorize_connector','execute_code','skills'] : ['authorize_connector','call_destructive_tool','call_tool','execute_code','search_tools','skills']).map(t => 'mcp__connecta__' + t);
const config = JSON.parse(fs.readFileSync(value('--mcp-config'), 'utf8'));
const settings = JSON.parse(value('--settings'));
const builtins = ['cc-plugin-agents-md@builtin','cc-plugin-telemetry@builtin','cc-plugin-plugin-authoring@builtin'];
if (Object.keys(config.mcpServers).join(',') !== 'connecta' || value('--tools') !== '' ||
    value('--setting-sources') !== '' || !argv.includes('--strict-mcp-config') ||
    !argv.includes('--no-session-persistence') || value('--permission-mode') !== 'dontAsk' ||
    value('--permission-prompts') !== 'none' || fs.realpathSync(process.cwd()).startsWith(fs.realpathSync(process.env.HOME)) ||
    argv.includes('--safe-mode') || !argv.includes('--disable-slash-commands') || !argv.includes('--no-chrome') ||
    JSON.parse(value('--settings')).disableAllHooks !== true ||
    JSON.parse(value('--settings')).autoMemoryEnabled !== false ||
    Object.keys(settings.enabledPlugins).length !== builtins.length || builtins.some(source => settings.enabledPlugins[source] !== false) ||
    process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS !== '1' || process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY !== '1' ||
    process.env.CLAUDE_CODE_DISABLE_BUNDLED_SKILLS !== '1' || process.env.ENABLE_CLAUDEAI_MCP_SERVERS !== 'false' ||
    process.env.HOME !== value('--expected-home') || process.env.CLAUDE_CONFIG_DIR || process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN ||
    process.env.OPENAI_API_KEY || process.env.CLAUDECODE || process.env.CLAUDE_CODE_SIMPLE) {
  send({type:'result',subtype:'error',result:'isolation failed'}); process.exit(1);
}
send({type:'system',subtype:'init',model:mode === 'wrong-model' ? 'wrong-model' : model,
  claude_code_version:'fake-claude',plugins:mode === 'extra-plugin' ? [{name:'unexpected',source:'cc-plugin-future@builtin',settings:{token:'fake-secret'}}] : mode === 'named-plugin' ? [{name:'unexpected'}] : [],skills:mode === 'extra-skill' ? ['future-skill'] : [],tools:mode === 'extra-tool' ? [...tools,'Bash'] : mode === 'duplicate-tool' ? [...tools,tools[0]] : tools});
let turn = 0;
// Closing stdin must not let the CLI exit before the harness signal arrives.
setInterval(() => {}, 1_000);
if (mode === 'self-terminate' || mode === 'cleanup-143') process.on('SIGTERM', () => process.exit(143));
if (mode === 'cleanup-1') process.on('SIGTERM', () => process.exit(1));
if (mode === 'cleanup-sigint') process.on('SIGTERM', () => process.kill(process.pid, 'SIGINT'));
readline.createInterface({input:process.stdin}).on('line', line => {
  const input = JSON.parse(line); turn++;
  if (mode === 'hang') return;
  send({type:'assistant',message:{content:[{type:'tool_use',id:'tool-' + turn,name:isCode ? 'mcp__connecta__execute_code' : 'mcp__connecta__call_tool',input:isCode ? {code:'async () => (await connecta.call(\"ci.get_run\", {runId:4812})).data'} : {address:'ci.get_run',args:{runId:4812}}}]}});
  send({type:'user',message:{content:[{type:'tool_result',tool_use_id:'tool-' + turn,content:[{type:'text',text:'{"status":"failed"}'},{type:'image',mimeType:'image/png',data:'ZmFrZQ=='}]}]}});
  send({type:'assistant',message:{content:[{type:'text',text:input.message.content + ' CI run 4812 failed, commit 9f2c1ab.'}]}});
  if (mode.startsWith('missing-final-result') && turn === 2) { process.exit(0); return; }
  send({type:'result',subtype:'success',total_cost_usd:turn * .01,num_turns:1,modelUsage:{[model]:{inputTokens:turn*100,outputTokens:turn*20}}});
  if (mode === 'self-terminate') process.kill(process.pid, 'SIGTERM');
});
`;

async function fixture(
  mode = "complete",
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    followUp?: boolean;
    model?: string;
    surface?: Surface;
    nextTurn?: CodexOptions["nextTurn"];
  } = {},
  invoke = runClaude,
) {
  const dir = await mkdtemp(join(tmpdir(), "connecta-claude-test-"));
  try {
    const script = join(dir, "claude.cjs");
    await writeFile(script, CLI);
    return await invoke({
      model: options.model ?? "claude-sonnet-5-5",
      ...(options.surface ? { surface: options.surface } : {}),
      mcpUrl: "http://127.0.0.1:1/mcp",
      token: "fake-secret",
      allowedTools:
        options.surface === "code"
          ? [...CODE_TOOLS]
          : ["authorize_connector", "call_destructive_tool", "call_tool", "execute_code", "search_tools", "skills"],
      deniedTools: [],
      timeoutMs: options.timeoutMs ?? 10_000,
      ...(options.signal ? { signal: options.signal } : {}),
      firstPrompt: "First",
      nextTurn: options.nextTurn ?? (async (n) => (options.followUp && n === 1 ? "Second" : undefined)),
      maxBudgetUsd: 0.1,
      testHost: { executable: process.execPath, args: [script, mode, "--expected-home", process.env.HOME!] },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("Claude eval CLI", () => {
  it.each([
    ["six", "route"],
    ["six", "outcome"],
    ["code", "route"],
    ["code", "outcome"],
  ] as const)("fails live and saved grading when the last turn has no completion (%s/%s)", async (surface, grading) => {
    const original = runClaude;
    const spy = vi
      .spyOn(claude, "runClaude")
      .mockImplementation(() =>
        fixture(
          surface === "code" ? "missing-final-result-code" : "missing-final-result",
          { followUp: true, surface },
          original,
        ),
      );
    const task: ActiveTask = {
      ...ACTIVE_TASKS.find((t) => t.id === "p5-known-read-routing")!,
      followUps: [{ prompt: "Second" }],
      // Isolate the outer completion verdict with a successful body grade.
      grade: ({ trace }) => [
        { id: "correct-destination", description: "fixture destination", pass: true },
        {
          id: "answer-evidence",
          description: "fixture answer",
          pass: /4812 failed, commit 9f2c1ab/.test(trace.finalAnswer ?? ""),
        },
      ],
    };
    try {
      const { trials } = await runBatch([task], ["claude-sonnet-5-5"], 1, {
        runner: "claude",
        surface,
        grading,
        timeoutMs: 10_000,
        concurrency: 1,
      });
      const trial = trials[0]!;
      expect(trial.error).toBeUndefined();
      expect(trial.claude?.terminatedAfterCompletion).toBe(false);
      expect(trial.metrics.conversationTurns).toBe(2);
      expect(trial.saved?.trace.resultSubtypes).toEqual(["success"]);
      expect(trial.checks.filter((c) => c.id !== "conversation-completed").every((c) => c.pass)).toBe(true);
      expect(trial.status).toBe("fail");
      expect(trial.checks.find((c) => c.id === "conversation-completed")?.pass).toBe(false);
      const saved = regradeTrial(task, trial, "claude", grading, surface);
      expect(saved.status).toBe("fail");
      expect(saved.regrade?.unavailable).toContain("conversation-completed");
    } finally {
      spy.mockRestore();
    }
  });

  it.each(["six", "code"] as const)(
    "accepts Haiku 5.5 with the %s inventory and verifies the served model",
    async (surface) => {
      const run = await fixture(surface === "code" ? "code" : "complete", { model: "claude-haiku-5-5", surface });
      expect(run.model).toBe("claude-haiku-5-5");
      expect(run.loadedTools).toHaveLength(surface === "code" ? 3 : 6);
      expect(infraError(run.events, run.exitCode, run.loadedTools)).toBeUndefined();
      const rejected = await fixture("wrong-model", { model: "claude-haiku-5-5" });
      expect(infraError(rejected.events, rejected.exitCode, rejected.loadedTools)).toContain(
        "instead of claude-haiku-5-5",
      );
    },
  );

  it("isolates config and tools and preserves multi-turn answers, images, cumulative cost and usage", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "fake-key-must-not-reach-child");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "fake-token-must-not-reach-child");
    vi.stubEnv("CLAUDE_CONFIG_DIR", "/fake-config-must-not-reach-child");
    vi.stubEnv("CLAUDE_CODE_SIMPLE", "1");
    vi.stubEnv("CLAUDECODE", "1");
    let run;
    try {
      run = await fixture("complete", { followUp: true });
    } finally {
      vi.unstubAllEnvs();
    }
    const trace = parseTrace(run.events, run.turnStarts, ["First", "Second"]);
    expect(run.timedOut).toBe(false);
    expect(run.exitCode).toBeNull();
    expect(run.terminatedAfterCompletion).toBe(true);
    expect(run.turnStarts).toHaveLength(2);
    expect(trace.finalAnswer).toBe("Second CI run 4812 failed, commit 9f2c1ab.");
    expect(trace.toolUses).toHaveLength(2);
    expect(trace.toolUses[0]?.resultBlocks?.[1]).toMatchObject({ type: "image", mimeType: "image/png" });
    expect(trace.tokens.input).toBe(200);
    expect(trace.costUsd).toBe(0.02);
    expect(trace.claudeCodeVersion).toBe("fake-claude");
    expect(run.argv).toContain("<mcp-config>");
    expect(infraError(run.events, run.exitCode, trace.loadedTools)).toBeUndefined();
  });

  it.each(["wrong-model", "extra-tool", "duplicate-tool", "extra-plugin", "extra-skill"])(
    "refuses %s before accepting a trial",
    async (mode) => {
      const run = await fixture(mode);
      expect(parseTrace(run.events, run.turnStarts, []).claudeCodeVersion).toBe("fake-claude");
      expect(infraError(run.events, run.exitCode, run.loadedTools)).toBeDefined();
      expect(run.events.some((event) => event.type === "result" && event.subtype === "error")).toBe(true);
    },
  );

  it.each([
    ["extra-plugin", '"plugins":["cc-plugin-future@builtin"]'],
    ["named-plugin", '"plugins":["unexpected"]'],
    ["extra-skill", '"skills":["future-skill"]'],
  ])("names the offending inventory for %s without plugin settings", async (mode, inventory) => {
    const run = await fixture(mode);
    const error = run.events.find((event) => event.type === "result" && event.subtype === "error");
    expect(error?.result).toContain("Claude loaded plugins or skills outside the fake MCP config:");
    expect(error?.result).toContain(inventory);
    expect(error?.result).not.toContain("fake-secret");
    expect(error?.result).not.toContain("settings");
  });

  it("completes a successful trial when the CLI traps harness SIGTERM and exits 143", async () => {
    const original = runClaude;
    const spy = vi.spyOn(claude, "runClaude").mockImplementation(() => fixture("cleanup-143", {}, original));
    const task: ActiveTask = {
      ...ACTIVE_TASKS.find((t) => t.id === "p5-known-read-routing")!,
      grade: () => [{ id: "answer-evidence", description: "fixture answer", pass: true }],
    };
    try {
      const { trials } = await runBatch([task], ["claude-sonnet-5-5"], 1, {
        runner: "claude",
        timeoutMs: 10_000,
        concurrency: 1,
      });
      const trial = trials[0]!;
      expect(trial.status).toBe("pass");
      expect(trial.error).toBeUndefined();
      expect(trial.claude).toMatchObject({
        exitCode: 143,
        terminatedAfterCompletion: true,
        resultSubtypes: ["success"],
        timedOut: false,
        aborted: false,
      });
      expect(trial.checks.find((c) => c.id === "conversation-completed")?.pass).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("does not attribute a self-termination processed before cleanup to the harness", async () => {
    const spawn = vi.mocked(childProcess.spawn).getMockImplementation()!;
    let resolveExit!: () => void;
    const exited = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    const spy = vi.spyOn(childProcess, "spawn").mockImplementation((...args) => {
      const child = spawn(...args);
      child.once("exit", resolveExit);
      return child;
    });
    try {
      const run = await fixture("self-terminate", {
        nextTurn: async () => {
          // Wait for Node to process the independent exit before cleanup checks it.
          await exited;
          return undefined;
        },
      });
      expect(run.events.at(-1)?.subtype).toBe("success");
      expect(run.exitCode).toBe(143);
      expect(run.timedOut).toBe(false);
      expect(run.aborted).toBe(false);
      expect(run.terminatedAfterCompletion).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it.each([
    ["cleanup-1", 1],
    ["cleanup-sigint", null],
  ] as const)("rejects an unexpected exit after harness SIGTERM (%s)", async (mode, exitCode) => {
    const run = await fixture(mode);
    expect(run.events.at(-1)?.subtype).toBe("success");
    expect(run.exitCode).toBe(exitCode);
    expect(run.timedOut).toBe(false);
    expect(run.aborted).toBe(false);
    expect(run.terminatedAfterCompletion).toBe(false);
  });

  it("terminates a hung CLI on the wall deadline", async () => {
    const run = await fixture("hang", { timeoutMs: 200 });
    expect(run.timedOut).toBe(true);
    expect(run.terminatedAfterCompletion).toBe(false);
    expect(run.wallMs).toBeLessThan(5_000);
  });

  it("terminates an active trial when interrupted", async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 200);
    try {
      const run = await fixture("hang", { signal: controller.signal });
      expect(run.aborted).toBe(true);
      expect(run.terminatedAfterCompletion).toBe(false);
    } finally {
      clearTimeout(timer);
    }
  });
});
