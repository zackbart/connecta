import type {
  OAuthClientInformationMixed,
  OAuthDiscoveryState,
  OAuthTokens,
} from "@modelcontextprotocol/client";
import type { OAuthStateSealer } from "../oauth-sealing.js";
import { oauthV2Keys, type OAuthV2ValueKey } from "../storage/keys.js";
import type { KVStorage } from "../types.js";

// The one-shot reader of layout 2 (0.22 through 0.28), kept only until every
// deployment has opened its grants once under layout 3. A grant is read here
// the first time its owner's grant record is found absent, written as one
// record by compare-and-set, and only then are the layout 2 keys deleted.

/** A grant body as layout 3 stores it. */
export interface MigratedGrantBody {
  issuer?: string;
  client?: { value: OAuthClientInformationMixed; binding?: string; carried?: true };
  tokens?: OAuthTokens;
  discovery?: OAuthDiscoveryState;
}

export interface MigratedGrant {
  disconnected: boolean;
  body: MigratedGrantBody;
  /** Every layout 2 key the owner's namespace held, to delete once written. */
  keys: string[];
}

interface V2Value {
  value: unknown;
  issuer?: string;
  binding?: string;
  carried?: true;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** The issuer a discovery record names, as the SDK derives it. */
export function discoveryIssuer(state: unknown): string | undefined {
  if (!plainObject(state) || typeof state.authorizationServerUrl !== "string") return undefined;
  const metadata = state.authorizationServerMetadata;
  const issuer = plainObject(metadata) && typeof metadata.issuer === "string"
    ? metadata.issuer
    : state.authorizationServerUrl;
  return issuer === "" ? undefined : issuer;
}

/**
 * Layout 2's grant in this namespace, or nothing when it holds none.
 *
 * Only issuer-stamped envelopes (`connectaOAuthVersion: 2`, written since
 * v0.9.0) of the active generation are read; anything older, and any value
 * the vault cannot open, is left behind, as layout 2's own flow entry would
 * have retired it. A grant is kept only when every credential carries a
 * stamp, the stamps agree, and they name the server the generation's
 * discovery names, if any; otherwise it migrates empty and needs consent.
 * One-shot consent state (pending URL, verifier, state) is not carried.
 */
export async function readV2Grant(
  storage: KVStorage,
  sealer: OAuthStateSealer | undefined,
): Promise<MigratedGrant | undefined> {
  const v2 = oauthV2Keys.family.prefixes;
  const keys = (await storage.list(oauthV2Keys.scan)).filter((key) =>
    v2.some((prefix) => key.startsWith(prefix)),
  );
  if (keys.length === 0) return undefined;
  const generation = (await storage.get(oauthV2Keys.generation)) ?? "legacy";
  if (generation.startsWith("disconnected:")) return { disconnected: true, body: {}, keys };
  if (!generation.startsWith("v2:") && generation !== "legacy") {
    // An unfinished reset, or a numeric generation from before epochs.
    return { disconnected: false, body: {}, keys };
  }
  const epoch = generation === "legacy" ? null : generation;
  const read = async (field: OAuthV2ValueKey): Promise<V2Value | undefined> => {
    const physicalKey = oauthV2Keys.value(field, epoch);
    const raw = await storage.get(physicalKey);
    if (raw === null) return undefined;
    let parsed = parse(raw);
    if (plainObject(parsed) && parsed.connectaOAuthSealed === 1 && typeof parsed.sealed === "string") {
      if (!sealer) return undefined;
      try {
        parsed = parse(await sealer.open(physicalKey, parsed.sealed));
      } catch {
        return undefined;
      }
    }
    if (
      plainObject(parsed) &&
      parsed.connectaOAuthVersion === 2 &&
      parsed.generation === generation &&
      (parsed.issuer === undefined || typeof parsed.issuer === "string") &&
      (parsed.binding === undefined || typeof parsed.binding === "string")
    ) {
      return {
        value: parsed.value,
        ...(parsed.issuer !== undefined ? { issuer: parsed.issuer as string } : {}),
        ...(parsed.binding !== undefined ? { binding: parsed.binding as string } : {}),
        ...(parsed.carried === true ? { carried: true as const } : {}),
      };
    }
    // Layout 2 wrote discovery bare under the legacy generation.
    return field === oauthV2Keys.field.discovery && epoch === null && discoveryIssuer(parsed)
      ? { value: parsed }
      : undefined;
  };
  const [client, tokens, discovery] = await Promise.all([
    read(oauthV2Keys.field.client),
    read(oauthV2Keys.field.tokens),
    read(oauthV2Keys.field.discovery),
  ]);
  const named = discovery ? discoveryIssuer(discovery.value) : undefined;
  const credentials = [client, tokens].filter((value) => value !== undefined);
  const issuer = credentials[0]?.issuer ?? named;
  const consistent = credentials.every((value) =>
    value.issuer !== undefined && value.issuer === issuer && plainObject(value.value),
  ) && (named === undefined || named === issuer);
  if (!consistent || issuer === undefined) return { disconnected: false, body: {}, keys };
  return {
    disconnected: false,
    keys,
    body: {
      issuer,
      ...(client ? {
        client: {
          value: client.value as OAuthClientInformationMixed,
          ...(client.binding !== undefined ? { binding: client.binding } : {}),
          ...(client.carried ? { carried: true as const } : {}),
        },
      } : {}),
      ...(tokens ? { tokens: tokens.value as OAuthTokens } : {}),
      ...(discovery && named !== undefined ? { discovery: discovery.value as OAuthDiscoveryState } : {}),
    },
  };
}

/** Delete what `readV2Grant` found, once its grant record is stored. */
export async function deleteV2Keys(storage: KVStorage, keys: readonly string[]): Promise<void> {
  await Promise.allSettled(keys.map((key) => storage.delete(key)));
}
