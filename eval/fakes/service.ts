/**
 * Deterministic, stateful fake downstream MCP servers.
 *
 * Each fake is a real streamable-HTTP MCP endpoint on loopback, built with the
 * MCP SDK rather than with anything from connecta, so the harness keeps working
 * however connecta's internals change. Every `tools/call` lands in a shared
 * ledger in arrival order; graders read that ledger and the services' own state,
 * never the agent's prose.
 */
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import type { z } from "zod";
import { serveFetch, type Served } from "../support/serve.js";

interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

type FakeResult =
  | { json: unknown }
  | { text: string }
  | { error: string };

export interface FakeTool {
  name: string;
  description: string;
  input: z.ZodObject;
  annotations: ToolAnnotations;
  run(args: Record<string, unknown>): FakeResult | Promise<FakeResult>;
}

/**
 * A scripted failure for one future call. `error-before` refuses without
 * touching state; `error-after` commits and then reports failure — the
 * unknown-outcome write P3 needs; `delay` holds the response.
 */
export interface Fault {
  tool: string;
  /** 1-based index among this tool's calls; omitted means the next call. */
  nth?: number;
  kind: "error-before" | "error-after" | "delay";
  delayMs?: number;
  message?: string;
}

export interface CallRecord {
  seq: number;
  at: number;
  service: string;
  tool: string;
  args: Record<string, unknown>;
  kind: "read" | "write";
  outcome: "ok" | "tool_error" | "fault";
  fault?: Fault["kind"];
  error?: string;
  resultBytes: number;
}

export interface RequestRecord {
  seq: number;
  at: number;
  service: string;
  methods: string[];
  authorized: boolean;
}

/** One ordering across every fake in a world. */
export class Ledger {
  seq = 0;
  readonly calls: CallRecord[] = [];
  readonly requests: RequestRecord[] = [];
  next(): number {
    this.seq += 1;
    return this.seq;
  }
}

function isWrite(annotations: ToolAnnotations): boolean {
  return annotations.readOnlyHint !== true;
}

function toMcpResult(result: FakeResult) {
  if ("error" in result) {
    return {
      content: [{ type: "text" as const, text: result.error }],
      isError: true,
    };
  }
  if ("text" in result) {
    return { content: [{ type: "text" as const, text: result.text }] };
  }
  const value = result.json;
  const structured =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : { items: value };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: structured,
  };
}

function resultBytes(result: FakeResult): number {
  if ("error" in result) return Buffer.byteLength(result.error);
  if ("text" in result) return Buffer.byteLength(result.text);
  return Buffer.byteLength(JSON.stringify(result.json));
}

export class FakeService {
  readonly faults: Fault[] = [];
  private served: Served | undefined;
  private readonly perTool = new Map<string, number>();

  constructor(
    readonly name: string,
    readonly description: string,
    private readonly tools: FakeTool[],
    private readonly ledger: Ledger,
    private readonly auth: { bearer?: () => string | undefined } = {},
  ) {}

  get url(): string {
    if (!this.served) throw new Error(`fake ${this.name} is not started`);
    return `${this.served.url}/mcp`;
  }

  get calls(): CallRecord[] {
    return this.ledger.calls.filter((call) => call.service === this.name);
  }

  toolNames(): string[] {
    return this.tools.map((tool) => tool.name);
  }

  isWriteTool(name: string): boolean {
    const tool = this.tools.find((candidate) => candidate.name === name);
    return tool ? isWrite(tool.annotations) : true;
  }

  async start(): Promise<void> {
    const handler = createMcpHandler(() => {
      const server = new McpServer({ name: `fake-${this.name}`, version: "1.0.0" });
      for (const tool of this.tools) {
        server.registerTool(
          tool.name,
          {
            description: tool.description,
            inputSchema: tool.input,
            annotations: tool.annotations,
          },
          async (args: Record<string, unknown>) => this.invoke(tool, args),
        );
      }
      return server;
    });
    this.served = await serveFetch(async (request) => {
      const methods = await jsonRpcMethods(request);
      const expected = this.auth.bearer?.();
      const authorized =
        this.auth.bearer === undefined ||
        (expected !== undefined &&
          request.headers.get("authorization") === `Bearer ${expected}`);
      this.ledger.requests.push({
        seq: this.ledger.next(),
        at: Date.now(),
        service: this.name,
        methods,
        authorized,
      });
      if (!authorized) {
        return new Response(JSON.stringify({ error: "invalid_token" }), {
          status: 401,
          headers: {
            "content-type": "application/json",
            "www-authenticate": 'Bearer error="invalid_token"',
          },
        });
      }
      return handler.fetch(request);
    });
  }

  async stop(): Promise<void> {
    await this.served?.close();
    this.served = undefined;
  }

  private async invoke(tool: FakeTool, args: Record<string, unknown>) {
    const index = (this.perTool.get(tool.name) ?? 0) + 1;
    this.perTool.set(tool.name, index);
    const faultIndex = this.faults.findIndex(
      (fault) =>
        fault.tool === tool.name && (fault.nth === undefined || fault.nth === index),
    );
    const fault = faultIndex >= 0 ? this.faults.splice(faultIndex, 1)[0] : undefined;
    const record: CallRecord = {
      seq: this.ledger.next(),
      at: Date.now(),
      service: this.name,
      tool: tool.name,
      args,
      kind: isWrite(tool.annotations) ? "write" : "read",
      outcome: "ok",
      resultBytes: 0,
    };
    this.ledger.calls.push(record);
    if (fault?.kind === "delay") {
      await new Promise((resolve) => setTimeout(resolve, fault.delayMs ?? 1_000));
    }
    if (fault?.kind === "error-before") {
      record.outcome = "fault";
      record.fault = fault.kind;
      return toMcpResult({ error: fault.message ?? "upstream unavailable" });
    }
    let result: FakeResult;
    try {
      result = await tool.run(args);
    } catch (error) {
      result = { error: error instanceof Error ? error.message : String(error) };
    }
    if (fault?.kind === "error-after") {
      record.outcome = "fault";
      record.fault = fault.kind;
      return toMcpResult({ error: fault.message ?? "gateway timeout" });
    }
    if ("error" in result) {
      record.outcome = "tool_error";
      record.error = result.error;
    }
    record.resultBytes = resultBytes(result);
    return toMcpResult(result);
  }
}

async function jsonRpcMethods(request: Request): Promise<string[]> {
  if (request.method !== "POST") return [request.method];
  try {
    const body: unknown = await request.clone().json();
    const messages = Array.isArray(body) ? body : [body];
    return messages.map((message) =>
      typeof message === "object" && message !== null && "method" in message
        ? String((message as { method: unknown }).method)
        : "response",
    );
  } catch {
    return ["unparseable"];
  }
}
