import { decodeBase64url } from "./bytes.js";
import { upwardStep } from "./upward.js";
import { authCall, authInvoke, authFlow, authStorage, registerAuth } from "./auth/native.js";
import { runEdge } from "./runtime/run.js";
import type { ServerOptions } from "./routes/shared.js";
import { oauthConnectKeys } from "./storage/keys.js";

const HANDOFF_TTL_MS = 15 * 60_000;
// A flow can issue a link until its ten-minute retry state ends, and that link lives
// fifteen more, so a reset's record outlives every link that could repeat it.
const FLOW_RESET_EXPIRY = { ttlSeconds: 30 * 60 };
const INTERACTIVE_OAUTH_REQUIRED =
  "An interactive provider (Clerk or Cloudflare Access) is required to connect OAuth connectors.";

interface Handoff {
  connector: string;
  owner: string;
  principal: string;
  origin: string;
  expiresAt: number;
  nonce: string;
  force: boolean;
  /** The first link of a forced flow, whose rounds share one reset. Absent on that link. */
  flow?: string;
}

// Length-prefixed fields avoid JSON keys and escaping without reserving any
// character in an identity. This is an opaque wire encoding, not encryption.
function encodeHandoff(h: Handoff): string {
  return [
    h.connector,
    h.owner,
    h.principal,
    h.origin,
    h.expiresAt.toString(36),
    h.nonce,
    h.force ? "1" : "0",
    h.flow ?? "",
  ]
    .map((field) => `${field.length}:${field}`)
    .join("");
}

function decodeHandoff(value: string): Handoff {
  const fields: string[] = [];
  let offset = 0;
  while (offset < value.length && fields.length < 8) {
    const colon = value.indexOf(":", offset);
    const lengthText = value.slice(offset, colon);
    if (colon < offset || !/^(0|[1-9][0-9]*)$/.test(lengthText)) throw new Error("Invalid handoff field");
    const length = Number(lengthText);
    offset = colon + 1;
    if (!Number.isSafeInteger(length) || length > value.length - offset) throw new Error("Invalid handoff length");
    fields.push(value.slice(offset, offset + length));
    offset += length;
  }
  const [connector, owner, principal, origin, expiry, nonce, force, flow] = fields;
  if (fields.length !== 8 || offset !== value.length || !/^[0-9a-z]+$/.test(expiry!) || !/^[01]$/.test(force!))
    throw new Error("Invalid handoff fields");
  return {
    connector: connector!,
    owner: owner!,
    principal: principal!,
    origin: origin!,
    expiresAt: parseInt(expiry!, 36),
    nonce: nonce!,
    force: force === "1",
    ...(flow ? { flow } : {}),
  };
}

function encodeSegment(value: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeSegment(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid handoff encoding");
  const decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(decodeBase64url(value));
  if (encodeSegment(decoded) !== value) throw new Error("Noncanonical handoff encoding");
  return decoded;
}

export function oauthConnectUnavailable(opts: Pick<ServerOptions, "config">): string | undefined {
  if (
    !opts.config.auth.some(
      (provider) =>
        provider.interactiveOperator &&
        (provider.uiAuth?.kind === "clerk" || provider.uiAuth?.kind === "cloudflare-access"),
    )
  ) {
    return INTERACTIVE_OAUTH_REQUIRED;
  }
  if (!opts.config.vault?.signOAuthHandoff || !opts.config.vault.verifyOAuthHandoff) {
    return "Connecting OAuth connectors requires a credential vault with a handoff signing key. Configure encryptedCredentialVault(storage, key).";
  }
  return undefined;
}

export function oauthConnectUrl(
  opts: ServerOptions,
  baseUrl: string,
  connectorId: string,
  principal: string | undefined,
  force = false,
  opaque = false,
): Promise<string> {
  return runEdge(oauthConnectUrlNative(opts, baseUrl, connectorId, principal, force, opaque));
}
const oauthConnectUrlNative = /* @__PURE__ */ registerAuth(
  oauthConnectUrl,
  function (
    opts: ServerOptions,
    baseUrl: string,
    connectorId: string,
    principal: string | undefined,
    force: boolean = false,
    opaque: boolean = false,
  ) {
    return authFlow<string>(function* () {
      return (yield* upwardStep(
        authCall<{ url: string; nonce: string }>(oauthConnectLink, [
          opts,
          baseUrl,
          connectorId,
          principal,
          force,
          opaque,
        ]),
      )).url;
    });
  },
);

export function oauthConnectLink(
  opts: ServerOptions,
  baseUrl: string,
  connectorId: string,
  principal: string | undefined,
  force = false,
  opaque = false,
  flow?: string,
): Promise<{ url: string; nonce: string }> {
  return runEdge(oauthConnectLinkNative(opts, baseUrl, connectorId, principal, force, opaque, flow));
}
const oauthConnectLinkNative = /* @__PURE__ */ registerAuth(
  oauthConnectLink,
  function (
    opts: ServerOptions,
    baseUrl: string,
    connectorId: string,
    principal: string | undefined,
    force: boolean = false,
    opaque: boolean = false,
    flow?: string,
  ) {
    return authFlow<{ url: string; nonce: string }>(function* () {
      const unavailable = oauthConnectUnavailable(opts);
      if (unavailable) throw new Error(unavailable);
      connectorId = opts.registry.grantOwner(connectorId);
      const connector = opts.registry.getConnector(connectorId);
      if (!connector || !principal) throw new Error("OAuth connection requires an initiating user identity.");
      const handoff: Handoff = {
        connector: connectorId,
        owner: connector.authScope === "personal" ? principal : "shared",
        principal,
        origin: new URL(baseUrl).origin,
        expiresAt: Date.now() + HANDOFF_TTL_MS,
        nonce: crypto.randomUUID(),
        force,
        ...(flow ? { flow } : {}),
      };
      const vault = opts.config.vault!;
      if (opaque && (!vault.seal || !vault.open))
        throw new Error("URL elicitation requires a sealing credential vault.");
      const compact = encodeHandoff(handoff);
      const payload = opaque
        ? `v4.${encodeSegment(yield* upwardStep(authInvoke<string>(vault, "seal", [connectorId, "connecta:connect-link:v4", compact])))}`
        : `v3.${encodeSegment(compact)}`;
      // Preserve the vault's entire signature and its representation, including
      // custom vaults, while keeping every URL segment unpadded base64url.
      const signature = encodeSegment(yield* upwardStep(authInvoke<string>(vault, "signOAuthHandoff", [payload])));
      const url = new URL(`/connect/${connectorId}`, baseUrl);
      url.searchParams.set("h", `${payload}.${signature}`);
      return { url: url.toString(), nonce: handoff.nonce };
    });
  },
);

/** A claim precedes OAuth reset; only a completed start can prove recovery. */
export function oauthConnectLinkStarted(
  opts: ServerOptions,
  baseUrl: string,
  id: string,
  nonce: string,
): Promise<boolean> {
  return runEdge(oauthConnectLinkStartedNative(opts, baseUrl, id, nonce));
}
const oauthConnectLinkStartedNative = /* @__PURE__ */ registerAuth(
  oauthConnectLinkStarted,
  function (opts: ServerOptions, baseUrl: string, id: string, nonce: string) {
    return authFlow<boolean>(function* () {
      return (
        (yield* upwardStep(
          authStorage<string | null>(opts.registry.contextFor(id, baseUrl).storage, "get", [
            oauthConnectKeys.used(nonce),
          ]),
        )) === "started"
      );
    });
  },
);

/** Consuming a round prevents replay from creating sibling retry lineages. */
export function claimAuthRetry(opts: ServerOptions, baseUrl: string, id: string, nonce: string): Promise<boolean> {
  return runEdge(claimAuthRetryNative(opts, baseUrl, id, nonce));
}
const claimAuthRetryNative = /* @__PURE__ */ registerAuth(
  claimAuthRetry,
  function (opts: ServerOptions, baseUrl: string, id: string, nonce: string) {
    return authFlow<boolean>(function* () {
      return yield* upwardStep(
        authStorage<boolean>(opts.registry.contextFor(id, baseUrl).storage, "compareAndSet", [
          oauthConnectKeys.retry(nonce),
          null,
          "used",
          { ttlSeconds: HANDOFF_TTL_MS / 1000 },
        ]),
      );
    });
  },
);

export function verifyOAuthHandoff(
  opts: ServerOptions,
  baseUrl: string,
  connectorId: string,
  token: string | null,
): Promise<Handoff | null> {
  return runEdge(verifyOAuthHandoffNative(opts, baseUrl, connectorId, token));
}
const verifyOAuthHandoffNative = /* @__PURE__ */ registerAuth(
  verifyOAuthHandoff,
  function (opts: ServerOptions, baseUrl: string, connectorId: string, token: string | null) {
    return authFlow<Handoff | null>(function* () {
      if (!token || token.length > 4096) return null;
      try {
        const parts = token.split(".");
        let h: Handoff;
        if (parts.length === 3 && (parts[0] === "v3" || parts[0] === "v4")) {
          const [version, body, signature] = parts;
          const payload = `${version}.${body}`;
          if (
            !(yield* upwardStep(
              authInvoke<boolean | undefined>(opts.config.vault, "verifyOAuthHandoff", [
                payload,
                decodeSegment(signature!),
              ]),
            ))
          )
            return null;
          const decoded = decodeSegment(body!);
          h = decodeHandoff(
            version === "v4"
              ? yield* upwardStep(
                  authInvoke<string>(opts.config.vault!, "open", [connectorId, "connecta:connect-link:v4", decoded]),
                )
              : decoded,
          );
        } else {
          // Keep pre-upgrade JSON and sealed v2 links until their original expiry.
          // Authenticate their exact original text; never normalize before verifying.
          const [payload, signature, ...rest] = parts;
          if (!payload || !signature || rest.length) return null;
          if (
            !(yield* upwardStep(
              authInvoke<boolean | undefined>(opts.config.vault, "verifyOAuthHandoff", [payload, signature]),
            ))
          )
            return null;
          h = JSON.parse(
            payload.startsWith("v2:")
              ? yield* upwardStep(
                  authInvoke<string>(opts.config.vault!, "open", [
                    connectorId,
                    "connecta:connect-link:v2",
                    atob(payload.slice(3)),
                  ]),
                )
              : atob(payload),
          );
          // A retired predecessor binding: nothing here can honor it, so it must not be ignored.
          if ("after" in h) return null;
        }
        const connector = opts.registry.getConnector(connectorId);
        if (
          !connector ||
          h.connector !== connectorId ||
          typeof h.principal !== "string" ||
          !h.principal ||
          h.owner !== (connector.authScope === "personal" ? h.principal : "shared") ||
          h.origin !== new URL(baseUrl).origin ||
          !Number.isSafeInteger(h.expiresAt) ||
          h.expiresAt <= Date.now() ||
          h.expiresAt > Date.now() + HANDOFF_TTL_MS ||
          typeof h.nonce !== "string" ||
          !h.nonce ||
          typeof h.force !== "boolean"
        )
          return null;
        if (
          h.flow !== undefined &&
          (typeof h.flow !== "string" || !/^[a-f0-9-]{36}$/.test(h.flow) || h.flow === h.nonce || !h.force)
        )
          return null;
        if (
          yield* upwardStep(
            authStorage<string | null>(opts.registry.contextFor(connectorId, baseUrl).storage, "get", [
              oauthConnectKeys.used(h.nonce),
            ]),
          )
        )
          return null;
        return h;
      } catch {
        return null;
      }
    });
  },
);

/**
 * Claim only after browser identity and permissions pass, before starting OAuth.
 * A forced flow resets once, whichever of its links arrives first. A later visitor
 * continues that attempt, waits on it without spending its link, or, once it has
 * failed, takes over the reset.
 */
export function claimOAuthConnectStart(
  opts: ServerOptions,
  handoff: Handoff,
): Promise<"reset" | "continue" | "pending" | "refused"> {
  return runEdge(claimOAuthConnectStartNative(opts, handoff));
}
const claimOAuthConnectStartNative = /* @__PURE__ */ registerAuth(
  claimOAuthConnectStart,
  function (opts: ServerOptions, handoff: Handoff) {
    return authFlow<"reset" | "continue" | "pending" | "refused">(function* () {
      if (handoff.expiresAt <= Date.now()) return "refused";
      const storage = opts.registry.contextFor(handoff.connector, handoff.origin).storage;
      const reset = handoff.force ? oauthConnectKeys.reset(handoff.flow ?? handoff.nonce) : undefined;
      const prior = reset ? yield* upwardStep(authStorage<string | null>(storage, "get", [reset])) : "started";
      if (prior === "used") return "pending";
      const claiming = prior !== "started";
      if (
        claiming &&
        !(yield* upwardStep(authStorage<boolean>(storage, "compareAndSet", [reset!, prior, "used", FLOW_RESET_EXPIRY])))
      )
        return "pending";
      const expiry = { ttlSeconds: Math.max(1, Math.ceil((handoff.expiresAt - Date.now()) / 1000)) };
      if (
        yield* upwardStep(
          authStorage<boolean>(storage, "compareAndSet", [oauthConnectKeys.used(handoff.nonce), null, "used", expiry]),
        )
      )
        return claiming ? "reset" : "continue";
      if (claiming)
        yield* upwardStep(authStorage<boolean>(storage, "compareAndSet", [reset!, "used", prior, FLOW_RESET_EXPIRY]));
      return "refused";
    });
  },
);

/** Terminal marker only after the start and every tracked reset have settled. */
export function finishOAuthConnectStart(
  opts: ServerOptions,
  handoff: Handoff,
  outcome: "started" | "failed",
): Promise<boolean> {
  return runEdge(finishOAuthConnectStartNative(opts, handoff, outcome));
}
const finishOAuthConnectStartNative = /* @__PURE__ */ registerAuth(
  finishOAuthConnectStart,
  function (opts: ServerOptions, handoff: Handoff, outcome: "started" | "failed") {
    return authFlow<boolean>(function* () {
      const storage = opts.registry.contextFor(handoff.connector, handoff.origin).storage;
      // Settled first, and whatever the link's expiry: a finished link proves its flow's
      // reset finished, and only the visitor who claimed a reset can find it still claimed.
      if (handoff.force)
        yield* upwardStep(
          authStorage<boolean>(storage, "compareAndSet", [
            oauthConnectKeys.reset(handoff.flow ?? handoff.nonce),
            "used",
            outcome,
            FLOW_RESET_EXPIRY,
          ]),
        );
      if (handoff.expiresAt <= Date.now()) return false;
      const expiry = { ttlSeconds: Math.max(1, Math.ceil((handoff.expiresAt - Date.now()) / 1000)) };
      return yield* upwardStep(
        authStorage<boolean>(storage, "compareAndSet", [oauthConnectKeys.used(handoff.nonce), "used", outcome, expiry]),
      );
    });
  },
);
