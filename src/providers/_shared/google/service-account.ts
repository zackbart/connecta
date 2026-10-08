/**
 * A Google service account acting for Workspace users through domain-wide
 * delegation: the key, the signed JWT-bearer assertion, and the short-lived
 * access tokens it buys. Shared by every Workspace product provider; never its
 * own export.
 *
 * Why not the vault. One key serves every Workspace connector a deployment
 * declares — Gmail, Drive, Docs — and it is a deployment secret in the same
 * sense as an OAuth client secret: an environment variable or Worker secret,
 * read at construction. A per-connector operator slot would ask a human to
 * paste the same key six times and would still not say whose mailbox to open.
 *
 * Why no library. `google-auth-library` is Node-bound and the OAuth client in
 * the MCP SDK is the wrong grant. RS256 over Web Crypto is a page of code, so
 * the signing path runs unchanged on Node and Workers and the provider bundles
 * pull in nothing new.
 *
 * Tokens live in memory only, keyed by service account, subject, and scope
 * set, for at most the hour Google grants and never past a minute before
 * expiry. Nothing here writes to storage, and nothing here logs: not the key,
 * not an assertion, not a token. An error message names the service account
 * and the scopes — both are configuration a reader needs to fix the grant —
 * and never the material that proves it.
 */
import {
  guardedFetch,
  retryAfterMs,
  type GuardedTransport,
} from "../../../connectors/guarded-fetch.js";
import { ConnectorCallError, type ConnectorCallErrorCode } from "../../../errors.js";
import type { ConnectorContext } from "../../../types.js";

/** Google's OAuth 2.0 token endpoint, and the JWT audience it requires. */
const GOOGLE_TOKEN_ORIGIN = "https://oauth2.googleapis.com";
const GOOGLE_TOKEN_URL = `${GOOGLE_TOKEN_ORIGIN}/token`;
const JWT_BEARER_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";

/** Google refuses an assertion that lives longer than an hour. */
const ASSERTION_LIFETIME_SECONDS = 3600;
/** A cached token is replaced this long before Google says it expires. */
const REFRESH_MARGIN_MS = 60_000;
/**
 * Distinct (account, subject, scopes) tokens held at once. Past it the oldest
 * goes first: a deployment with more simultaneous delegated users than this
 * re-mints, which costs a round trip, not correctness.
 */
const MAX_CACHED_TOKENS = 512;
/** A token response is a few hundred bytes; anything near this is not one. */
const TOKEN_RESPONSE_BYTES = 64 * 1024;

/**
 * The two fields of a Google service-account JSON key that delegation needs.
 * Copy them from the downloaded key file, or pass the file's whole JSON text
 * instead and let the provider read it.
 */
export interface GoogleServiceAccount {
  /** The key's `client_email`, `name@project.iam.gserviceaccount.com`. */
  clientEmail: string;
  /**
   * The key's `private_key`: a PKCS#8 PEM, `-----BEGIN PRIVATE KEY-----`. An
   * environment variable that kept the JSON's `\n` escapes literally is
   * accepted as written.
   */
  privateKey: string;
  /**
   * The key's `client_id`, the number the Admin console's domain-wide
   * delegation page asks for. Optional; when known, a refused grant names it.
   */
  clientId?: string;
}

/** A parsed, construction-checked key. Its fields never reach a message. */
export interface ServiceAccountKey {
  readonly clientEmail: string;
  readonly clientId: string | undefined;
  /** PKCS#8 DER of an RSA key, decoded and checked once at construction. */
  readonly der: Uint8Array<ArrayBuffer>;
}

const PEM = /-----BEGIN PRIVATE KEY-----([\s\S]*?)-----END PRIVATE KEY-----/;

function decodedKey(owner: string, pem: string): Uint8Array<ArrayBuffer> {
  // A key pasted into an environment variable often keeps the JSON escapes.
  const normalized = pem.replace(/\\n/g, "\n").trim();
  if (/-----BEGIN RSA PRIVATE KEY-----/.test(normalized)) {
    throw new Error(
      `${owner} serviceAccount.privateKey is a PKCS#1 RSA key. Google's JSON keys carry PKCS#8 ("BEGIN PRIVATE KEY"); paste the private_key field of the downloaded JSON key.`,
    );
  }
  const body = PEM.exec(normalized)?.[1]?.replace(/\s+/g, "");
  if (!body || !/^[A-Za-z0-9+/]+={0,2}$/.test(body)) {
    throw new Error(
      `${owner} serviceAccount.privateKey is not a PEM private key; paste the private_key field of the service account's JSON key.`,
    );
  }
  let binary: string;
  try {
    binary = atob(body);
  } catch {
    throw new Error(`${owner} serviceAccount.privateKey is not valid base64 inside its PEM armor.`);
  }
  const der = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    der[index] = binary.charCodeAt(index);
  }
  // A truncated paste, another file, or another algorithm is cheaper to refuse
  // here than to discover on the first call — and a key that only fails at
  // use can hide behind a token another key already minted.
  const modulusBits = rsaPkcs8ModulusBits(der);
  if (modulusBits === undefined) {
    throw new Error(
      `${owner} serviceAccount.privateKey does not decode to a PKCS#8 RSA private key; paste the private_key field of the service account's JSON key.`,
    );
  }
  if (modulusBits < MIN_RSA_BITS) {
    throw new Error(
      `${owner} serviceAccount.privateKey is a ${modulusBits}-bit RSA key; Google signs service-account assertions with ${MIN_RSA_BITS}-bit keys or larger.`,
    );
  }
  return der;
}

/** Google issues 2048-bit service-account keys; RS256 wants no less. */
const MIN_RSA_BITS = 2048;
/** rsaEncryption, 1.2.840.113549.1.1.1, as its DER content octets. */
const RSA_ENCRYPTION_OID = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01];

interface Tlv {
  tag: number;
  start: number;
  end: number;
}

/** One DER tag-length-value at `offset`, or undefined if it does not fit. */
function tlv(der: Uint8Array, offset: number, limit = der.length): Tlv | undefined {
  if (offset + 2 > limit) return undefined;
  const tag = der[offset]!;
  let length = der[offset + 1]!;
  let start = offset + 2;
  if (length & 0x80) {
    const octets = length & 0x7f;
    // Indefinite lengths are BER, not DER; four octets is 4 GiB.
    if (octets === 0 || octets > 4 || start + octets > limit) return undefined;
    length = 0;
    for (let index = 0; index < octets; index += 1) length = length * 256 + der[start + index]!;
    start += octets;
  }
  const end = start + length;
  return end > limit ? undefined : { tag, start, end };
}

/**
 * The modulus size of a PKCS#8 `PrivateKeyInfo` wrapping an RSA key, or
 * undefined for anything else. Walks exactly the structure RFC 5208 and RFC
 * 8017 define — version 0, the rsaEncryption algorithm identifier with NULL
 * parameters, and an octet string holding exactly the nine integers of a
 * two-prime `RSAPrivateKey` — and requires every structure to be consumed
 * whole, so a well-formed key of another algorithm, a PKCS#1 body in PKCS#8
 * armor, altered parameters, trailing bytes, and a truncated paste are all
 * refused here rather than by Google on the first call.
 */
function rsaPkcs8ModulusBits(der: Uint8Array): number | undefined {
  const info = tlv(der, 0);
  if (!info || info.tag !== 0x30 || info.end !== der.length) return undefined;
  const version = tlv(der, info.start, info.end);
  if (!version || version.tag !== 0x02 || version.end - version.start !== 1 || der[version.start] !== 0) {
    return undefined;
  }
  const algorithm = tlv(der, version.end, info.end);
  if (!algorithm || algorithm.tag !== 0x30) return undefined;
  const oid = tlv(der, algorithm.start, algorithm.end);
  if (
    !oid ||
    oid.tag !== 0x06 ||
    oid.end - oid.start !== RSA_ENCRYPTION_OID.length ||
    RSA_ENCRYPTION_OID.some((octet, index) => der[oid.start + index] !== octet)
  ) {
    return undefined;
  }
  // rsaEncryption's parameters are exactly NULL, and nothing follows them.
  const parameters = tlv(der, oid.end, algorithm.end);
  if (
    !parameters ||
    parameters.tag !== 0x05 ||
    parameters.end !== parameters.start ||
    parameters.end !== algorithm.end
  ) {
    return undefined;
  }
  const wrapped = tlv(der, algorithm.end, info.end);
  if (!wrapped || wrapped.tag !== 0x04) return undefined;
  // PKCS#8 allows one optional [0] attributes set after the key; nothing else.
  let tail = wrapped.end;
  if (tail < info.end) {
    const attributes = tlv(der, tail, info.end);
    if (!attributes || attributes.tag !== 0xa0) return undefined;
    tail = attributes.end;
  }
  if (tail !== info.end) return undefined;
  const key = tlv(der, wrapped.start, wrapped.end);
  if (!key || key.tag !== 0x30 || key.end !== wrapped.end) return undefined;
  // version (0: two primes, no otherPrimeInfos), n, e, d, p, q, dP, dQ, qInv
  const integers: Tlv[] = [];
  let at = key.start;
  for (let index = 0; index < 9; index += 1) {
    const integer = tlv(der, at, key.end);
    if (!integer || integer.tag !== 0x02 || integer.end === integer.start) return undefined;
    integers.push(integer);
    at = integer.end;
  }
  const rsaVersion = integers[0]!;
  if (at !== key.end || rsaVersion.end - rsaVersion.start !== 1 || der[rsaVersion.start] !== 0) {
    return undefined;
  }
  const modulus = integers[1]!;
  let first = modulus.start;
  while (first < modulus.end - 1 && der[first] === 0) first += 1;
  const leading = der[first]!;
  return leading === 0 ? undefined : (modulus.end - first - 1) * 8 + (32 - Math.clz32(leading));
}

function field(record: Record<string, unknown>, name: string): string | undefined {
  const value = record[name];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * Check a service account at construction: the object form, or the JSON key
 * file's text. Structural mistakes throw here, so a deployment never boots into
 * a connector whose every call would fail.
 */
export function parseServiceAccount(owner: string, input: unknown): ServiceAccountKey {
  let record: Record<string, unknown>;
  let fromFile = false;
  if (typeof input === "string") {
    try {
      record = JSON.parse(input) as Record<string, unknown>;
    } catch {
      throw new Error(
        `${owner} serviceAccount must be { clientEmail, privateKey } or the JSON key file's text; the string given is not JSON.`,
      );
    }
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw new Error(`${owner} serviceAccount JSON is not a key object.`);
    }
    if (record["type"] !== undefined && record["type"] !== "service_account") {
      throw new Error(
        `${owner} serviceAccount JSON is a "${String(record["type"])}" credential, not a service_account key.`,
      );
    }
    fromFile = true;
  } else if (input && typeof input === "object" && !Array.isArray(input)) {
    record = input as Record<string, unknown>;
  } else {
    throw new Error(
      `${owner} requires serviceAccount: { clientEmail, privateKey } or the JSON key file's text.`,
    );
  }
  const clientEmail = field(record, fromFile ? "client_email" : "clientEmail");
  const privateKey = field(record, fromFile ? "private_key" : "privateKey");
  const clientId = field(record, fromFile ? "client_id" : "clientId");
  if (!clientEmail || !/^[^\s@]+@[^\s@]+$/.test(clientEmail)) {
    throw new Error(
      `${owner} serviceAccount needs ${fromFile ? "client_email" : "clientEmail"}: the service account's email address.`,
    );
  }
  if (!privateKey) {
    throw new Error(
      `${owner} serviceAccount needs ${fromFile ? "private_key" : "privateKey"}: the PEM private key from the JSON key file.`,
    );
  }
  if (clientId !== undefined && !/^\d+$/.test(clientId)) {
    throw new Error(`${owner} serviceAccount clientId must be the numeric client ID.`);
  }
  return { clientEmail, clientId, der: decodedKey(owner, privateKey) };
}

// --- Signing --------------------------------------------------------------------

const encoder = new TextEncoder();

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** One import per key per isolate; a failed import is retried, not cached. */
const signingKeys = new WeakMap<ServiceAccountKey, Promise<CryptoKey>>();

function signingKey(account: ServiceAccountKey): Promise<CryptoKey> {
  let key = signingKeys.get(account);
  if (!key) {
    key = crypto.subtle
      .importKey(
        "pkcs8",
        account.der,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["sign"],
      )
      .catch((cause: unknown) => {
        signingKeys.delete(account);
        throw new ConnectorCallError(
          "auth_required",
          `The private key for service account ${account.clientEmail} could not be imported as an RSA signing key. Replace it with the private_key of a current JSON key for that account.`,
          { cause },
        );
      });
    signingKeys.set(account, key);
  }
  return key;
}

/** The RS256 JWT-bearer assertion for one subject and scope set. */
async function signAssertion(
  account: ServiceAccountKey,
  subject: string,
  scopes: readonly string[],
  nowSeconds: number,
): Promise<string> {
  const header = base64Url(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const claims = base64Url(
    encoder.encode(
      JSON.stringify({
        iss: account.clientEmail,
        sub: subject,
        scope: scopes.join(" "),
        aud: GOOGLE_TOKEN_URL,
        iat: nowSeconds,
        exp: nowSeconds + ASSERTION_LIFETIME_SECONDS,
      }),
    ),
  );
  const input = `${header}.${claims}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    await signingKey(account),
    encoder.encode(input),
  );
  return `${input}.${base64Url(new Uint8Array(signature))}`;
}

// --- Token exchange --------------------------------------------------------------

const tokenTransport: GuardedTransport = guardedFetch({
  provider: "Google OAuth",
  baseUrl: GOOGLE_TOKEN_ORIGIN,
  headers: { Accept: "application/json" },
  maxResponseBytes: TOKEN_RESPONSE_BYTES,
  // The assertion in the body is the authentication; there is no header.
  authenticate: () => ({}),
});

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The token endpoint's OAuth `error` codes this module names back. */
const TOKEN_ERROR_CODES: ReadonlySet<string> = new Set([
  "invalid_request",
  "invalid_client",
  "invalid_grant",
  "invalid_scope",
  "unauthorized_client",
  "unsupported_grant_type",
  "access_denied",
  "disabled_client",
  "rate_limit_exceeded",
  "server_error",
  "temporarily_unavailable",
]);

/**
 * What the token endpoint answered, in connecta's words: the step, the host,
 * the status, and the OAuth `error` code when it is one of the known codes.
 * Google's `error_description` is withheld. It is an authorization server's
 * text, and the rule for those holds here as in `remoteMcp()`: whatever such
 * a server writes may echo what it was sent, so none of it reaches an agent
 * or a log, however benign Google's has been.
 */
function tokenAnswer(status: number, code: unknown): string {
  const named = typeof code === "string" && TOKEN_ERROR_CODES.has(code) ? ` with OAuth error ${code}` : "";
  return ` The token request to ${GOOGLE_TOKEN_ORIGIN} was answered HTTP ${status}${named}; its description is withheld.`;
}

/**
 * Map a refused token request to what fixes it. The codes are RFC 6749's and
 * Google documents what each means for a delegated assertion.
 */
function tokenFailure(
  account: ServiceAccountKey,
  scopes: readonly string[],
  status: number,
  headers: Headers,
  payload: unknown,
): ConnectorCallError {
  const code = asRecord(payload)["error"];
  const said = tokenAnswer(status, code);
  const client = account.clientId
    ? `client ID ${account.clientId} (${account.clientEmail})`
    : `the client ID of ${account.clientEmail}`;
  if (code === "unauthorized_client" || code === "access_denied") {
    return new ConnectorCallError(
      "auth_required",
      `Google refused domain-wide delegation for ${account.clientEmail}.${said} A Workspace super admin must authorize ${client} in the Admin console (Security → Access and data control → API controls → Manage Domain Wide Delegation) with exactly these scopes: ${scopes.join(",")}. A new or changed grant can take up to 24 hours to apply.`,
    );
  }
  if (code === "invalid_grant") {
    return new ConnectorCallError(
      "auth_required",
      `Google refused the delegated token.${said} The mapped Workspace user may not exist, may be suspended, or may be outside the domain that granted delegation; the service account key may have been deleted or disabled; or this host's clock may be minutes off. Check the deployment's subject mapping and the key before retrying.`,
    );
  }
  if (code === "invalid_client" || code === "disabled_client") {
    return new ConnectorCallError(
      "auth_required",
      `Google rejected service account ${account.clientEmail} itself.${said} The account or its key may be disabled or deleted; create a new JSON key and redeploy.`,
    );
  }
  if (status === 429) {
    const wait = retryAfterMs(headers);
    return new ConnectorCallError(
      "rate_limited",
      `Google's token endpoint is rate limiting ${account.clientEmail}.${said}`,
      wait === undefined ? {} : { retryAfterMs: wait },
    );
  }
  if (status >= 500) {
    return new ConnectorCallError(
      "unavailable",
      `Google's token endpoint answered HTTP ${status}.${said}`,
    );
  }
  return new ConnectorCallError(
    "connector_call_failed",
    `Google's token endpoint refused the delegated assertion with HTTP ${status}.${said}`,
    { retryable: false },
  );
}

interface Minted {
  accessToken: string;
  expiresAt: number;
}

async function mint(
  account: ServiceAccountKey,
  subject: string,
  scopes: readonly string[],
  ctx: ConnectorContext,
): Promise<Minted> {
  const issuedAt = Date.now();
  const assertion = await signAssertion(account, subject, scopes, Math.floor(issuedAt / 1000));
  return await tokenTransport(
    {
      method: "POST",
      path: "/token",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      rawBody: new URLSearchParams({ grant_type: JWT_BEARER_GRANT, assertion }).toString(),
    },
    ctx,
    async (response) => {
      const parsed = await response.jsonResult();
      const payload = "value" in parsed ? parsed.value : undefined;
      if (!response.ok) {
        throw verdict(tokenFailure(account, scopes, response.status, response.headers, payload));
      }
      const body = asRecord(payload);
      const accessToken = body["access_token"];
      const expiresIn = Number(body["expires_in"] ?? ASSERTION_LIFETIME_SECONDS);
      if (typeof accessToken !== "string" || accessToken === "" || !Number.isFinite(expiresIn)) {
        throw verdict(new ConnectorCallError(
          "connector_call_failed",
          "Google's token endpoint answered without an access token.",
          { retryable: false },
        ));
      }
      // Measured from before the request left, so a slow answer only ever
      // shortens the token's life here, never lengthens it.
      return { accessToken, expiresAt: issuedAt + expiresIn * 1000 };
    },
  );
}

// --- Cache -----------------------------------------------------------------------

/**
 * What a mint in flight tells the callers waiting on it: plain data, settled
 * by the owner inside its own request. A follower never reads the owner's
 * signal, response, or error object — on Workers those belong to the owner's
 * request, and touching them from another throws "Cannot perform I/O on behalf
 * of a different request". Only a verdict from Google is shared; anything
 * else, the owner's cancellation included, is `abandoned`, and the follower
 * mints for itself.
 */
type FlightOutcome =
  | { kind: "token"; minted: Minted }
  | { kind: "refused"; code: ConnectorCallErrorCode; message: string; retryAfterMs: number | undefined }
  | { kind: "abandoned" };

interface Flight {
  /** Never rejects; resolved by the owner, in the owner's request. */
  outcome: Promise<FlightOutcome>;
  /** Epoch ms after which no follower waits on this flight any longer. */
  deadline: number;
}

/** The longest a follower waits on another caller's mint. */
const FLIGHT_WAIT_MS = 30_000;

/** Errors carrying Google's own answer, the only failures a flight shares. */
const verdicts = new WeakSet<ConnectorCallError>();

function verdict(error: ConnectorCallError): ConnectorCallError {
  verdicts.add(error);
  return error;
}

/** Module-level and in memory only: tokens never touch storage. */
const tokens = new Map<string, Minted>();
const flights = new Map<string, Flight>();

/** One delegated token request: whose account, acting as whom, for what. */
export interface DelegatedTokenRequest {
  account: ServiceAccountKey;
  subject: string;
  scopes: readonly string[];
}

/**
 * The key's own identity, a SHA-256 of its DER. Part of every cache key, so a
 * rotated key — or a replacement that would not sign — never answers with a
 * token another key minted for the same service account.
 */
const keyIdentities = new WeakMap<ServiceAccountKey, Promise<string>>();

function keyIdentity(account: ServiceAccountKey): Promise<string> {
  let identity = keyIdentities.get(account);
  if (!identity) {
    identity = crypto.subtle.digest("SHA-256", account.der).then((digest) =>
      Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
    );
    keyIdentities.set(account, identity);
  }
  return identity;
}

async function cacheKey({ account, subject, scopes }: DelegatedTokenRequest): Promise<string> {
  // Workspace addresses are case-insensitive; scope order is not a new grant.
  return [
    account.clientEmail,
    await keyIdentity(account),
    subject.toLowerCase(),
    [...scopes].sort().join(" "),
  ].join("\n");
}

function remember(key: string, minted: Minted): void {
  tokens.delete(key);
  tokens.set(key, minted);
  while (tokens.size > MAX_CACHED_TOKENS) {
    const oldest = tokens.keys().next().value;
    if (oldest === undefined) break;
    tokens.delete(oldest);
  }
}

/**
 * Wait on another caller's flight under this caller's own terms: its own
 * signal, its own timer to the flight's deadline, and a promise created here,
 * so the continuation runs in this caller's request whichever request settles
 * the flight. Rejects only with this caller's own abort reason.
 */
function follow(flight: Flight, signal: AbortSignal | undefined): Promise<FlightOutcome> {
  return new Promise<FlightOutcome>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    let done = false;
    const finish = (outcome: FlightOutcome) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    const onAbort = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(
      () => finish({ kind: "abandoned" }),
      Math.max(0, flight.deadline - Date.now()),
    );
    signal?.addEventListener("abort", onAbort, { once: true });
    void flight.outcome.then(finish);
  });
}

/**
 * An access token for this subject and scope set: the cached one while it has
 * more than a minute left, otherwise one fresh mint shared by every concurrent
 * caller asking for the same key.
 *
 * Followers share only a scalar outcome and a deadline. The owner records
 * what happened inside its own request — a token, Google's refusal, or
 * `abandoned` for anything else — and a follower that hears `abandoned`, or
 * reaches the deadline first, mints for itself. A refusal is rebuilt for each
 * follower from its code and message, never handed over as the owner's object.
 */
export async function delegatedToken(
  request: DelegatedTokenRequest,
  ctx: ConnectorContext,
): Promise<string> {
  const key = await cacheKey(request);
  for (;;) {
    const cached = tokens.get(key);
    if (cached && cached.expiresAt - REFRESH_MARGIN_MS > Date.now()) {
      return cached.accessToken;
    }
    const flight = flights.get(key);
    if (flight && flight.deadline > Date.now()) {
      const outcome = await follow(flight, ctx.signal);
      if (outcome.kind === "token") return outcome.minted.accessToken;
      if (outcome.kind === "refused") {
        throw new ConnectorCallError(
          outcome.code,
          outcome.message,
          outcome.retryAfterMs === undefined ? {} : { retryAfterMs: outcome.retryAfterMs },
        );
      }
      if (flights.get(key) === flight) flights.delete(key);
      continue;
    }
    let settle!: (outcome: FlightOutcome) => void;
    const own: Flight = {
      outcome: new Promise<FlightOutcome>((resolve) => {
        settle = resolve;
      }),
      deadline: Date.now() + Math.min(ctx.timeoutMs ?? FLIGHT_WAIT_MS, FLIGHT_WAIT_MS),
    };
    flights.set(key, own);
    try {
      const minted = await mint(request.account, request.subject, request.scopes, ctx);
      remember(key, minted);
      settle({ kind: "token", minted });
      return minted.accessToken;
    } catch (error) {
      settle(
        error instanceof ConnectorCallError && verdicts.has(error)
          ? {
              kind: "refused",
              code: error.code,
              message: error.message,
              retryAfterMs: error.retryAfterMs,
            }
          : { kind: "abandoned" },
      );
      throw error;
    } finally {
      if (flights.get(key) === own) flights.delete(key);
    }
  }
}

/**
 * Drop a token the API has just rejected, so the next request mints anew —
 * but only that token. A 401 that arrives after a newer token replaced it
 * leaves the newer one alone.
 */
export async function forgetDelegatedToken(
  request: DelegatedTokenRequest,
  rejected: string,
): Promise<void> {
  const key = await cacheKey(request);
  if (tokens.get(key)?.accessToken === rejected) tokens.delete(key);
}
