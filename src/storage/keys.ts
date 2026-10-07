// Every key connecta stores, in one module.
//
// A deployment has one KVStorage (D1 on Workers, SQLite on Node, memory in
// tests), and every subsystem shares it. Sharing is safe because no two
// families claim overlapping keys, and that is only checkable if every key is
// built here: `test/storage-keys.node.test.ts` fails when another source file
// spells one of these prefixes itself.
//
// Each family records:
//
// - scope: where its keys sit. `root` keys are physical. `partition` keys sit
//   under a result partition (`results:`, or `subject:<key>:` for a scoped
//   subject). `connector` keys sit under a connector's namespace
//   (`conn:<id>:`), which a personal registry nests again under
//   `principal:<key>:`.
// - version: the layout the keys and values follow. `in: "key"` families spell
//   it in the key, so a new layout can be written beside the old one and
//   migrated; `in: "value"` families carry it inside each record; `untagged`
//   families predate tags, and their next layout change adds one. A version
//   changes with a one-shot migration or with a family declared transient.
// - codec: how a value is written. `json` values are validated by the
//   subsystem that reads them; nothing here trusts stored bytes.
// - ttl: `durable` (no expiry), `fixed` seconds, or `configured` by the
//   deployment. Transient families can change layout freely, because their
//   data expires within one TTL of a deploy.

/** How one family's values are written and read back. */
export interface Codec<V> {
  readonly name: "text" | "json";
  encode(value: V): string;
  decode(raw: string): V;
}

/** Stored as given. */
const textCodec: Codec<string> = {
  name: "text",
  encode: (value) => value,
  decode: (raw) => raw,
};

/** JSON. Decoding returns `unknown`: the reader validates the shape. */
export const jsonCodec: Codec<unknown> = {
  name: "json",
  encode: (value) => JSON.stringify(value),
  decode: (raw) => JSON.parse(raw) as unknown,
};

type KeyTtl =
  | { readonly kind: "durable" }
  | { readonly kind: "fixed"; readonly seconds: number }
  | { readonly kind: "configured"; readonly by: string };

export interface KeyFamily {
  readonly name: string;
  readonly scope: "root" | "partition" | "connector";
  /** Static prefixes of every key the family writes, inside its scope. */
  readonly prefixes: readonly string[];
  readonly version: {
    readonly number: number;
    readonly in: "key" | "value" | "untagged";
  };
  readonly codec: Codec<string> | Codec<unknown>;
  readonly ttl: KeyTtl;
  /** Whether a deployment loses something it cannot recreate without it. */
  readonly durable: boolean;
}

/** A family's description beside the builders its callers use. */
type Keyed = { readonly family: KeyFamily } & Record<string, unknown>;

// --- scopes -------------------------------------------------------------

/** Namespaces core hands to the subsystems below. */
export const scopes = {
  /** A personal registry's partition of the root store. */
  principal: (principalKey: string) => `principal:${principalKey}:`,
  /** One connector's namespace: its `ctx.storage`. */
  connector: (connectorId: string) => `conn:${connectorId}:`,
  /** The root result partition. */
  results: "results:",
  /** A scoped subject's result partition. */
  subject: (subjectKey: string) => `subject:${subjectKey}:`,
} as const;

// --- partition families ---------------------------------------------------

/** Seconds a stashed result stays readable through paging. */
export const RESULT_TTL_SECONDS = 900;

/**
 * A stashed result: chunk 0 at `result:<id>`, chunk n at `result:<id>#<n>`.
 * The value is the paging envelope `src/meta-tools.ts` writes and reads.
 */
export const resultKeys = {
  family: {
    name: "result",
    scope: "partition",
    prefixes: ["result:"],
    version: { number: 3, in: "value" },
    codec: textCodec,
    ttl: { kind: "fixed", seconds: RESULT_TTL_SECONDS },
    durable: false,
  },
  chunk: (id: string, index: number) =>
    index === 0 ? `result:${id}` : `result:${id}#${index}`,
} as const satisfies Keyed;

// --- root families --------------------------------------------------------

/**
 * The runtime-wide result stash ledger: every live stash entry's partition
 * key, byte charge, and expiry. One record, swapped by compare-and-set, so the
 * stash bounds hold across isolates and processes sharing the store.
 */
export const stashLedgerKeys = {
  family: {
    name: "result-stash-ledger",
    scope: "root",
    prefixes: ["result-stash:v1:"],
    version: { number: 1, in: "key" },
    codec: jsonCodec,
    // Durable as a record, self-pruning by content: an entry leaves the
    // ledger once its result's TTL has passed.
    ttl: { kind: "durable" },
    durable: false,
  },
  ledger: "result-stash:v1:ledger",
} as const satisfies Keyed;

/**
 * A persisted downstream catalog: the manifest at `catalog:<id>`, then its
 * chunks at `catalog:<id>:chunk:<revision>:<index>`.
 */
export const catalogKeys = {
  family: {
    name: "catalog",
    scope: "root",
    prefixes: ["catalog:"],
    // The manifest records its own version (2); chunks follow it.
    version: { number: 2, in: "value" },
    codec: textCodec,
    ttl: {
      kind: "configured",
      by: "discovery.catalogTtlSeconds + discovery.staleCatalogSeconds",
    },
    durable: false,
  },
  manifest: (connectorId: string) => `catalog:${connectorId}`,
  chunk: (connectorId: string, revision: string, index: number) =>
    `catalog:${connectorId}:chunk:${revision}:${index}`,
} as const satisfies Keyed;

/** Seconds an OAuth callback's owner binding stays claimable. */
export const OAUTH_HANDOFF_TTL_SECONDS = 15 * 60;

/** The principal that started an OAuth flow, by connector and state digest. */
export const oauthHandoffKeys = {
  family: {
    name: "oauth-handoff",
    scope: "root",
    prefixes: ["oauth-handoff:v1:"],
    version: { number: 1, in: "key" },
    codec: textCodec,
    ttl: { kind: "fixed", seconds: OAUTH_HANDOFF_TTL_SECONDS },
    durable: false,
  },
  handoff: (connectorId: string, stateHash: string) =>
    `oauth-handoff:v1:${connectorId}:${stateHash}`,
} as const satisfies Keyed;

/** Connecta-issued `cta_` access tokens: records, digest lookups, capacity. */
export const accessTokenKeys = {
  family: {
    name: "access-token",
    scope: "root",
    prefixes: ["access-token:v1:"],
    version: { number: 1, in: "key" },
    codec: jsonCodec,
    ttl: { kind: "durable" },
    durable: true,
  },
  recordPrefix: "access-token:v1:record:",
  record: (id: string) => `access-token:v1:record:${id}`,
  lookup: (tokenHash: string) => `access-token:v1:lookup:${tokenHash}`,
  active: "access-token:v1:active",
} as const satisfies Keyed;

/**
 * A vault credential, sealed: `credential:v1` inside its connector's
 * namespace, under the owner's principal partition when it is personal.
 */
export const credentialKeys = {
  family: {
    name: "credential",
    scope: "connector",
    prefixes: ["credential:v1"],
    version: { number: 1, in: "key" },
    codec: jsonCodec,
    ttl: { kind: "durable" },
    durable: true,
  },
  credential: (connectorId: string, owner?: string) =>
    `${owner ? scopes.principal(owner) : ""}${scopes.connector(connectorId)}credential:v1`,
} as const satisfies Keyed;

/** Default root of the artifact store's keys. */
export const ARTIFACT_PREFIX = "artifact:";

/**
 * Artifact pages, under one root (default `artifact:`):
 *
 *   head:<id>                          the one mutable record per artifact
 *   ver:<id>:<stream>:<n, 10 digits>   every version but each stream's latest
 *   blob:<sha256>                      bodies, unless a blob store holds them
 *   run:<id>:<startedAt ms>:<runId>    refresh run history, newest 50
 *   refresh:scan-cursor                the scheduler's resume point
 */
export const artifactKeys = {
  family: {
    name: "artifact",
    scope: "root",
    prefixes: [ARTIFACT_PREFIX],
    version: { number: 1, in: "untagged" },
    codec: jsonCodec,
    ttl: { kind: "durable" },
    durable: true,
  },
  under: (root: string) => ({
    head: (id: string) => `${root}head:${id}`,
    versionPrefix: (id: string, stream: string) => `${root}ver:${id}:${stream}:`,
    runPrefix: (id: string) => `${root}run:${id}:`,
    /** One run under `runPrefix(id)`; `order` sorts runs oldest first. */
    run: (id: string, order: string, runId: string) => `${root}run:${id}:${order}:${runId}`,
    blob: (key: string) => `${root}blob:${key}`,
    scanCursor: `${root}refresh:scan-cursor`,
  }),
} as const satisfies Keyed;

// --- connector families ---------------------------------------------------

/** The OAuth values a flow stores, each under its historical key. */
const oauthField = {
  client: "oauth:client",
  tokens: "oauth:tokens",
  pending: "oauth:pending",
  verifier: "oauth:verifier",
  state: "oauth:state",
  discovery: "oauth:discovery",
} as const;

export type OAuthValueKey = (typeof oauthField)[keyof typeof oauthField];

/**
 * Downstream OAuth state in a connector's namespace, layout 2: each value at
 * its field key, suffixed `:epoch:<generation>` once a modern generation owns
 * it; the active generation at `oauth:generation`; a reset's cleanup lineage
 * at `oauth:cleanup:` and `oauth:cleanup-at:`. Layout 2 is marked by the `v2:`
 * generation value. Phase 3 replaces it with one grant record per owner and
 * one flow record per consent, migrating from this layout.
 */
export const oauthKeys = {
  family: {
    name: "oauth",
    scope: "connector",
    prefixes: [
      ...Object.values(oauthField),
      "oauth:generation",
      "oauth:cleanup:",
      "oauth:cleanup-at:",
    ],
    version: { number: 2, in: "value" },
    codec: textCodec,
    ttl: { kind: "durable" },
    durable: true,
  },
  field: oauthField,
  /** A value's physical key; `epoch` null is the historical unsuffixed name. */
  value: (key: OAuthValueKey, epoch: string | null) =>
    epoch === null ? key : `${key}:epoch:${epoch}`,
  generation: "oauth:generation",
  cleanup: (generation: string) =>
    `oauth:cleanup:${encodeURIComponent(generation)}`,
  cleanupAt: (generation: string) =>
    `oauth:cleanup-at:${encodeURIComponent(generation)}`,
} as const satisfies Keyed;

/** Single-use `/connect/<id>` links already spent, by nonce. */
export const oauthConnectKeys = {
  family: {
    name: "oauth-connect",
    scope: "connector",
    prefixes: ["oauth:connect-used:"],
    version: { number: 1, in: "untagged" },
    codec: textCodec,
    // The link's own remaining lifetime, at most fifteen minutes.
    ttl: { kind: "fixed", seconds: 15 * 60 },
    durable: false,
  },
  used: (nonce: string) => `oauth:connect-used:${nonce}`,
} as const satisfies Keyed;

/**
 * Every family, for the overlap and coverage checks and for migrations that
 * copy only what a deployment cannot recreate. Keys a custom connector writes
 * through its own `ctx.storage` belong to that connector, inside its
 * namespace, and are not listed here.
 */
export const KEY_FAMILIES: readonly KeyFamily[] = [
  resultKeys.family,
  stashLedgerKeys.family,
  catalogKeys.family,
  oauthHandoffKeys.family,
  accessTokenKeys.family,
  credentialKeys.family,
  artifactKeys.family,
  oauthKeys.family,
  oauthConnectKeys.family,
];
