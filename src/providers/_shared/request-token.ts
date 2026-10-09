/** In-memory tokens and credential-bound login flights shared only inside one request. */
import { ConnectorCallError } from "../../errors.js";
import type { ConnectorContext } from "../../types.js";

interface MintedToken {
  accessToken: string;
  expiresAt: number;
}
interface TokenSource {
  /** Includes the complete credential identity; rotating either field changes the key. */
  key: string;
  mint(ctx: ConnectorContext): Promise<MintedToken>;
}
interface Flight {
  promise: Promise<string>;
  controller: AbortController;
  waiters: number;
  settled: boolean;
}
interface RequestTokens {
  initial?: Flight;
  recovery?: Flight;
}
const LOGIN_TIMEOUT_MS = 15_000;
const MAX_CACHED_TOKENS = 512;

/** Each provider instance owns its cache, so no credential crosses an API origin. */
export function requestTokenCache(source: (ctx: ConnectorContext) => Promise<TokenSource>) {
  const tokens = new Map<string, MintedToken>();
  const requests = new WeakMap<object, Map<string, RequestTokens>>();

  function start(auth: TokenSource, ctx: ConnectorContext): Flight {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new ConnectorCallError("unavailable", "Machine identity login timed out.")),
      LOGIN_TIMEOUT_MS,
    );
    const flight: Flight = { controller, waiters: 0, settled: false, promise: Promise.resolve("") };
    flight.promise = auth
      .mint({ ...ctx, signal: controller.signal })
      .then((minted) => {
        // An abandoned login must not seed a token after cancellation.
        controller.signal.throwIfAborted();
        tokens.delete(auth.key);
        tokens.set(auth.key, minted);
        while (tokens.size > MAX_CACHED_TOKENS) tokens.delete(tokens.keys().next().value!);
        return minted.accessToken;
      })
      .finally(() => {
        flight.settled = true;
        clearTimeout(timer);
      });
    // All waiters may cancel before the transport observes its abort.
    void flight.promise.catch(() => {});
    return flight;
  }

  async function follow(flight: Flight, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    flight.waiters++;
    let onAbort: (() => void) | undefined;
    try {
      const aborted = new Promise<never>((_, reject) => {
        if (!signal) return;
        onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
      });
      return await Promise.race([flight.promise, aborted]);
    } finally {
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      flight.waiters--;
      if (!flight.settled && flight.waiters === 0) flight.controller.abort();
    }
  }

  return {
    async token(ctx: ConnectorContext, rejected?: string): Promise<string> {
      ctx.signal?.throwIfAborted();
      const auth = await source(ctx);
      ctx.signal?.throwIfAborted();
      const cached = tokens.get(auth.key);
      if (cached && cached.accessToken !== rejected && cached.expiresAt > Date.now()) return cached.accessToken;
      const scope = ctx.requestScope ?? ctx;
      let perCredential = requests.get(scope);
      if (!perCredential) {
        perCredential = new Map();
        requests.set(scope, perCredential);
      }
      let request = perCredential.get(auth.key);
      if (!request) {
        request = {};
        perCredential.set(auth.key, request);
      }
      if (rejected !== undefined) {
        // Keep the recovery outcome for the request, including failures. Later
        // 401s can never turn this into a fresh-login loop.
        request.recovery ??= start(auth, ctx);
        return await follow(request.recovery, ctx.signal);
      }
      if (!request.initial || request.initial.settled || request.initial.controller.signal.aborted)
        request.initial = start(auth, ctx);
      return await follow(request.initial, ctx.signal);
    },
  };
}
