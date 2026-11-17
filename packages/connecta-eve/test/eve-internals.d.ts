/**
 * Eve 1.0.1 stopped publishing declarations for internal modules its entry
 * points do not reach (https://github.com/vercel/eve/pull/6464). These types
 * restate the rc.10 declarations of the internals the tests drive.
 */
import type { Approval, ApprovalPolicy } from "eve/tools/approval";
import type { ContextContainer } from "../node_modules/eve/dist/src/context/container.js";
import type { ContextReader } from "../node_modules/eve/dist/src/context/key.js";
import type { Draft } from "../node_modules/eve/dist/src/definitions/definition.js";
import type { CompiledBundle } from "../node_modules/eve/dist/src/runtime/sessions/runtime-context-keys.js";
import type { SessionAgent } from "../node_modules/eve/dist/src/runtime/sessions/session-agent.js";
import type { ResolvedConnectionDefinition } from "../node_modules/eve/dist/src/runtime/types.js";
import type {
  ConnectionClient,
  ConnectionProtocol,
  ConnectionToolMetadata,
} from "../node_modules/eve/dist/src/shared/connection-types.js";

type Reader = Pick<ContextReader, "get">;

export declare function withAgentApproval(
  agent: ApprovalPolicy | undefined,
  own: Approval | undefined,
): Approval | undefined;

export declare function fromCompiledBundle(bundle: CompiledBundle): SessionAgent;

export declare function dynamicConnectionVersions(ctx: Reader): ReadonlyMap<string, string>;

export declare function slotsOf(ctx: Reader, kind: string): readonly { readonly id: string; readonly live?: unknown }[];

export interface StepSource {
  readonly config: { readonly tools: ReadonlyMap<string, unknown> };
  readonly ctx: ContextReader;
  readonly finalReplyOnly: boolean;
  readonly session: { readonly rootSessionId: string };
}

export declare function stepDraft(step: StepSource): Promise<Draft>;

export declare function evaluateValues(
  ctx: ContextContainer,
  run: { readonly abortSignal?: AbortSignal; readonly conversation: readonly unknown[] },
): Promise<void>;

export declare function listToolMetadata(
  connection: Pick<ResolvedConnectionDefinition, "connectionName" | "tools">,
  client: ConnectionClient,
): Promise<readonly ConnectionToolMetadata[]>;

export interface RankCandidate {
  readonly name: string;
  readonly description: string;
  readonly inputSchema?: Readonly<Record<string, unknown>>;
  readonly connection?: { readonly description: string; readonly name: string };
}

export declare function rankCandidates<T extends RankCandidate>(query: string, candidates: readonly T[]): T[];

export declare function changedSinceOffered(
  call: { readonly version?: string },
  definition: { readonly version?: string } | undefined,
): boolean;

export declare function createConnectionInstanceId(input: {
  readonly connectionName: string;
  readonly instanceKey?: string;
  readonly protocol: ConnectionProtocol;
  readonly sourceId: string;
  readonly url: string;
}): string;
