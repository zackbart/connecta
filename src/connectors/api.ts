import { compileValidator, validateToolInput } from "../validate.js";
import type {
  Connector,
  ConnectorCallAdmissionPolicy,
  ConnectorCredentialConfig,
  ConnectorCredentialValues,
  ConnectorContext,
  ConnectorUsageGuide,
  CredentialTestResult,
  JsonSchema,
  ToolAnnotations,
  ToolDef,
} from "../types.js";

export function defined<T extends object>(
  value: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as { [K in keyof T]?: Exclude<T[K], undefined> };
}

export interface ApiTool {
  name: string;
  /**
   * Required, non-empty. Discovery has nothing else to go on: a nameless
   * capability costs the agent a guess, and a guess costs a wrong call.
   */
  description: string;
  /**
   * A plain JSON Schema object describing the tool input. Optional, but what
   * you supply must be a schema the validator can compile — `api()` refuses to
   * construct otherwise.
   */
  inputSchema?: JsonSchema;
  /** A plain JSON Schema object describing the tool's structured output. */
  outputSchema?: JsonSchema;
  /**
   * Standard MCP-style behavior hints, with an explicit `readOnlyHint`
   * required: `true` declares a read and admits the tool to call_tool and
   * execute_code, `false` declares work that must cross
   * `call_destructive_tool` where a host can ask a human. Connecta never
   * infers the classification from a name, a description, a schema, or the
   * other annotations.
   */
  annotations: ToolAnnotations & { readOnlyHint: boolean };
  handler: (args: any, ctx: ConnectorContext) => Promise<unknown> | unknown;
}

export interface ApiOptions {
  /** Human-readable display name; the connector id remains the address prefix. */
  title?: string;
  description?: string;
  /**
   * Max inline result size (bytes) for this connector's tools before
   * call_tool truncates and stashes the full text for get_result
   * paging. Overrides the deployment's `calls.maxResultBytes`; omit to inherit
   * it. Must be a whole number of bytes >= 1; anything else warns at startup
   * and is ignored.
   */
  maxResultBytes?: number;
  /** Optional per-runtime downstream call-admission policy. */
  callAdmission?: ConnectorCallAdmissionPolicy;
  /**
   * Optional agent-facing usage guide served by `skills` as
   * `connector:<id>`. A string is markdown; the structured form adds bounded
   * discovery metadata. See `Connector.usageGuide`.
   */
  usageGuide?: string | ConnectorUsageGuide;
  /** Optional operator-managed credential exposed through ctx.credential and /credentials. */
  credential?: ConnectorCredentialConfig;
  /** Optional validation behind /credentials' Test action. */
  testCredential?: (
    value: string,
    ctx: ConnectorContext,
  ) => Promise<CredentialTestResult>;
  /** Optional validation for named multi-field credentials. */
  testCredentials?: (
    values: ConnectorCredentialValues,
    ctx: ConnectorContext,
  ) => Promise<CredentialTestResult>;
  /**
   * Validate call arguments against each tool's `inputSchema` before invoking
   * the handler (default true). Mismatches fail with a non-retryable
   * `invalid_args` ConnectorCallError instead of reaching the handler. Set
   * false to restore the pre-validation pass-through for deployments relying
   * on loose coercion.
   */
  validateArgs?: boolean;
  tools: ApiTool[];
}

/** Enforce provider conventions' two construction-time checks. */
function checkToolContract(id: string, tool: ApiTool): void {
  const address = `${id}.${tool.name}`;
  if (typeof tool.description !== "string" || tool.description.trim() === "") {
    throw new Error(
      `api() tool "${address}" needs a non-empty description — it is what an ` +
        "agent reads to choose the tool (convention: imperative one-liner, " +
        'e.g. "Send an email via Resend").',
    );
  }
  if (typeof tool.annotations?.readOnlyHint !== "boolean") {
    throw new Error(
      `api() tool "${address}" needs an explicit annotations.readOnlyHint: ` +
        "true for a read, false for work that must cross " +
        "call_destructive_tool. Connecta never infers the classification " +
        "from a tool name, description, schema, or other annotations.",
    );
  }
  if (tool.inputSchema) compileValidator(tool.inputSchema, { address });
}

/** A static connector; see provider conventions' two construction-time checks. */
export function api(id: string, opts: ApiOptions): Connector {
  for (const t of opts.tools) checkToolContract(id, t);
  const defs: ToolDef[] = opts.tools.map((t) => ({
    name: t.name,
    description: t.description,
    ...defined({
      inputSchema: t.inputSchema,
      outputSchema: t.outputSchema,
    }),
    annotations: t.annotations,
  }));
  const byName = new Map(opts.tools.map((t) => [t.name, t]));
  const validateArgs = opts.validateArgs ?? true;
  return {
    id,
    ...defined({ title: opts.title }),
    kind: "api",
    ...defined({
      description: opts.description,
      maxResultBytes: opts.maxResultBytes,
      callAdmission: opts.callAdmission,
      usageGuide: opts.usageGuide,
      credential: opts.credential,
      testCredential: opts.testCredential,
      testCredentials: opts.testCredentials,
    }),
    staticTools: defs,
    async listTools() {
      return defs;
    },
    async callTool(name, args, ctx) {
      const tool = byName.get(name);
      if (!tool) {
        throw new Error(`Unknown tool "${name}" on connector "${id}"`);
      }
      const input = args ?? {};
      if (validateArgs && tool.inputSchema) {
        const invalid = validateToolInput(tool.inputSchema, input, {
          address: `${id}.${name}`,
          logger: ctx.logger,
          // Always: the schema compiled at construction, so anything that
          // fails here is a schema that cannot be enforced, and a surface we
          // wrote ourselves does not get to admit unvalidated input quietly.
          failClosed: true,
        });
        if (invalid) throw invalid;
      }
      // `await` (not a bare promise return) so a handler that throws before
      // its first await never sits handler-less for the thenable-adoption
      // microtask — workerd and vitest both report that gap as an unhandled
      // rejection even though the caller catches the failure.
      return await tool.handler(input, ctx);
    },
  };
}
