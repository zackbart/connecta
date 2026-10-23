// The members of `eve` (0.83.0) that src/eve.ts uses, so Connecta
// typechecks without installing it: eve needs Node >= 24 and a required `ai`
// peer, and the deployment supplies it. This directory is not published; the
// emitted dist/eve.d.ts names the same types from the consumer's real eve. The
// V1 Eve harness typechecks that emitted declaration against eve 0.83.0, which
// is what keeps these names from drifting.

declare module "eve/tools/approval" {
  export interface ConnectionToolAnnotations {
    readonly title?: string;
    readonly readOnlyHint?: boolean;
    readonly destructiveHint?: boolean;
    readonly idempotentHint?: boolean;
    readonly openWorldHint?: boolean;
    readonly [key: string]: unknown;
  }
  export type ApprovalStatus = undefined | boolean | "not-applicable" | "approved" | "denied" | "user-approval";
  export interface ApprovalContext {
    readonly toolName: string;
    readonly toolAnnotations?: ConnectionToolAnnotations;
  }
  export type ApprovalPolicy = (ctx: ApprovalContext) => ApprovalStatus | Promise<ApprovalStatus>;
  export function never(): ApprovalPolicy;
}

declare module "eve/connections" {
  import type { ApprovalPolicy } from "eve/tools/approval";
  export interface TokenResult {
    readonly token: string;
    readonly expiresAt?: number;
  }
  export interface McpClientConnectionDefinition {
    readonly url: string;
    readonly description: string;
    auth?: { readonly credentialOwner?: "app" | "user"; readonly getToken: () => Promise<TokenResult> };
    approval?: ApprovalPolicy;
  }
  export function defineMcpClientConnection(definition: McpClientConnectionDefinition): McpClientConnectionDefinition;
}

declare module "eve/instructions" {
  export interface InstructionsDefinition {
    readonly content: string;
    readonly role?: "system" | "user";
  }
  export type DynamicInstructionsResult = InstructionsDefinition | null;
  export interface DynamicSentinel<TResult> {
    readonly kind: unknown;
    readonly events: { readonly [event: string]: (...args: never[]) => TResult | Promise<TResult> };
  }
  export function defineInstructions<T extends InstructionsDefinition>(definition: T): T;
  export function defineDynamic(definition: {
    readonly events: {
      readonly "session.started"?: () => DynamicInstructionsResult | Promise<DynamicInstructionsResult>;
      readonly "turn.started"?: () => DynamicInstructionsResult | Promise<DynamicInstructionsResult>;
    };
  }): DynamicSentinel<DynamicInstructionsResult>;
}
