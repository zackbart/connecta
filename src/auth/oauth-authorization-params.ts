import { ConfigError } from "../config-schema.js";

/**
 * Protocol and security fields cannot be supplied through remote MCP extensions.
 * `response_mode` stays reserved: callbacks arrive only as GET query parameters.
 */
const RESERVED = new Set([
  "response_type",
  "response_mode",
  "client_id",
  "client_secret",
  "redirect_uri",
  "state",
  "code_challenge",
  "code_challenge_method",
  "scope",
  "resource",
  "request",
  "request_uri",
]);

/** Validate and snapshot non-secret browser-only parameters at construction. */
export function authorizationParamsFor(value: unknown, path: string): ReadonlyArray<readonly [string, string]> {
  if (value === undefined) return [];
  const invalid = (detail: string): never => {
    throw new ConfigError(`${path} ${detail}`);
  };
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid("must be a plain string map.");
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 32) invalid("must contain at most 32 parameters.");
  const names = new Set<string>();
  return entries
    .map(([name, entry]): readonly [string, string] => {
      if (!/^[A-Za-z0-9_.-]{1,128}$/.test(name))
        invalid("names must be 1–128 ASCII letters, digits, dots, underscores or hyphens.");
      const lower = name.toLowerCase();
      if (RESERVED.has(lower)) invalid(`may not set "${name}"; the authorization request owns it.`);
      if (names.has(lower)) invalid("must not contain case-variant duplicate names.");
      names.add(lower);
      if (
        typeof entry !== "string" ||
        !entry.trim() ||
        entry.length > 2048 ||
        Array.from(entry).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
      ) {
        invalid("values must be non-empty strings of at most 2048 code units without control characters.");
      }
      return [name, entry as string];
    })
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Google's authorization server, whose issuer is this exact origin. */
const GOOGLE_AUTHORIZATION_ORIGIN = "https://accounts.google.com";

/**
 * `access_type=offline` makes Google return a refresh token on first
 * authorization; without it a grant dies with its first access token.
 * `prompt=consent` makes Google issue one again when an already-granted user
 * reconnects or re-consents.
 */
const GOOGLE_DEFAULTS: ReadonlyArray<readonly [string, string]> = [
  ["access_type", "offline"],
  ["prompt", "consent"],
];

/**
 * The browser parameters one consent URL carries: the operator's, then any
 * provider default whose name the operator did not set (in any case) and the
 * URL does not already carry. Operator values always win.
 */
export function consentAuthorizationParams(
  authorizationUrl: URL,
  configured: ReadonlyArray<readonly [string, string]>,
): ReadonlyArray<readonly [string, string]> {
  if (authorizationUrl.origin !== GOOGLE_AUTHORIZATION_ORIGIN) return configured;
  const names = new Set(configured.map(([name]) => name.toLowerCase()));
  return [
    ...configured,
    ...GOOGLE_DEFAULTS.filter(([name]) => !names.has(name) && !authorizationUrl.searchParams.has(name)),
  ];
}
