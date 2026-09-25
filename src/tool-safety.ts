import type { Connector, ToolDef } from "./types.js";

/**
 * The one fail-closed classification shared by discovery and invocation.
 *
 * A tool is read-only only when it says so without also saying it is
 * destructive. Missing, false, and contradictory annotations all require the
 * approval-visible call path.
 */
export function isExplicitlyReadOnly(definition: ToolDef): boolean {
  return (
    definition.annotations?.readOnlyHint === true &&
    definition.annotations?.destructiveHint !== true
  );
}

/**
 * A deployment's approval exemptions, resolved once at construction from
 * `execute.approval` (#566). Config is the only source: nothing an agent, the
 * operator UI, or a downstream catalog says can add an entry.
 */
export interface ApprovalPolicy {
  /** Connector id → the default for that connector's tools. */
  readonly connectors: ReadonlyMap<string, "never" | "ask">;
  /** Canonical `connector.tool` address → that tool's own setting. */
  readonly tools: ReadonlyMap<string, "never" | "ask">;
}

export const NO_EXEMPTIONS: ApprovalPolicy = {
  connectors: new Map(),
  tools: new Map(),
};

/**
 * Whether a program may call this tool without pausing for approval.
 *
 * Only a tool that is *not* explicitly read-only can be exempt — a read-only
 * tool needs no exemption, and reporting one would blur the two classes an
 * exemption must never merge. The most specific setting wins: the tool's
 * address, then its connector's entry, then the connector's own default,
 * then `"ask"`. Annotations play no part beyond that first test: a downstream
 * that could annotate its way out of approval would be granting itself the
 * capability this exists to keep in config. Exempt never means read-only:
 * discovery keeps it in the approval-required class, and `call_tool` still
 * refuses it.
 */
export function isApprovalExempt(
  policy: ApprovalPolicy,
  connector: Pick<Connector, "id" | "approval">,
  toolName: string,
  definition: ToolDef,
): boolean {
  if (isExplicitlyReadOnly(definition)) return false;
  // This tool starts another program. Letting a program call it while holding
  // the only executor permit would deadlock; manual refresh is a top-level
  // action, even though other artifact writes are exempt inside programs.
  if (connector.id === "artifacts" && toolName === "run_refresh") return false;
  const setting =
    policy.tools.get(`${connector.id}.${toolName}`) ??
    policy.connectors.get(connector.id) ??
    connector.approval ??
    "ask";
  return setting === "never";
}
