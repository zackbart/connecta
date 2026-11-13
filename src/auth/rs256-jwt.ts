// RS256 JWT and JWKS verification shared by the built-in Vercel workload and
// Cloudflare Access assertion verifiers: Web APIs only, no SDK or platform import.
import { Duration, Effect, Exit } from "effect";
import { decodeBase64url } from "../bytes.js";
import { detach, fromSignal, runEdge, withDeadlineEffect } from "../runtime/run.js";
import { Settlement } from "../runtime/settlement.js";
import {
  authCall,
  authCatch,
  AuthenticationWork,
  authFetch,
  authFlow,
  authInvoke,
  authProgram,
  registerAuth,
} from "./native.js";

const CACHE_MS = 300_000;
const REFRESH_MS = 30_000;
// Under the five-second native authentication deadline, so the request that
// starts a fetch normally sees its outcome, and a hung fetch has failed and
// set its backoff before that request's deadline answers.
const FETCH_DEADLINE_MS = 4_000;
const RETRY_MS = 1_000;
const SKEW_SECONDS = 30;
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
 * One bounded public-key cache for one JWKS URL. Keys live five minutes. An
 * unknown `kid` against a fresh cache refreshes at most once every thirty
 * seconds. At most one fetch runs at a time, and every caller that needs the
 * set while it runs waits for that fetch under its own signal; only plain key
 * data and the outcome cross between requests. A failed fetch fails all of
 * its waiters together, and the next fetch starts no sooner than one second
 * after it, joined by everyone who arrives meanwhile. Each fetch runs to
 * completion under its own four-second deadline: a caller that leaves stops
 * waiting but neither cancels nor discards it, so disconnects cannot start
 * fetches faster than these bounds. A fetch still unsettled a second past its
 * deadline on the monotonic clock is replaced: its waiters wait for the
 * replacement, and its own late outcome is discarded. The lookup resolves the
 * key, or undefined for an unknown `kid`; it throws when it cannot read the set.
 */
export function jwksKeys(url: string): (kid: string, signal: AbortSignal) => Promise<JsonWebKey | undefined> {
  let cache: { expires: number; keys: Map<string, JsonWebKey> } | undefined;
  let refreshAfter = 0;
  let retryAfter = 0;
  let pending: { outcomes: Settlement<void, unknown>[]; abandonAfter: number } | undefined;

  function load(signal: AbortSignal): Promise<void> {
    return runEdge(authProgram<void>(loadNative, [signal]));
  }
  const loadNative = /* @__PURE__ */ registerAuth(load, function (signal: AbortSignal) {
    return Effect.flatMap(Effect.serviceOption(AuthenticationWork), (work) =>
      Effect.suspend(() => {
        if (signal.aborted) return Effect.fail(signal.reason);
        const now = Date.now();
        const elapsed = performance.now();
        // workerd drops a cancelled invocation's I/O without running its
        // callbacks, so a fetch that outlived every bound is no longer running.
        const superseded = pending && elapsed > pending.abandonAfter ? pending.outcomes : [];
        if (superseded.length > 0) pending = undefined;
        if (!pending) {
          const delay = Math.max(0, retryAfter - now);
          const outcome = new Settlement<void, unknown>();
          const started = {
            outcomes: [outcome, ...superseded],
            abandonAfter: elapsed + delay + FETCH_DEADLINE_MS + 1_000,
          };
          pending = started;
          const read = withDeadlineEffect((own) => authCall<Map<string, JsonWebKey>>(readKeys, [url, own]), {
            timeoutMs: FETCH_DEADLINE_MS,
            timeoutError: new Error("JWKS fetch timed out"),
          });
          // Detached from every caller: only its own deadline ends it. Every
          // exit, interruption included, records its outcome unless a newer
          // fetch has replaced it, and a replaced fetch changes nothing.
          const fetched = (delay > 0 ? Effect.sleep(Duration.millis(delay)).pipe(Effect.andThen(read)) : read).pipe(
            Effect.onExit((exit) =>
              Effect.sync(() => {
                if (pending !== started) return;
                pending = undefined;
                if (Exit.isSuccess(exit)) cache = { expires: Date.now() + CACHE_MS, keys: exit.value };
                else retryAfter = Date.now() + RETRY_MS;
                const result = Exit.isSuccess(exit) ? Exit.void : Exit.fail(new Error("JWKS unavailable"));
                for (const waiting of started.outcomes) waiting.settle(result);
              }),
            ),
          );
          // The starting request's authentication charge keeps every physical
          // read, and on Workers its waitUntil, until the fetch settles.
          const settlement = detach(
            work._tag === "Some" ? fetched.pipe(Effect.provideService(AuthenticationWork, work.value)) : fetched,
          );
          if (work._tag === "Some") work.value.track(settlement);
        }
        return Effect.raceAllFirst([pending.outcomes[0]!.wait(), fromSignal(signal)]);
      }),
    );
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
