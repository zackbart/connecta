// Node-only: spawns a fake Claude CLI to verify eval isolation, stream protocol and cancellation.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runClaude } from "../eval/agent/claude.js";
import { parseTrace } from "../eval/agent/trace.js";
import { infraError } from "../eval/agent/infra.js";

const CLI = String.raw`
const fs = require('node:fs');
const readline = require('node:readline');
const mode = process.argv[2], argv = process.argv.slice(3);
const value = flag => argv[argv.indexOf(flag) + 1];
const send = event => process.stdout.write(JSON.stringify(event) + '\n');
const model = value('--model');
const tools = ['authorize_connector','call_destructive_tool','call_tool','execute_code','search_tools','skills'].map(t => 'mcp__connecta__' + t);
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
  claude_code_version:'fake-claude',plugins:mode === 'extra-plugin' ? [{name:'unexpected',source:'cc-plugin-future@builtin',settings:{token:'fake-secret'}}] : mode === 'named-plugin' ? [{name:'unexpected'}] : [],skills:mode === 'extra-skill' ? ['future-skill'] : [],tools:mode === 'extra-tool' ? [...tools,'Bash'] : tools});
let turn = 0;
readline.createInterface({input:process.stdin}).on('line', line => {
  const input = JSON.parse(line); turn++;
  if (mode === 'hang') return;
  send({type:'assistant',message:{content:[{type:'tool_use',id:'tool-' + turn,name:'mcp__connecta__call_tool',input:{address:'ci.get_run',args:{runId:4812}}}]}});
  send({type:'user',message:{content:[{type:'tool_result',tool_use_id:'tool-' + turn,content:[{type:'text',text:'{"status":"failed"}'},{type:'image',mimeType:'image/png',data:'ZmFrZQ=='}]}]}});
  send({type:'assistant',message:{content:[{type:'text',text:input.message.content + ' CI run 4812 failed, commit 9f2c1ab.'}]}});
  send({type:'result',subtype:'success',total_cost_usd:turn * .01,num_turns:1,modelUsage:{[model]:{inputTokens:turn*100,outputTokens:turn*20}}});
});
`;

async function fixture(mode = "complete", options: { signal?: AbortSignal; timeoutMs?: number; followUp?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "connecta-claude-test-"));
  try {
    const script = join(dir, "claude.cjs");
    await writeFile(script, CLI);
    return await runClaude({ model: "claude-sonnet-5-5", mcpUrl: "http://127.0.0.1:1/mcp", token: "fake-secret",
      allowedTools: ["authorize_connector", "call_destructive_tool", "call_tool", "execute_code", "search_tools", "skills"], deniedTools: [],
      timeoutMs: options.timeoutMs ?? 10_000, ...(options.signal ? { signal: options.signal } : {}),
      firstPrompt: "First", nextTurn: async n => options.followUp && n === 1 ? "Second" : undefined,
      maxBudgetUsd: 0.1, testHost: { executable: process.execPath, args: [script, mode, "--expected-home", process.env.HOME!] } });
  } finally { await rm(dir, { recursive: true, force: true }); }
}

describe("Claude eval CLI", () => {
  it("isolates config and tools and preserves multi-turn answers, images, cumulative cost and usage", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "fake-key-must-not-reach-child");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "fake-token-must-not-reach-child");
    vi.stubEnv("CLAUDE_CONFIG_DIR", "/fake-config-must-not-reach-child");
    vi.stubEnv("CLAUDE_CODE_SIMPLE", "1");
    vi.stubEnv("CLAUDECODE", "1");
    let run;
    try { run = await fixture("complete", { followUp: true }); }
    finally { vi.unstubAllEnvs(); }
    const trace = parseTrace(run.events, run.turnStarts, ["First", "Second"]);
    expect(run.timedOut).toBe(false);
    expect(run.turnStarts).toHaveLength(2);
    expect(trace.finalAnswer).toBe("Second CI run 4812 failed, commit 9f2c1ab.");
    expect(trace.toolUses).toHaveLength(2);
    expect(trace.toolUses[0]?.resultBlocks?.[1]).toMatchObject({ type: "image", mimeType: "image/png" });
    expect(trace.tokens.input).toBe(200);
    expect(trace.costUsd).toBe(.02);
    expect(trace.claudeCodeVersion).toBe("fake-claude");
    expect(run.argv).toContain("<mcp-config>");
    expect(infraError(run.events, run.exitCode, trace.loadedTools)).toBeUndefined();
  });

  it.each(["wrong-model", "extra-tool", "extra-plugin", "extra-skill"])("refuses %s before accepting a trial", async mode => {
    const run = await fixture(mode);
    expect(parseTrace(run.events, run.turnStarts, []).claudeCodeVersion).toBe("fake-claude");
    expect(infraError(run.events, run.exitCode, run.loadedTools)).toBeDefined();
    expect(run.events.some(event => event.type === "result" && event.subtype === "error")).toBe(true);
  });

  it.each([
    ["extra-plugin", '"plugins":["cc-plugin-future@builtin"]'],
    ["named-plugin", '"plugins":["unexpected"]'],
    ["extra-skill", '"skills":["future-skill"]'],
  ])("names the offending inventory for %s without plugin settings", async (mode, inventory) => {
    const run = await fixture(mode);
    const error = run.events.find(event => event.type === "result" && event.subtype === "error");
    expect(error?.result).toContain("Claude loaded plugins or skills outside the fake MCP config:");
    expect(error?.result).toContain(inventory);
    expect(error?.result).not.toContain("fake-secret");
    expect(error?.result).not.toContain("settings");
  });

  it("terminates a hung CLI on the wall deadline", async () => {
    const run = await fixture("hang", { timeoutMs: 200 });
    expect(run.timedOut).toBe(true);
    expect(run.wallMs).toBeLessThan(5_000);
  });

  it("terminates an active trial when interrupted", async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 200);
    try { expect((await fixture("hang", { signal: controller.signal })).aborted).toBe(true); }
    finally { clearTimeout(timer); }
  });
});
