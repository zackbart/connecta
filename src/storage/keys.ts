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

/** SQL TEXT keys must round-trip on every supported Node and D1 runtime. */
export function validateStorageKey(key: string): string {
  if (key.includes("\0")) {
    throw new TypeError("Storage keys and list prefixes must not contain U+0000 (NUL)");
  }
  return key;
}

// --- scopes -------------------------------------------------------------

/** Namespaces core hands to the subsystems below. */
export const scopes = {
  /** A personal registry's partition of the root store. */
  principal: (principalKey: string) => validateStorageKey(`principal:${principalKey}:`),
  /** One connector's namespace: its `ctx.storage`. */
  connector: (connectorId: string) => validateStorageKey(`conn:${connectorId}:`),
  /** The root result partition. */
  results: "results:",
  /** A scoped subject's result partition. */
  subject: (subjectKey: string) => validateStorageKey(`subject:${subjectKey}:`),
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
    version: { number: 4, in: "value" },
    codec: textCodec,
    ttl: { kind: "fixed", seconds: RESULT_TTL_SECONDS },
    durable: false,
  },
  chunk: (id: string, index: number) => validateStorageKey(index === 0 ? `result:${id}` : `result:${id}#${index}`),
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
    // Retired v2/v3 listings are inventoried for migration; no runtime reads them.
    version: { number: 3, in: "value" },
    codec: textCodec,
    ttl: {
      kind: "configured",
      by: "retired catalog layout; expires on its original TTL",
    },
    durable: false,
  },
  manifest: (connectorId: string) => validateStorageKey(`catalog:${connectorId}`),
  chunk: (connectorId: string, revision: string, index: number) =>
    validateStorageKey(`catalog:${connectorId}:chunk:${revision}:${index}`),
} as const satisfies Keyed;

/** SDK catalog response cache, complete manifests published after their chunks. */
export const responseCacheKeys = {
  family: {
    name: "response-cache",
    scope: "root",
    prefixes: ["response-cache:v1:"],
    version: { number: 1, in: "key" },
    codec: textCodec,
    ttl: {
      kind: "configured",
      by: "bounded downstream ttlMs; generations and hash refresh baselines expire after 48 hours",
    },
    durable: false,
  },
  prefix: (id: string) => validateStorageKey(`response-cache:v1:${id}:`),
  generation: (id: string) => validateStorageKey(`response-cache:v1:${id}:generation`),
  namespace: (id: string, config: string, generation: string) =>
    validateStorageKey(`response-cache:v1:${id}:${config}:${generation}:`),
  entry: (namespace: string, partition: string) => validateStorageKey(`${namespace}${partition}`),
  refreshDigest: (id: string, config: string, partition: string) =>
    validateStorageKey(`response-cache:v1:${id}:refresh-digest:${config}:${partition}`),
  chunk: (entry: string, revision: string, index: number) => validateStorageKey(`${entry}:chunk:${revision}:${index}`),
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
    validateStorageKey(`oauth-handoff:v1:${connectorId}:${stateHash}`),
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
  record: (id: string) => validateStorageKey(`access-token:v1:record:${id}`),
  lookup: (tokenHash: string) => validateStorageKey(`access-token:v1:lookup:${tokenHash}`),
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

/** Seconds a Workers KV → D1 copy's resume point stays usable. */
export const KV_COPY_CURSOR_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Where a one-shot Workers KV → D1 copy (`copyKvToD1` in `src/d1.ts`) resumes,
 * held in D1 under a random token. Workers KV's own list cursor can spell the
 * last key it listed, so the caller holds the token and never the cursor.
 */
export const kvCopyKeys = {
  family: {
    name: "kv-copy",
    scope: "root",
    prefixes: ["kv-copy:v1:"],
    version: { number: 1, in: "key" },
    codec: textCodec,
    ttl: { kind: "fixed", seconds: KV_COPY_CURSOR_TTL_SECONDS },
    durable: false,
  },
  cursor: (token: string) => validateStorageKey(`kv-copy:v1:cursor:${token}`),
} as const satisfies Keyed;

/** Once traffic uses D1, copying stale KV state is refused. */
export const kvCutoverKeys = {
  family: {
    name: "kv-cutover",
    scope: "root",
    prefixes: ["kv-cutover:v1:"],
    version: { number: 1, in: "key" },
    codec: textCodec,
    ttl: { kind: "durable" },
    durable: true,
  },
  source: (source: string) => validateStorageKey(`kv-cutover:v1:${encodeURIComponent(source)}`),
} as const satisfies Keyed;

// --- connector families ---------------------------------------------------

/** Seconds a consent's flow record stays claimable, the same as its link. */
export const OAUTH_FLOW_TTL_SECONDS = 15 * 60;

/**
 * Downstream OAuth's grant in a connector's namespace, layout 3: one record
 * per owner at `oauth:grant`, holding the epoch, the latest consent's state
 * digest, and the sealed client, tokens, and discovery. Every write is a
 * compare-and-set against the exact record read, so a write a restart
 * overtook cannot land.
 */
export const oauthGrantKeys = {
  family: {
    name: "oauth-grant",
    scope: "connector",
    prefixes: ["oauth:grant"],
    version: { number: 3, in: "value" },
    codec: jsonCodec,
    ttl: { kind: "durable" },
    durable: true,
  },
  grant: "oauth:grant",
} as const satisfies Keyed;

/**
 * One consent: `oauth:flow:<sha256(state)>`, holding its epoch, consent URL,
 * and sealed PKCE verifier. The callback claims it by compare-and-set before
 * the code leaves, so consumption is recorded on that consent alone.
 */
export const oauthFlowKeys = {
  family: {
    name: "oauth-flow",
    scope: "connector",
    prefixes: ["oauth:flow:"],
    version: { number: 1, in: "value" },
    codec: jsonCodec,
    ttl: { kind: "fixed", seconds: OAUTH_FLOW_TTL_SECONDS },
    durable: false,
  },
  prefix: "oauth:flow:",
  flow: (stateDigest: string) => validateStorageKey(`oauth:flow:${stateDigest}`),
} as const satisfies Keyed;

/** Shared-storage lifetime of a refresh holder, longer than its HTTP deadline. */
export const OAUTH_REFRESH_LEASE_SECONDS = 120;
export const oauthRefreshKeys = {
  family: {
    name: "oauth-refresh",
    scope: "connector",
    prefixes: ["oauth:refresh:"],
    version: { number: 1, in: "value" },
    codec: jsonCodec,
    ttl: { kind: "durable" },
    durable: true,
  },
  prefix: "oauth:refresh:",
  lease: (epoch: string, tokenDigest: string) => validateStorageKey(`oauth:refresh:${epoch}:${tokenDigest}`),
} as const satisfies Keyed;

/** One fingerprint's dispatch and resolution across epochs. Never expire or delete these records. */
export const oauthRefreshSpentKeys = {
  family: {
    name: "oauth-refresh-spent",
    scope: "connector",
    prefixes: ["oauth:refresh-spent:"],
    version: { number: 1, in: "value" },
    codec: jsonCodec,
    ttl: { kind: "durable" },
    durable: true,
  },
  spent: (tokenDigest: string) => validateStorageKey(`oauth:refresh-spent:${tokenDigest}`),
} as const satisfies Keyed;

/** Expiry is storage-owned; dispatched fingerprints themselves never expire. */
export const oauthRefreshActiveKeys = {
  family: {
    name: "oauth-refresh-active",
    scope: "connector",
    prefixes: ["oauth:refresh-active:"],
    version: { number: 1, in: "value" },
    codec: jsonCodec,
    ttl: { kind: "fixed", seconds: OAUTH_REFRESH_LEASE_SECONDS },
    durable: false,
  },
  prefix: "oauth:refresh-active:",
  holder: (epoch: string, holder: string) => validateStorageKey(`oauth:refresh-active:${epoch}:${holder}`),
} as const satisfies Keyed;

/** The values layout 2 stored, each under its historical key. */
const oauthV2Field = {
  client: "oauth:client",
  tokens: "oauth:tokens",
  pending: "oauth:pending",
  verifier: "oauth:verifier",
  state: "oauth:state",
  discovery: "oauth:discovery",
} as const;

export type OAuthV2ValueKey = (typeof oauthV2Field)[keyof typeof oauthV2Field];

/**
 * Layout 2, read once to migrate it into a grant record and then deleted:
 * each value at its field key, suffixed `:epoch:<generation>` once a modern
 * generation owned it; the active generation at `oauth:generation`; a reset's
 * cleanup lineage at `oauth:cleanup:` and `oauth:cleanup-at:`.
 */
export const oauthV2Keys = {
  family: {
    name: "oauth-v2",
    scope: "connector",
    prefixes: [...Object.values(oauthV2Field), "oauth:generation", "oauth:cleanup:", "oauth:cleanup-at:"],
    version: { number: 2, in: "value" },
    codec: textCodec,
    ttl: { kind: "durable" },
    durable: true,
  },
  field: oauthV2Field,
  /** One listing covers every layout 2 key; the reader keeps those above. */
  scan: "oauth:",
  /** A value's physical key; `epoch` null is the historical unsuffixed name. */
  value: (key: OAuthV2ValueKey, epoch: string | null) =>
    validateStorageKey(epoch === null ? key : `${key}:epoch:${epoch}`),
  generation: "oauth:generation",
} as const satisfies Keyed;

/** Single-use browser links (`used`/`started`/`failed`/`closed`) and MRTR rounds. */
export const oauthConnectKeys = {
  family: {
    name: "oauth-connect",
    scope: "connector",
    prefixes: ["oauth:connect-used:", "oauth:request-used:"],
    version: { number: 1, in: "untagged" },
    codec: textCodec,
    // The link's remaining lifetime, or fifteen minutes when retiring it.
    ttl: { kind: "fixed", seconds: 15 * 60 },
    durable: false,
  },
  used: (nonce: string) => validateStorageKey(`oauth:connect-used:${nonce}`),
  retry: (nonce: string) => validateStorageKey(`oauth:request-used:${nonce}`),
} as const satisfies Keyed;

/** A bounded, credential-partitioned downstream protocol verdict. */
export const NEGOTIATION_TTL_SECONDS = 300;
export const negotiationKeys = {
  family: {
    name: "negotiation",
    scope: "connector",
    prefixes: ["negotiation:v1:"],
    version: { number: 1, in: "key" },
    codec: jsonCodec,
    ttl: { kind: "fixed", seconds: NEGOTIATION_TTL_SECONDS },
    durable: false,
  },
  verdict: (partitionDigest: string) => validateStorageKey(`negotiation:v1:${partitionDigest}`),
} as const satisfies Keyed;

/** A downstream MRTR round is consumed once before continuation dispatch. */
export const inputRetryKeys = {
  family: {
    name: "downstream-input-retry",
    scope: "connector",
    prefixes: ["input-retry:v1:"],
    version: { number: 1, in: "key" },
    codec: textCodec,
    ttl: { kind: "fixed", seconds: 10 * 60 },
    durable: false,
  },
  used: (nonce: string) => validateStorageKey(`input-retry:v1:${nonce}`),
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
  responseCacheKeys.family,
  oauthHandoffKeys.family,
  accessTokenKeys.family,
  credentialKeys.family,
  oauthGrantKeys.family,
  oauthFlowKeys.family,
  oauthRefreshKeys.family,
  oauthRefreshSpentKeys.family,
  oauthRefreshActiveKeys.family,
  oauthV2Keys.family,
  oauthConnectKeys.family,
  negotiationKeys.family,
  inputRetryKeys.family,
  kvCopyKeys.family,
  kvCutoverKeys.family,
];

// Principal, connector, and subject segments are hex digests and connector
// ids, so none holds a colon.
const PRINCIPAL_SCOPE = /^principal:[^:]*:/;
const CONNECTOR_SCOPE = /^conn:[^:]*:/;
const PARTITION_SCOPE = /^(?:results:|subject:[^:]*:)/;

/**
 * The family a physical key belongs to, for reports that count keys without
 * naming them: one-shot migrations report per family, never per key. A key
 * no family claims is `connector-owned` when a custom connector wrote it
 * through its own `ctx.storage`, and `unclassified` otherwise (a key an older release wrote).
 */
export function familyOfKey(key: string): string {
  let rest = key.replace(PRINCIPAL_SCOPE, "");
  let scope: KeyFamily["scope"] = "root";
  for (const [pattern, nested] of [
    [CONNECTOR_SCOPE, "connector"],
    [PARTITION_SCOPE, "partition"],
  ] as const) {
    const match = pattern.exec(rest);
    if (match) {
      rest = rest.slice(match[0].length);
      scope = nested;
      break;
    }
  }
  const family = KEY_FAMILIES.find(
    (candidate) => candidate.scope === scope && candidate.prefixes.some((prefix) => rest.startsWith(prefix)),
  );
  if (family) return family.name;
  return scope === "connector" ? "connector-owned" : "unclassified";
}
