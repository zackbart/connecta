import type {
  Connector,
  ConnectorCredentialConfig,
  ConnectorCredentialValues,
  ConnectorContext,
  CredentialTestResult,
  JsonSchema,
  ToolAnnotations,
  ToolDef,
} from "../types.js";

export interface ApiTool {
  name: string;
  description?: string;
  /** A plain JSON Schema object describing the tool input. */
  inputSchema?: JsonSchema;
  /** A plain JSON Schema object describing the tool's structured output. */
  outputSchema?: JsonSchema;
  /**
   * Standard MCP-style behavior hints. Only an explicit readOnlyHint: true
   * admits the tool to call_tool, batch_call, and execute_code.
   */
  annotations?: ToolAnnotations;
  handler: (args: any, ctx: ConnectorContext) => Promise<unknown> | unknown;
}

export interface ApiOptions {
  /** Human-readable display name; the connector id remains the address prefix. */
  title?: string;
  description?: string;
  /** Optional operator-managed credential exposed through ctx.credential and /ui. */
  credential?: ConnectorCredentialConfig;
  /** Optional validation behind /ui's Test action. */
  testCredential?: (
    value: string,
    ctx: ConnectorContext,
  ) => Promise<CredentialTestResult>;
  /** Optional validation for named multi-field credentials. */
  testCredentials?: (
    values: ConnectorCredentialValues,
    ctx: ConnectorContext,
  ) => Promise<CredentialTestResult>;
  tools: ApiTool[];
}

/**
 * A connector defined entirely in code: static tool defs + fetch handlers.
 * Tool inputs are plain JSON Schema objects (bring your own zod-to-json-schema
 * conversion if you prefer zod). call_tool JSON-wraps the handler's return.
 */
export function api(id: string, opts: ApiOptions): Connector {
  const defs: ToolDef[] = opts.tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    outputSchema: t.outputSchema,
    annotations: t.annotations,
  }));
  const byName = new Map(opts.tools.map((t) => [t.name, t]));
  return {
    id,
    title: opts.title,
    kind: "api",
    description: opts.description,
    credential: opts.credential,
    testCredential: opts.testCredential,
    testCredentials: opts.testCredentials,
    staticTools: defs,
    async listTools() {
      return defs;
    },
    async callTool(name, args, ctx) {
      const tool = byName.get(name);
      if (!tool) {
        throw new Error(`Unknown tool "${name}" on connector "${id}"`);
      }
      return tool.handler(args ?? {}, ctx);
    },
  };
}
