import type { ConnectorContext } from "./types.js";

/** A request-local Bearer resolver with optional cache invalidation on HTTP 401. */
export interface RequestToken {
  (ctx: ConnectorContext): Promise<string>;
  /** Drop only the rejected token. This hook never authorizes replay. */
  invalidate?: (rejected: string, ctx: ConnectorContext) => Promise<void>;
}

/**
 * A person inbound auth admitted, as the `{ namespace, id }` a member
 * reference resolves to. Never taken from arguments, programs or headers.
 */
export interface HumanRequestPrincipal {
  readonly kind: "human";
  readonly namespace: string;
  readonly id: string;
}

/** A declared agent and the pool it was admitted through. */
export interface AgentRequestPrincipal {
  readonly kind: "agent";
  readonly name: string;
  readonly pool: string;
}

/** The admitted caller a principal-forwarding request resolver receives. */
export type RequestPrincipal = HumanRequestPrincipal | AgentRequestPrincipal;

/**
 * Which admitted callers a principal-forwarding request resolver accepts.
 * `"human"` refuses agents; `"human-or-agent"` also accepts declared agents.
 */
export type RequestPrincipalPolicy = "human" | "human-or-agent";

/**
 * Opt-in principal forwarding for request auth: the resolver receives the
 * admitted caller, and every other caller is refused before it runs.
 */
export type PrincipalForwarding =
  | {
      accept: "human";
      token: PrincipalRequestToken<HumanRequestPrincipal>;
    }
  | {
      accept: "human-or-agent";
      token: PrincipalRequestToken;
    };

/** Per-resolution input for a principal-forwarding resolver. */
export interface RequestTokenInput<P extends RequestPrincipal = RequestPrincipal> {
  readonly principal: P;
}

/**
 * A request-local Bearer resolver that receives the admitted principal.
 * Return the same token for the same principal while it is valid.
 */
export interface PrincipalRequestToken<P extends RequestPrincipal = RequestPrincipal> {
  (ctx: ConnectorContext, input: RequestTokenInput<P>): Promise<string>;
  /** Drop only the rejected token for this principal. This hook never authorizes replay. */
  invalidate?: (rejected: string, ctx: ConnectorContext, input: RequestTokenInput<P>) => Promise<void>;
}
