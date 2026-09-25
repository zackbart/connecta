/** One isolated Codex app-server conversation per fake-world trial. */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { StreamEvent } from "./trace.js";

export interface CodexRun {
  events: StreamEvent[];
  turnStarts: number[];
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  stderrTail: string;
  wallMs: number;
  argv: string[];
  model: string | undefined;
  loadedTools: string[];
}

export interface CodexOptions {
  model: string;
  mcpUrl: string;
  token: string;
  allowedTools: string[];
  deniedTools: string[];
  timeoutMs: number;
  signal?: AbortSignal;
  effort?: string;
  firstPrompt: string;
  nextTurn(turnIndex: number, events: StreamEvent[]): Promise<string | undefined>;
  onEvent?(event: StreamEvent): void;
  /** Dependency injection for the protocol self-test; never set by eval/run-agent. */
  testHost?: { executable: string; args: string[]; authFile: string; version: string };
}

export async function codexVersion(): Promise<string> {
  return await new Promise(resolve => {
    const child = spawn("codex", ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    child.stdout.on("data", chunk => { output += String(chunk); });
    child.on("close", () => resolve(output.trim()));
    child.on("error", () => resolve("unavailable"));
  });
}

function mcpResultText(value: unknown): string {
  if (!value || typeof value !== "object") return JSON.stringify(value ?? "");
  const result = value as { content?: { type?: string; text?: string }[] };
  return Array.isArray(result.content)
    ? result.content.map(block => block.type === "text" ? block.text ?? "" : JSON.stringify(block)).join("\n")
    : JSON.stringify(value);
}

/** Translate the documented app-server items into the existing trace format. */
function codexEvent(event: { method?: string; params?: Record<string, any> }): StreamEvent[] {
  const item = event.params?.item;
  if (event.method === "item/started" && item?.type === "mcpToolCall") {
    return [{ type: "assistant", message: { content: [{
      type: "tool_use", id: item.id, name: `mcp__${item.server}__${item.tool}`,
      input: item.arguments ?? {},
    }] } }];
  }
  if (event.method === "item/completed" && item?.type === "mcpToolCall") {
    return [{ type: "user", message: { content: [{
      type: "tool_result", tool_use_id: item.id,
      is_error: item.status !== "completed" || Boolean(item.error) || item.result?.isError === true,
      content: [{ type: "text", text: item.error ? JSON.stringify(item.error) : mcpResultText(item.result) }],
    }] } }];
  }
  if (event.method === "item/completed" && item?.type === "agentMessage" && item.text) {
    return [{ type: "assistant", message: { content: [{ type: "text", text: item.text }] } }];
  }
  if (event.method === "turn/completed") {
    const turn = event.params?.turn;
    return [{ type: "result", subtype: turn?.status === "completed" ? "success" : String(turn?.status ?? "error"),
      result: turn?.error?.message ?? "" }];
  }
  return [];
}

export async function runCodex(options: CodexOptions): Promise<CodexRun> {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("Codex timeout must be a finite positive number");
  }
  if (options.signal?.aborted) throw new Error("Codex trial aborted");
  const root = await mkdtemp(join(tmpdir(), "connecta-eval-codex-"));
  const codexHome = join(root, "codex-home");
  const cwd = join(root, "empty-workspace");
  try {
    await mkdir(codexHome);
    await mkdir(cwd);
    const auth = options.testHost?.authFile ?? join(homedir(), ".codex", "auth.json");
    if (!existsSync(auth)) throw new Error("Codex CLI is not signed in; ~/.codex/auth.json is missing");
    await symlink(auth, join(codexHome, "auth.json"));
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  // This home has no user MCP servers, plugins, skills, memories, or project
  // instructions. The model cannot execute shell commands or browse the web.
  // Only the fresh trial's loopback MCP endpoint is configured.
  const config = [
    `model = ${JSON.stringify(options.model)}`,
    'approval_policy = "on-request"',
    'sandbox_mode = "read-only"',
    'web_search = "disabled"',
    '[features]',
    'apps = false',
    'multi_agent = false',
    'goals = false',
    'hooks = false',
    'remote_plugin = false',
    'shell_tool = false',
    'unified_exec = false',
    '[apps._default]',
    'enabled = false',
    '[mcp_servers.connecta]',
    `url = ${JSON.stringify(options.mcpUrl)}`,
    'required = true',
    `enabled_tools = ${JSON.stringify([...new Set([...options.allowedTools, ...options.deniedTools])])}`,
    'default_tools_approval_mode = "approve"',
    `http_headers = { Authorization = ${JSON.stringify(`Bearer ${options.token}`)} }`,
    ...options.deniedTools.flatMap(tool => [
      `[mcp_servers.connecta.tools.${JSON.stringify(tool)}]`,
      'approval_mode = "prompt"',
    ]),
    "",
  ].join("\n");
  try {
    await writeFile(join(codexHome, "config.toml"), config, { mode: 0o600 });
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }

  const argv = options.testHost?.args ?? ["app-server", "--stdio"];
  const started = performance.now();
  const child = spawn(options.testHost?.executable ?? "codex", argv, {
    cwd, stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: process.env.PATH, HOME: root, CODEX_HOME: codexHome, TZ: "UTC" },
  });
  const events: StreamEvent[] = [];
  const turnStarts: number[] = [];
  let stderrTail = "";
  let timedOut = false;
  let model: string | undefined;
  let loadedTools: string[] = [];
  let nextId = 1;
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  const toolByItem = new Map<string, string>();
  let turnDone: ((value: Record<string, unknown>) => void) | undefined;
  let stopWaiting: (() => void) | undefined;
  const stopped = new Promise<undefined>(resolve => { stopWaiting = () => resolve(undefined); });
  const send = (value: unknown) => child.stdin.write(`${JSON.stringify(value)}\n`);
  const request = (method: string, params: unknown): Promise<any> => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    send({ id, method, params });
  });
  const push = (event: StreamEvent) => { events.push(event); options.onEvent?.(event); };
  const lines = createInterface({ input: child.stdout });
  lines.on("line", line => {
    let message: Record<string, any>;
    try { message = JSON.parse(line) as Record<string, any>; } catch { return; }
    if (message.method === undefined && typeof message.id === "number" && pending.has(message.id)) {
      const waiter = pending.get(message.id)!;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(String(message.error.message ?? JSON.stringify(message.error))));
      else waiter.resolve(message.result);
      return;
    }
    if (message.method === "item/tool/requestUserInput" && message.id !== undefined) {
      const tool = toolByItem.get(String(message.params?.itemId));
      const deny = tool === undefined || options.deniedTools.includes(tool);
      const questions = message.params?.questions ?? [];
      const choices: (readonly [string, string | undefined])[] = questions.map((question: {
        id: string; options?: { label: string }[];
      }) => {
        const declined = question.options?.find(option => /decline|deny|reject|cancel/i.test(option.label));
        const accepted = question.options?.find(option => /accept|approve|allow/i.test(option.label));
        return [question.id, deny ? declined?.label : accepted?.label] as const;
      });
      if (deny) push({ type: "codex_denial", tool: tool ?? "unknown" });
      if (choices.some(([, answer]) => answer === undefined)) {
        send({ id: message.id, error: { code: -32000, message: "Eval host refused an unrecognized approval prompt" } });
      } else {
        const answers = Object.fromEntries(choices.map(([id, answer]) => [id, { answers: [answer] }]));
        send({ id: message.id, result: { answers } });
      }
      return;
    }
    if (message.method === "mcpServer/elicitation/request" && message.id !== undefined) {
      // Prompt-mode MCP tool approval arrives as an elicitation. Eval trials
      // never supply user content or approve a prompted call.
      send({ id: message.id, result: { action: "decline" } });
      push({ type: "codex_denial", tool: "mcpServer/elicitation/request" });
      return;
    }
    if (["item/commandExecution/requestApproval", "item/fileChange/requestApproval",
      "item/permissions/requestApproval"].includes(String(message.method)) && message.id !== undefined) {
      send({ id: message.id, error: { code: -32000, message: "Eval host refused approval" } });
      push({ type: "codex_denial", tool: String(message.method) });
      return;
    }
    if (message.method && message.id !== undefined) {
      send({ id: message.id, error: { code: -32000, message: "Eval host refuses this request" } });
      push({ type: "codex_denial", tool: message.method });
      return;
    }
    if (message.method === "item/started" && message.params?.item?.type === "mcpToolCall") {
      toolByItem.set(String(message.params.item.id), String(message.params.item.tool));
    }
    if (message.method === "item/started" &&
      ["commandExecution", "fileChange"].includes(String(message.params?.item?.type))) {
      push({ type: "result", subtype: "error", result: "Codex attempted a tool outside fake connecta" });
      child.kill("SIGTERM");
      return;
    }
    if (message.method === "thread/tokenUsage/updated") {
      const total = message.params?.tokenUsage?.total;
      if (total) push({ type: "codex_usage", total });
    }
    for (const event of codexEvent(message)) push(event);
    if (message.method === "turn/completed") {
      const done = turnDone;
      turnDone = undefined;
      done?.(message.params?.turn ?? {});
    }
  });
  child.stderr.on("data", chunk => { stderrTail = (stderrTail + String(chunk)).slice(-4_000); });
  const exited = new Promise<number | null>(resolve => {
    child.on("close", code => {
      stopWaiting?.();
      for (const waiter of pending.values()) waiter.reject(new Error("Codex app-server exited"));
      pending.clear();
      const done = turnDone;
      turnDone = undefined;
      if (done) push({ type: "result", subtype: "error", result: "Codex app-server exited during a turn" });
      done?.({ status: "failed", error: { message: "Codex app-server exited" } });
      resolve(code);
    });
    child.on("error", error => {
      stopWaiting?.();
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear();
      const done = turnDone;
      turnDone = undefined;
      if (done) push({ type: "result", subtype: "error", result: String(error) });
      done?.({ status: "failed", error: { message: String(error) } });
      resolve(-1);
    });
  });
  const timer = setTimeout(() => {
    timedOut = true;
    stopWaiting?.();
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
  }, options.timeoutMs);
  const onAbort = () => {
    stopWaiting?.();
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  try {
    await request("initialize", { clientInfo: { name: "connecta_eval", title: "Connecta eval", version: "1" },
      capabilities: { experimentalApi: true } });
    send({ method: "initialized" });
    const thread = await request("thread/start", {
      model: options.model, cwd, approvalPolicy: "on-request", sandbox: "read-only", ephemeral: true,
      baseInstructions: "Complete the user's task using only the connecta MCP tools. Do not use shell, files, web, or other services.",
      allowProviderModelFallback: false,
    });
    model = thread.model;
    if (model !== options.model) throw new Error(`Codex served ${String(model)} instead of ${options.model}`);
    const status = await request("mcpServerStatus/list", { threadId: thread.thread.id });
    const servers = status.data as { name: string; tools: Record<string, unknown>; toolsError?: string }[];
    if (servers.length !== 1 || servers[0]?.name !== "connecta" || servers[0].toolsError) {
      throw new Error(`isolated Codex MCP inventory: ${JSON.stringify(servers.map(server => ({
        name: server.name, tools: Object.keys(server.tools ?? {}), toolsError: server.toolsError,
      })))}`);
    }
    loadedTools = Object.keys(servers[0].tools).map(tool => `mcp__connecta__${tool}`);
    if (!loadedTools.includes("mcp__connecta__execute_code")) {
      throw new Error("Codex did not load the fake connecta MCP tools");
    }
    push({ type: "system", subtype: "init", model,
      agent_version: options.testHost?.version ?? await codexVersion(), tools: loadedTools });
    let prompt: string | undefined = options.firstPrompt;
    let turn = 0;
    while (prompt !== undefined && !timedOut && !options.signal?.aborted) {
      turnStarts.push(events.length);
      const completed = new Promise<Record<string, unknown>>(resolve => { turnDone = resolve; });
      await request("turn/start", { threadId: thread.thread.id, input: [{ type: "text", text: prompt }],
        model: options.model, ...(options.effort ? { effort: options.effort } : {}) });
      const result = await completed;
      turnDone = undefined;
      turn += 1;
      if (result.status !== "completed") break;
      prompt = await Promise.race([options.nextTurn(turn, events), stopped]);
    }
  } catch (error) {
    push({ type: "result", subtype: "error", result: String(error), num_turns: 0 });
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    child.stdin.end();
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }
    clearTimeout(timer);
  }
  const exitCode = await exited;
  await rm(root, { recursive: true, force: true });
  return { events, turnStarts, exitCode, timedOut, aborted: options.signal?.aborted ?? false,
    stderrTail: stderrTail.replaceAll(options.token, "<redacted>"),
    wallMs: Math.round(performance.now() - started), argv, model, loadedTools };
}
