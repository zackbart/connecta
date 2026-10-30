// One remoteMcp() connector's shared runtime: its validated configuration and
// the closure state and operations each seam's factory contributes. remoteMcp()
// builds it once at construction; factories reach another seam through it.
import type {
  CallToolResult,
  Client,
  ReadResourceResult,
  RequestOptions,
  StreamableHTTPClientTransport,
  Tool,
  Transport,
} from "@modelcontextprotocol/client";
import type { Effect } from "effect";
import type { KvOAuthProvider, OAuthRefreshCoordinator } from "../../auth/downstream-oauth.js";
import type { catalogClientOptions } from "../../catalog-cache.js";
import type { ConnectorCallError } from "../../errors.js";
import type { RequestPrincipal } from "../../request-token.js";
import type {
  Connector,
  ConnectorContext,
  ConnectorSkill,
  ConnectorSkillResourceContents,
  Logger,
  ToolDef,
} from "../../types.js";
import type { ResourceTemplateRefusal } from "../resource-uri.js";
import type { RemoteMcpConfig } from "./config.js";
import type { ConnectionState, Preread } from "./connection.js";
import type { ScopeEndedError } from "./errors.js";
import type { EraRefusal } from "./transport.js";

/** What one seam's factory provides to the others. */
export interface RemoteMcpShared {
  // ./errors.ts
  authRequiredError: (ctx: ConnectorContext) => ConnectorCallError;
  atMcpBoundary: (
    ctx: ConnectorContext,
    err: unknown,
    step: "MCP handshake" | "tools/list" | "tools/call" | "skills/list" | "resources/read",
    transport: Transport | undefined,
    signals: readonly (AbortSignal | undefined)[],
  ) => unknown;
  OperatorDisconnectedError: new () => ConnectorCallError;
  operatorDisconnectedError: () => ConnectorCallError;
  CredentialRequiredError: new (message: string) => ConnectorCallError;
  UnresolvedTokenError: new () => ConnectorCallError;
  withoutCredential: (ctx: ConnectorContext, err: unknown, ...secrets: (string | null)[]) => unknown;
  scopeEndedError: () => ScopeEndedError;
  // ./transport.ts
  earlyRenewals: WeakMap<Transport, (due: string, signal: AbortSignal | undefined) => Promise<void>>;
  activeContexts: WeakMap<ConnectionState, Set<ConnectorContext>>;
  trackSentRequest: (ctx: ConnectorContext, input: RequestInfo | URL, init?: RequestInit) => void;
  buildTransport: (
    ctx: ConnectorContext,
    provider: KvOAuthProvider | null,
    credentialFramed?: string | null,
    signal?: AbortSignal | undefined,
    credentialValue?: string | null,
    exchangeOnly?: boolean,
    principal?: RequestPrincipal | undefined,
  ) => Transport;
  eraRefusals: WeakMap<Transport, EraRefusal>;
  eraRefused: WeakSet<Client>;
  closeConnection: (client: Client | null, transport: Transport | null, logger: Logger) => Effect.Effect<void>;
  // ./connection.ts
  states: WeakMap<object, ConnectionState>;
  connectedProviders: WeakMap<Client, KvOAuthProvider>;
  cacheOwner: {};
  refreshCoordinatorFor: (ctx: ConnectorContext) => OAuthRefreshCoordinator;
  requestOptions: (ctx: ConnectorContext) => { signal?: AbortSignal; timeout?: number } | undefined;
  entryFor: (ctx: ConnectorContext) => ConnectionState;
  isClosed: (state: ConnectionState) => boolean;
  stateFor: (ctx: ConnectorContext) => ConnectionState;
  newProvider: (ctx: ConnectorContext, state?: ConnectionState, signal?: AbortSignal | undefined) => KvOAuthProvider;
  reset: (state: ConnectionState) => void;
  closeHalf: (state: ConnectionState) => void;
  cachedCatalog: (ctx: ConnectorContext) => Promise<Preread & { tools?: Tool[] }>;
  ensureConnected: (ctx: ConnectorContext, state: ConnectionState, preread?: Preread | undefined) => Promise<Client>;
  // ./oauth.ts
  boundOAuthFlows: (
    ctx: ConnectorContext,
    transport: StreamableHTTPClientTransport,
    endpoint: URL,
    signals: readonly (AbortSignal | undefined)[],
    renewalSignal: (response: Response) => AbortSignal | undefined,
  ) => void;
  granted: (provider: KvOAuthProvider) => Promise<boolean>;
  renewBeforeCall: (ctx: ConnectorContext, due: string) => Promise<void>;
  renewBeforeDispatch: (ctx: ConnectorContext, state: ConnectionState, client: Client) => Promise<void>;
  oauthSurface: (connector: Connector) => void;
  // ./catalog.ts
  liveListings: WeakSet<ConnectorContext>;
  listingContexts: WeakMap<RequestOptions, ConnectorContext>;
  installCatalogIntake: (
    client: Client,
    ctx: ConnectorContext,
    cache: Awaited<ReturnType<typeof catalogClientOptions>>,
  ) => void;
  listToolsOperation: (ctx: ConnectorContext) => Promise<ToolDef[]>;
  // ./resources.ts
  resourceTemplateRefusals: Set<ResourceTemplateRefusal>;
  listSkills: (ctx: ConnectorContext) => Promise<ConnectorSkill[]>;
  readSkill: (uri: string, ctx: ConnectorContext) => Promise<ConnectorSkillResourceContents[]>;
  readResourceOperation: (uri: string, ctx: ConnectorContext) => Promise<ReadResourceResult>;
  // ./call.ts
  callToolOperation: (
    name: string,
    args: unknown,
    ctx: ConnectorContext,
    options:
      | {
          definition?: ToolDef;
          input?: { requestState?: string; inputResponses: Record<string, unknown> } | undefined;
        }
      | undefined,
  ) => Promise<CallToolResult>;
}

export type RemoteMcpRuntime = RemoteMcpConfig & RemoteMcpShared & { connector: Connector };
