// Built-in workload credentials: Web APIs only; no SDK or platform import.
import type { ResolvedAgent } from "../agent-config.js";
import { AGENT_NAMESPACE, agentSubjectId, trustAgentProvider } from "../agent-identity.js";
import { authenticationBusyResponse, withAuthenticationDeadline } from "../auth-admission.js";
import { authorizationCredential } from "../inbound-credential.js";
import type { AuthResult, InboundAuth, Logger } from "../types.js";

const ISSUER = "https://oidc.vercel.com";
const JWKS = `${ISSUER}/.well-known/jwks`;
const CACHE_MS = 300_000;
const REFRESH_MS = 30_000;
const SKEW_SECONDS = 30;
const KEY_FETCH_BUSY = Symbol("key fetch capacity reached");
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

function bytes(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+(?![\s\S])/.test(value)) throw new Error("Invalid JWT encoding");
  return Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0));
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function part(value: string): Record<string, unknown> {
  const decoded: unknown = JSON.parse(decoder.decode(bytes(value)));
  if (!record(decoded)) throw new Error("Invalid JWT object");
  return decoded;
}

function parsed(request: Request) {
  const credential = authorizationCredential(request);
  if (credential.kind !== "bearer" || credential.token.length > 16_384) return undefined;
  const pieces = credential.token.split(".");
  if (pieces.length !== 3) return undefined;
  try {
    return { header: part(pieces[0]!), claims: part(pieces[1]!), pieces };
  } catch {
    return undefined;
  }
}

/** Recognition reserves Vercel's issuer namespace; verification still checks exact values. */
export function isVercelAgentCredential(request: Request): boolean {
  const iss = parsed(request)?.claims.iss;
  return typeof iss === "string" && (iss === ISSUER || iss.startsWith(`${ISSUER}/`));
}

function denied(): AuthResult {
  return {
    ok: false,
    response: Response.json(
      { error: "unauthorized" },
      {
        status: 401,
        headers: { "WWW-Authenticate": "Bearer", "Cache-Control": "no-store" },
      },
    ),
  };
}

async function readKeys(signal: AbortSignal): Promise<Map<string, JsonWebKey>> {
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const cancel = () => {
    void reader?.cancel().catch(() => {});
  };
  try {
    signal.throwIfAborted();
    response = await fetch(JWKS, { signal, redirect: "manual", headers: { Accept: "application/json" } });
    signal.throwIfAborted();
    if (!response.ok || !response.body) throw new Error("JWKS unavailable");
    reader = response.body.getReader();
    signal.addEventListener("abort", cancel, { once: true });
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > 65_536) throw new Error("JWKS too large");
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
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
    await response?.body?.cancel().catch(() => {});
  }
}

/** One bounded public-key cache per deployment; never retains request I/O or promises. */
export function vercelAgentAuth(agents: readonly ResolvedAgent[], logger: Logger = console): InboundAuth | undefined {
  const bindings = agents.filter((agent) => agent.vercel);
  if (bindings.length === 0) return undefined;
  let cache: { expires: number; keys: Map<string, JsonWebKey> } | undefined;
  let refreshAfter = 0;
  let retryAfter = 0;
  let fetching = 0;

  async function load(signal: AbortSignal): Promise<void> {
    if (fetching >= 2) throw KEY_FETCH_BUSY;
    if (Date.now() < retryAfter) throw new Error("JWKS unavailable");
    fetching++;
    try {
      const keys = await readKeys(signal);
      signal.throwIfAborted();
      cache = { expires: Date.now() + CACHE_MS, keys };
    } catch {
      if (!signal.aborted) retryAfter = Date.now() + REFRESH_MS;
      throw new Error("JWKS unavailable");
    } finally {
      fetching--;
    }
  }

  return trustAgentProvider({
    kind: "vercel_oidc",
    activityActorNamespace: AGENT_NAMESPACE,
    recognizesCredential: isVercelAgentCredential,
    async authorize(request): Promise<AuthResult> {
      try {
        return await withAuthenticationDeadline(request, async (signal) => {
          const jwt = parsed(request);
          if (
            !jwt ||
            jwt.header.alg !== "RS256" ||
            typeof jwt.header.kid !== "string" ||
            jwt.header.kid.length === 0 ||
            jwt.header.kid.length > 256 ||
            jwt.header.crit !== undefined ||
            jwt.header.b64 !== undefined
          )
            return denied();
          const c = jwt.claims;
          const segment = (value: unknown, project = false): value is string =>
            typeof value === "string" &&
            (project ? /^[A-Za-z0-9._-]{1,128}(?![\s\S])/ : /^[A-Za-z0-9_-]{1,128}(?![\s\S])/).test(value);
          if (
            !segment(c.owner) ||
            !segment(c.project, true) ||
            !segment(c.owner_id) ||
            !segment(c.project_id) ||
            !segment(c.environment) ||
            c.external_sub !== undefined ||
            (c.iss !== ISSUER && c.iss !== `${ISSUER}/${c.owner}`) ||
            c.aud !== `https://vercel.com/${c.owner}` ||
            c.sub !== `owner:${c.owner}:project:${c.project}:environment:${c.environment}`
          )
            return denied();
          const agent = bindings.find(
            ({ vercel: v }) =>
              v &&
              v.team === c.owner_id &&
              v.project === (v.project.startsWith("prj_") ? c.project_id : c.project) &&
              v.environments.some((environment) => environment === c.environment),
          );
          if (!agent) return denied();
          const validTime = () => {
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
          };
          if (!validTime()) return denied();
          const fresh = cache && cache.expires > Date.now();
          if (!fresh) await load(signal);
          let key = cache?.keys.get(jwt.header.kid);
          if (!key && fresh && Date.now() >= refreshAfter) {
            refreshAfter = Date.now() + REFRESH_MS;
            await load(signal);
            key = cache?.keys.get(jwt.header.kid);
          }
          if (!key) return denied();
          const imported = await crypto.subtle.importKey(
            "jwk",
            key,
            { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
            false,
            ["verify"],
          );
          signal.throwIfAborted();
          const valid = await crypto.subtle.verify(
            "RSASSA-PKCS1-v1_5",
            imported,
            bytes(jwt.pieces[2]!),
            encoder.encode(`${jwt.pieces[0]}.${jwt.pieces[1]}`),
          );
          signal.throwIfAborted();
          if (!valid || !validTime()) return denied();
          return { ok: true, agent: agent.name, subjectId: agentSubjectId(agent.name) };
        });
      } catch (error) {
        if (error === KEY_FETCH_BUSY)
          return {
            ok: false,
            response: authenticationBusyResponse(logger),
          };
        return denied();
      }
    },
  });
}
