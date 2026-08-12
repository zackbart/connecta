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

/**
 * Enforce the construction contract for one hand-written tool.
 *
 * Everything here is something only the author can supply and no runtime can
 * guess: what the tool does, and whether calling it needs a human's blessing.
 * Guessing either one is how a deployment boots into the wrong shape, so this
 * throws instead. Note what it does *not* do — it never reads a name, verb, or
 * HTTP method to infer a safety class. An unclassified tool is a bug in the
 * deployment, not a puzzle for connecta to solve.
 */
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

/**
 * A connector defined entirely in code: static tool defs + fetch handlers.
 * Tool inputs are plain JSON Schema objects (bring your own zod-to-json-schema
 * conversion if you prefer zod). call_tool JSON-wraps the handler's return.
 *
 * Every tool declares a description and an explicit `annotations.readOnlyHint`,
 * and any `inputSchema` it carries must compile — a tool that fails the
 * contract throws here rather than reaching a catalog. Arguments are then
 * validated against `inputSchema` before the handler runs (disable with
 * `validateArgs: false`, which opts out of enforcement, not out of the schema
 * being real), and a schema that only reveals itself as unenforceable on first
 * use — an unresolvable `$ref`, say — fails the call rather than passing raw
 * arguments through. Remote MCP inputs are also validated, but in the shared
 * invocation path against the request-local downstream catalog, where a
 * downstream's schema is its own affair and stays fail-open.
 */
export function api(id: string, opts: ApiOptions): Connector {
  for (const t of opts.tools) checkToolContract(id, t);
  const defs: ToolDef[] = opts.tools.map((t) => ({
    name: t.name,
    description: t.description,
    ...(t.inputSchema !== undefined ? { inputSchema: t.inputSchema } : {}),
    ...(t.outputSchema !== undefined ? { outputSchema: t.outputSchema } : {}),
    annotations: t.annotations,
  }));
  const byName = new Map(opts.tools.map((t) => [t.name, t]));
  const validateArgs = opts.validateArgs ?? true;
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
