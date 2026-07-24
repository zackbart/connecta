import { Validator } from "@cfworker/json-schema";
import { ConnectorCallError } from "../errors.js";
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
    description: t.description,
    inputSchema: t.inputSchema,
    outputSchema: t.outputSchema,
    annotations: t.annotations,
  }));
  const byName = new Map(opts.tools.map((t) => [t.name, t]));
  const validateArgs = opts.validateArgs ?? true;
  // Lazy per-tool validator cache; null marks a schema the validator rejected
  // (warned once, then passed through rather than breaking a working tool).
  const validators = new Map<string, Validator | null>();
  const disableValidation = (
    tool: ApiTool,
    ctx: ConnectorContext,
    err: unknown,
  ) => {
    validators.set(tool.name, null);
    ctx.logger.warn(
      `[connecta] tool "${id}.${tool.name}" has an inputSchema the validator cannot use (${
        err instanceof Error ? err.message : String(err)
      }) — arguments are not validated`,
    );
  };
  const validatorFor = (tool: ApiTool, ctx: ConnectorContext) => {
    let validator = validators.get(tool.name);
    if (validator === undefined) {
      try {
        validator = new Validator(tool.inputSchema as never, "2020-12", false);
        validators.set(tool.name, validator);
      } catch (err) {
        disableValidation(tool, ctx, err);
        validator = null;
      }
    }
    return validator;
  };
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
      const input = args ?? {};
      if (validateArgs && tool.inputSchema) {
        const validator = validatorFor(tool, ctx);
        let result;
        try {
          result = validator?.validate(input);
        } catch (err) {
          // e.g. an unresolvable $ref — surfaces on first validate, not compile.
          disableValidation(tool, ctx, err);
        }
        if (result && !result.valid) {
          const units = result.errors.filter(
            (u) => u.instanceLocation !== "#",
          );
          const detail = (units.length > 0 ? units : result.errors)
            .slice(0, 3)
            .map((u) => `${u.instanceLocation}: ${u.error}`)
            .join("; ");
          throw new ConnectorCallError(
            "invalid_args",
            `Invalid arguments for "${id}.${name}": ${detail || "input does not match the tool's inputSchema"}`,
          );
        }
      }
      return tool.handler(input, ctx);
    },
  };
}
