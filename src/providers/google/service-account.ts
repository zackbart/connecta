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
} from "../../connectors/guarded-fetch.js";
import { ConnectorCallError } from "../../errors.js";
import type { ConnectorContext } from "../../types.js";

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
  /** PKCS#8 DER, decoded once at construction. */
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
  // Every PKCS#8 structure opens with a DER SEQUENCE; anything else is a
  // truncated paste or a different file, and is cheaper to refuse here than
  // to discover on the first call.
  if (der.length < 64 || der[0] !== 0x30) {
    throw new Error(`${owner} serviceAccount.privateKey does not decode to a PKCS#8 key.`);
  }
  return der;
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

/**
 * Google's own `error_description`, bounded and stripped to printable text.
 * It describes the refusal ("Invalid email or User ID", "Invalid JWT
 * Signature.") and never echoes the assertion, so it is worth passing on; the
 * classification still comes only from the `error` code.
 */
function googleSaid(payload: unknown): string {
  const description = asRecord(payload)["error_description"];
  if (typeof description !== "string") return "";
  const clean = description.replace(/[^\x20-\x7e]/g, " ").trim().slice(0, 200);
  return clean ? ` Google said: "${clean}".` : "";
}

/**
 * Map a refused token request to what fixes it. The codes are RFC 6749's and
 * Google documents what each means for a delegated assertion; the
 * description is passed on for the reader, never parsed.
 */
function tokenFailure(
  account: ServiceAccountKey,
  scopes: readonly string[],
  status: number,
  headers: Headers,
  payload: unknown,
): ConnectorCallError {
  const code = asRecord(payload)["error"];
  const said = googleSaid(payload);
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
        throw tokenFailure(account, scopes, response.status, response.headers, payload);
      }
      const body = asRecord(payload);
      const accessToken = body["access_token"];
      const expiresIn = Number(body["expires_in"] ?? ASSERTION_LIFETIME_SECONDS);
      if (typeof accessToken !== "string" || accessToken === "" || !Number.isFinite(expiresIn)) {
        throw new ConnectorCallError(
          "connector_call_failed",
          "Google's token endpoint answered without an access token.",
          { retryable: false },
        );
      }
      // Measured from before the request left, so a slow answer only ever
      // shortens the token's life here, never lengthens it.
      return { accessToken, expiresAt: issuedAt + expiresIn * 1000 };
    },
  );
}

// --- Cache -----------------------------------------------------------------------

interface Flight {
  promise: Promise<Minted>;
  /** The owner's cancellation, which a joiner does not inherit. */
  signal: AbortSignal | undefined;
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

function cacheKey({ account, subject, scopes }: DelegatedTokenRequest): string {
  // Workspace addresses are case-insensitive; scope order is not a new grant.
  return [account.clientEmail, subject.toLowerCase(), [...scopes].sort().join(" ")].join("\n");
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

/** Wait for a promise no longer than this call's own cancellation. */
function within<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

/**
 * An access token for this subject and scope set: the cached one while it has
 * more than a minute left, otherwise one fresh mint shared by every concurrent
 * caller asking for the same key.
 *
 * A joiner waits under its own signal, never the owner's, and an owner that
 * was cancelled does not hand its cancellation on: the joiner mints for
 * itself. Only a verdict from Google — a token or a refusal — is shared.
 */
export async function delegatedToken(
  request: DelegatedTokenRequest,
  ctx: ConnectorContext,
): Promise<string> {
  const key = cacheKey(request);
  for (;;) {
    const cached = tokens.get(key);
    if (cached && cached.expiresAt - REFRESH_MARGIN_MS > Date.now()) {
      return cached.accessToken;
    }
    const flight = flights.get(key);
    if (flight) {
      try {
        return (await within(flight.promise, ctx.signal)).accessToken;
      } catch (error) {
        if (ctx.signal?.aborted || !flight.signal?.aborted) throw error;
        // The owner left before Google answered; this caller asks itself.
        if (flights.get(key) === flight) flights.delete(key);
        continue;
      }
    }
    const own: Flight = {
      promise: mint(request.account, request.subject, request.scopes, ctx),
      signal: ctx.signal,
    };
    flights.set(key, own);
    try {
      const minted = await own.promise;
      remember(key, minted);
      return minted.accessToken;
    } finally {
      if (flights.get(key) === own) flights.delete(key);
    }
  }
}

/** Drop a token the API has just rejected, so the next request mints anew. */
export function forgetDelegatedToken(request: DelegatedTokenRequest): void {
  tokens.delete(cacheKey(request));
}
