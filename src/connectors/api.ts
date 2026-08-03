import { precompileValidator, validateToolInput } from "../validate.js";
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

export interface ApiTool {
  name: string;
  description?: string;
  /** A plain JSON Schema object describing the tool input. */
  inputSchema?: JsonSchema;
  /** A plain JSON Schema object describing the tool's structured output. */
  outputSchema?: JsonSchema;
  /**
   * Standard MCP-style behavior hints. Only an explicit readOnlyHint: true
   * admits the tool to call_tool and execute_code.
   */
  annotations?: ToolAnnotations;
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
  /**
   * Fail-closed on a tool whose `inputSchema` the validator cannot evaluate
   * (default false). The default surfaces such a schema as a one-time warning
   * and then passes the raw arguments through, so a broken schema never breaks
   * an otherwise working tool. Set true to instead reject those calls with a
   * non-retryable `invalid_args` ConnectorCallError, so a schema that cannot be
   * enforced never silently admits unvalidated input. Only consulted when
   * `validateArgs` is not false.
   */
  strictValidation?: boolean;
  tools: ApiTool[];
}

/**
 * A connector defined entirely in code: static tool defs + fetch handlers.
 * Tool inputs are plain JSON Schema objects (bring your own zod-to-json-schema
 * conversion if you prefer zod). call_tool JSON-wraps the handler's return.
 *
 * Arguments are validated against `inputSchema` before the handler runs
 * (disable with `validateArgs: false`). This is deliberately asymmetric with
 * remote MCP connectors, which stay pass-through: the downstream server is
 * authoritative for its own schemas, and re-validating with our JSON Schema
 * draft/format semantics could reject calls the downstream would accept.
 */
export function api(id: string, opts: ApiOptions): Connector {
  const defs: ToolDef[] = opts.tools.map((t) => ({
    name: t.name,
    ...(t.description !== undefined ? { description: t.description } : {}),
    ...(t.inputSchema !== undefined ? { inputSchema: t.inputSchema } : {}),
    ...(t.outputSchema !== undefined ? { outputSchema: t.outputSchema } : {}),
    ...(t.annotations !== undefined ? { annotations: t.annotations } : {}),
  }));
  const byName = new Map(opts.tools.map((t) => [t.name, t]));
  const validateArgs = opts.validateArgs ?? true;
  const strictValidation = opts.strictValidation ?? false;
  if (validateArgs) {
    // Compile each schema now so a validator-hostile inputSchema surfaces once
    // here rather than silently on its first call. Warning-only; never throws.
    for (const t of opts.tools) {
      if (t.inputSchema)
        precompileValidator(t.inputSchema, { address: `${id}.${t.name}` });
    }
  }
  return {
    id,
    ...(opts.title !== undefined ? { title: opts.title } : {}),
    kind: "api",
    ...(opts.description !== undefined
      ? { description: opts.description }
      : {}),
    ...(opts.maxResultBytes !== undefined
      ? { maxResultBytes: opts.maxResultBytes }
      : {}),
    ...(opts.callAdmission !== undefined
      ? { callAdmission: opts.callAdmission }
      : {}),
    ...(opts.usageGuide !== undefined ? { usageGuide: opts.usageGuide } : {}),
    ...(opts.credential !== undefined ? { credential: opts.credential } : {}),
    ...(opts.testCredential !== undefined
      ? { testCredential: opts.testCredential }
      : {}),
    ...(opts.testCredentials !== undefined
      ? { testCredentials: opts.testCredentials }
      : {}),
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
          failClosed: strictValidation,
        });
        if (invalid) throw invalid;
      }
      return tool.handler(input, ctx);
    },
  };
}
