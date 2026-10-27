import { assertKnownOptions, ConfigError, keys, optionsOf } from "./config-schema.js";
import type { RequestToken } from "./request-token.js";
import {
  delegatedToken,
  forgetDelegatedToken,
  parseServiceAccount,
  type GoogleServiceAccount,
} from "./providers/_shared/google/service-account.js";

export type { GoogleServiceAccount } from "./providers/_shared/google/service-account.js";

export interface GoogleServiceAccountTokenOptions {
  /** The downloaded JSON key text, or its camelCase fields. Kept in deployment memory only. */
  serviceAccount: GoogleServiceAccount | string;
  /** Non-empty HTTPS OAuth scope URLs for the target API. */
  scopes: readonly string[];
  /** Optional Workspace user for domain-wide delegation; omitted means the account itself. */
  subject?: string;
}

const OPTIONS = optionsOf<GoogleServiceAccountTokenOptions>()(keys("serviceAccount", "scopes", "subject"));
const ACCOUNT = optionsOf<GoogleServiceAccount>()(keys("clientEmail", "privateKey", "clientId"));

/** Mint Google OAuth access tokens for remoteMcp's shared request auth on Node or Workers. */
export function googleServiceAccountToken(options: GoogleServiceAccountTokenOptions): RequestToken {
  const opts = assertKnownOptions(options, "googleServiceAccountToken", OPTIONS);
  let input = opts.serviceAccount;
  if (typeof input === "object" && input !== null) {
    input = assertKnownOptions(input, "googleServiceAccountToken.serviceAccount", ACCOUNT);
  }
  let account;
  try {
    account = parseServiceAccount("googleServiceAccountToken", input);
  } catch {
    // The legacy Workspace parser may quote a JSON credential's type. Never
    // reflect arbitrary credential-file fields through this public helper.
    throw new ConfigError(
      "googleServiceAccountToken.serviceAccount requires a valid Google service-account JSON key or { clientEmail, privateKey, clientId? } with a PKCS#8 RSA key of at least 2048 bits.",
    );
  }
  if (!Array.isArray(opts.scopes) || opts.scopes.length === 0 || !Array.from(opts.scopes).every(validScope)) {
    throw new ConfigError("googleServiceAccountToken.scopes must be a non-empty array of HTTPS OAuth scope URLs.");
  }
  if (opts.subject !== undefined && (typeof opts.subject !== "string" || !/^[^\s@]+@[^\s@]+$/.test(opts.subject))) {
    throw new ConfigError("googleServiceAccountToken.subject must be a Workspace email address when provided.");
  }
  const request = { account, subject: opts.subject, scopes: [...new Set(opts.scopes)] };
  const token: RequestToken = async (ctx) => await delegatedToken(request, ctx);
  token.invalidate = async (rejected) => await forgetDelegatedToken(request, rejected);
  return token;
}

function validScope(value: unknown): value is string {
  if (typeof value !== "string" || /\s/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}
