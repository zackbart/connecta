// RS256 JWT and JWKS verification shared by the built-in Vercel workload and
// Cloudflare Access assertion verifiers: Web APIs only, no SDK or platform import.
import { decodeBase64url } from "../bytes.js";
import { runEdge } from "../runtime/run.js";
import { authCall, authCatch, authFetch, authFlow, authInvoke, authProgram, registerAuth } from "./native.js";

const CACHE_MS = 300_000;
const REFRESH_MS = 30_000;
const SKEW_SECONDS = 30;
/** Thrown when two key fetches are already in flight for one key set. */
export const KEY_FETCH_BUSY = Symbol("key fetch capacity reached");
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

function bytes(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+(?![\s\S])/.test(value)) throw new Error("Invalid JWT encoding");
  return decodeBase64url(value);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function part(value: string): Record<string, unknown> {
  const decoded: unknown = JSON.parse(decoder.decode(bytes(value)));
  if (!record(decoded)) throw new Error("Invalid JWT object");
  return decoded;
}

export interface DecodedJwt {
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
  pieces: string[];
}

/** Decodes without verifying anything; undefined for anything but a compact JWS. */
export function decodeJwt(token: string): DecodedJwt | undefined {
  if (token.length > 16_384) return undefined;
  const pieces = token.split(".");
  if (pieces.length !== 3) return undefined;
  try {
    return { header: part(pieces[0]!), claims: part(pieces[1]!), pieces };
  } catch {
    return undefined;
  }
}

/** The only accepted header: RS256 with a usable `kid`, no critical or unencoded payload extensions. */
export function rs256Header(header: Record<string, unknown>): header is Record<string, unknown> & { kid: string } {
  return (
    header.alg === "RS256" &&
    typeof header.kid === "string" &&
    header.kid.length > 0 &&
    header.kid.length <= 256 &&
    header.crit === undefined &&
    header.b64 === undefined
  );
}

/** `exp`, `iat` and an optional `nbf`, each within thirty seconds of skew. */
export function validJwtTime(c: Record<string, unknown>): boolean {
  const now = Date.now() / 1000;
  return (
    typeof c.exp === "number" &&
    Number.isFinite(c.exp) &&
    typeof c.iat === "number" &&
    Number.isFinite(c.iat) &&
    c.exp > c.iat &&
    c.exp > now - SKEW_SECONDS &&
    c.iat <= now + SKEW_SECONDS &&
    (c.nbf === undefined ||
      (typeof c.nbf === "number" && Number.isFinite(c.nbf) && c.nbf <= now + SKEW_SECONDS && c.nbf < c.exp))
  );
}

function readKeys(url: string, signal: AbortSignal): Promise<Map<string, JsonWebKey>> {
  return runEdge(authProgram<Map<string, JsonWebKey>>(readKeysNative, [url, signal]));
}
const readKeysNative = /* @__PURE__ */ registerAuth(readKeys, function (url: string, signal: AbortSignal) {
  return authFlow<Map<string, JsonWebKey>>(function* () {
    let response: Response | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const cancel = () => {
      void reader?.cancel().catch(() => {});
    };
    try {
      signal.throwIfAborted();
      response = (yield authFetch(url, {
        signal,
        redirect: "manual",
        headers: { Accept: "application/json" },
      })) as Response;
      signal.throwIfAborted();
      if (!response.ok || !response.body) throw new Error("JWKS unavailable");
      reader = response.body.getReader();
      signal.addEventListener("abort", cancel, { once: true });
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        signal.throwIfAborted();
        const { done, value } = (yield authInvoke(reader, "read", [])) as ReadableStreamReadResult<
          Uint8Array<ArrayBufferLike>
        >;
        signal.throwIfAborted();
        if (done) break;
        size += value.byteLength;
        if (size > 65536) throw new Error("JWKS too large");
        chunks.push(value);
      }
      const body = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.length;
      }
      const jwks: unknown = JSON.parse(decoder.decode(body));
      if (!record(jwks) || !Array.isArray(jwks.keys) || jwks.keys.length > 16) throw new Error("Invalid JWKS");
      const keys = new Map<string, JsonWebKey>();
      for (const key of jwks.keys) {
        if (
          !record(key) ||
          key.kty !== "RSA" ||
          (key.alg !== undefined && key.alg !== "RS256") ||
          (key.use !== undefined && key.use !== "sig") ||
          (key.key_ops !== undefined && (!Array.isArray(key.key_ops) || !key.key_ops.includes("verify"))) ||
          typeof key.kid !== "string" ||
          key.kid.length === 0 ||
          key.kid.length > 256 ||
          typeof key.n !== "string" ||
          typeof key.e !== "string" ||
          "d" in key
        )
          continue;
        const modulus = bytes(key.n);
        if (modulus.length < 256 || modulus.length > 512 || bytes(key.e).length > 8 || keys.has(key.kid)) {
          throw new Error("Invalid RSA key");
        }
        keys.set(key.kid, { kty: "RSA", n: key.n, e: key.e, alg: "RS256", ext: true, key_ops: ["verify"] });
      }
      if (keys.size === 0) throw new Error("No signing keys");
      return keys;
    } finally {
      signal.removeEventListener("abort", cancel);
      (yield authCatch(authInvoke(reader, "cancel", []), () => {})) as void | undefined;
      reader?.releaseLock();
      (yield authCatch(authInvoke(response?.body, "cancel", []), () => {})) as void | undefined;
    }
  });
});

/**
 * One bounded public-key cache for one JWKS URL; never retains request I/O or
 * promises. Keys live five minutes. An unknown `kid` against a fresh cache
 * refreshes at most once every thirty seconds, a failed fetch blocks further
 * fetches for thirty seconds, and at most two fetches run at once. The lookup
 * resolves the key, or undefined for an unknown `kid`; it throws
 * `KEY_FETCH_BUSY` or an unavailable error when it cannot read the set.
 */
export function jwksKeys(url: string): (kid: string, signal: AbortSignal) => Promise<JsonWebKey | undefined> {
  let cache: { expires: number; keys: Map<string, JsonWebKey> } | undefined;
  let refreshAfter = 0;
  let retryAfter = 0;
  let fetching = 0;

  function load(signal: AbortSignal): Promise<void> {
    return runEdge(authProgram<void>(loadNative, [signal]));
  }
  const loadNative = /* @__PURE__ */ registerAuth(load, function (signal: AbortSignal) {
    return authFlow<void>(function* () {
      if (fetching >= 2) throw KEY_FETCH_BUSY;
      if (Date.now() < retryAfter) throw new Error("JWKS unavailable");
      fetching++;
      try {
        const keys = (yield authCall(readKeys, [url, signal])) as Map<string, JsonWebKey>;
        signal.throwIfAborted();
        cache = { expires: Date.now() + CACHE_MS, keys };
      } catch {
        if (!signal.aborted) retryAfter = Date.now() + REFRESH_MS;
        throw new Error("JWKS unavailable");
      } finally {
        fetching--;
      }
    });
  });

  function key(kid: string, signal: AbortSignal): Promise<JsonWebKey | undefined> {
    return runEdge(authProgram<JsonWebKey | undefined>(keyNative, [kid, signal]));
  }
  const keyNative = /* @__PURE__ */ registerAuth(key, function (kid: string, signal: AbortSignal) {
    return authFlow<JsonWebKey | undefined>(function* () {
      const fresh = cache && cache.expires > Date.now();
      if (!fresh) (yield authCall(load, [signal])) as void;
      let found = cache?.keys.get(kid);
      if (!found && fresh && Date.now() >= refreshAfter) {
        refreshAfter = Date.now() + REFRESH_MS;
        (yield authCall(load, [signal])) as void;
        found = cache?.keys.get(kid);
      }
      return found;
    });
  });
  return key;
}

/** Verifies the signature over the JWT's signing input with the given public key. */
export function verifyRs256(jwt: DecodedJwt, key: JsonWebKey, signal: AbortSignal): Promise<boolean> {
  return runEdge(authProgram<boolean>(verifyRs256Native, [jwt, key, signal]));
}
const verifyRs256Native = /* @__PURE__ */ registerAuth(
  verifyRs256,
  function (jwt: DecodedJwt, key: JsonWebKey, signal: AbortSignal) {
    return authFlow<boolean>(function* () {
      const imported = (yield authInvoke(crypto.subtle, "importKey", [
        "jwk",
        key,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      ])) as CryptoKey;
      signal.throwIfAborted();
      const valid = (yield authInvoke(crypto.subtle, "verify", [
        "RSASSA-PKCS1-v1_5",
        imported,
        bytes(jwt.pieces[2]!),
        encoder.encode(`${jwt.pieces[0]}.${jwt.pieces[1]}`),
      ])) as boolean;
      signal.throwIfAborted();
      return valid;
    });
  },
);
