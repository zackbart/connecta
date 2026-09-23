/**
 * Turn Claude Code's stream-json events into a bounded transcript and the
 * per-trial numbers the report compares. Nothing here reads the answer the
 * agent wrote; graders look at the fakes instead.
 */
import type { CallRecord, RequestRecord } from "../fakes/service.js";
import { SERVER_NAME, type StreamEvent } from "./claude.js";

const TOOL_PREFIX = `mcp__${SERVER_NAME}__`;
const MAX_RESULT_CHARS = 6_000;
const MAX_INPUT_CHARS = 12_000;
const MAX_TEXT_CHARS = 4_000;

export type TranscriptEntry =
  | { kind: "user"; turn: number; text: string }
  | { kind: "assistant"; turn: number; text: string }
  | { kind: "tool_use"; turn: number; id: string; tool: string; input: unknown; inputChars: number }
  | { kind: "tool_result"; turn: number; id: string; isError: boolean; text: string; chars: number }
  | { kind: "operator"; turn: number; text: string }
  | { kind: "turn_end"; turn: number; subtype: string; isError: boolean; numTurns: number; durationMs: number };

export interface ToolUse {
  id: string;
  turn: number;
  tool: string;
  input: Record<string, unknown>;
  isError: boolean | undefined;
  resultText: string | undefined;
}

export interface Tokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

export interface AgentTrace {
  transcript: TranscriptEntry[];
  toolUses: ToolUse[];
  tokens: Tokens;
  costUsd: number | undefined;
  apiMs: number;
  modelTurns: number;
  permissionDenials: unknown[];
  resultSubtypes: string[];
  model: string | undefined;
  claudeCodeVersion: string | undefined;
  loadedTools: string[];
  rateLimit: Record<string, unknown> | undefined;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… [${text.length - max} more chars]` : text;
}

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content ?? "");
  return content
    .map((block) =>
      typeof block === "object" && block !== null && "text" in block
        ? String((block as { text: unknown }).text)
        : JSON.stringify(block),
    )
    .join("\n");
}

export function parseTrace(events: StreamEvent[], turnStarts: number[], prompts: string[]): AgentTrace {
  const transcript: TranscriptEntry[] = [];
  const toolUses = new Map<string, ToolUse>();
  let turn = 0;
  let costUsd: number | undefined;
  let apiMs = 0;
  let modelTurns = 0;
  let tokens: Tokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  const permissionDenials: unknown[] = [];
  const resultSubtypes: string[] = [];
  let model: string | undefined;
  let version: string | undefined;
  let loadedTools: string[] = [];
  let rateLimit: Record<string, unknown> | undefined;
  events.forEach((event, index) => {
    const startedTurn = turnStarts.indexOf(index);
    if (startedTurn >= 0) {
      turn = startedTurn + 1;
      transcript.push({ kind: "user", turn, text: clip(prompts[startedTurn] ?? "", MAX_TEXT_CHARS) });
    }
    if (event.type === "system" && event.subtype === "init") {
      model = String(event.model ?? "");
      version = String(event.claude_code_version ?? "");
      loadedTools = Array.isArray(event.tools) ? event.tools.map(String) : [];
      return;
    }
    if (event.type === "rate_limit_event") {
      rateLimit = event.rate_limit_info as Record<string, unknown>;
      return;
    }
    if (event.type === "assistant" || event.type === "user") {
      const message = event.message as { content?: unknown } | undefined;
      const blocks = Array.isArray(message?.content) ? message.content : [];
      for (const raw of blocks) {
        const block = raw as Record<string, unknown>;
        if (block.type === "text" && event.type === "assistant") {
          const text = String(block.text ?? "");
          if (text.trim()) transcript.push({ kind: "assistant", turn, text: clip(text, MAX_TEXT_CHARS) });
        } else if (block.type === "tool_use") {
          const name = String(block.name ?? "");
          const input = (block.input ?? {}) as Record<string, unknown>;
          const serialized = JSON.stringify(input);
          const tool = name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : name;
          toolUses.set(String(block.id), {
            id: String(block.id),
            turn,
            tool,
            input,
            isError: undefined,
            resultText: undefined,
          });
          transcript.push({
            kind: "tool_use",
            turn,
            id: String(block.id),
            tool,
            input: serialized.length > MAX_INPUT_CHARS ? clip(serialized, MAX_INPUT_CHARS) : input,
            inputChars: serialized.length,
          });
        } else if (block.type === "tool_result") {
          const text = blockText(block.content);
          const use = toolUses.get(String(block.tool_use_id));
          const isError = block.is_error === true;
          if (use) {
            use.isError = isError;
            use.resultText = text;
          }
          transcript.push({
            kind: "tool_result",
            turn,
            id: String(block.tool_use_id),
            isError,
            text: clip(text, MAX_RESULT_CHARS),
            chars: text.length,
          });
        }
      }
      return;
    }
    if (event.type === "result") {
      costUsd = typeof event.total_cost_usd === "number" ? event.total_cost_usd : costUsd;
      apiMs += typeof event.duration_api_ms === "number" ? event.duration_api_ms : 0;
      modelTurns += typeof event.num_turns === "number" ? event.num_turns : 0;
      resultSubtypes.push(String(event.subtype));
      if (Array.isArray(event.permission_denials)) permissionDenials.push(...event.permission_denials);
      // modelUsage is cumulative across the conversation; the last one wins.
      const usage = event.modelUsage as Record<string, Record<string, number>> | undefined;
      if (usage) {
        tokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
        for (const entry of Object.values(usage)) {
          tokens.input += entry.inputTokens ?? 0;
          tokens.output += entry.outputTokens ?? 0;
          tokens.cacheRead += entry.cacheReadInputTokens ?? 0;
          tokens.cacheCreation += entry.cacheCreationInputTokens ?? 0;
        }
      }
      transcript.push({
        kind: "turn_end",
        turn,
        subtype: String(event.subtype),
        isError: event.is_error === true,
        numTurns: Number(event.num_turns ?? 0),
        durationMs: Number(event.duration_ms ?? 0),
      });
    }
  });
  return {
    transcript,
    toolUses: [...toolUses.values()],
    tokens,
    costUsd,
    apiMs,
    modelTurns,
    permissionDenials,
    resultSubtypes,
    model,
    claudeCodeVersion: version,
    loadedTools,
    rateLimit,
  };
}

export interface DownstreamMetrics {
  reads: number;
  writes: number;
  duplicateReads: number;
  duplicateWrites: number;
  errors: number;
  unauthorizedRequests: number;
  byTool: Record<string, number>;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function downstreamMetrics(calls: CallRecord[], requests: RequestRecord[]): DownstreamMetrics {
  const seen = new Set<string>();
  const metrics: DownstreamMetrics = {
    reads: 0,
    writes: 0,
    duplicateReads: 0,
    duplicateWrites: 0,
    errors: 0,
    unauthorizedRequests: requests.filter((request) => !request.authorized).length,
    byTool: {},
  };
  for (const call of calls) {
    const address = `${call.service}.${call.tool}`;
    metrics.byTool[address] = (metrics.byTool[address] ?? 0) + 1;
    if (call.kind === "read") metrics.reads += 1;
    else metrics.writes += 1;
    if (call.outcome !== "ok") metrics.errors += 1;
    const key = `${address}:${stable(call.args)}`;
    if (seen.has(key)) {
      if (call.kind === "read") metrics.duplicateReads += 1;
      else metrics.duplicateWrites += 1;
    }
    seen.add(key);
  }
  return metrics;
}

export function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) counts[key(item)] = (counts[key(item)] ?? 0) + 1;
  return counts;
}
