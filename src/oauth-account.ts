// Which downstream account a downstream OAuth consent may bind (#1381).
//
// An `api()` OAuth connector may declare `oauth.account`: a hook that learns,
// from a verified source, the account a code exchange signed into, and the
// accounts the deployment allows. Core runs the check in the callback, after
// the code exchange and before the grant is stored, so a refused account
// leaves no tokens behind. The allowed accounts are deployment config, read
// once at construction; nothing a request sends can widen them.
//
// Pure: rules, parsing and matching. `src/auth/static-oauth.ts` runs the
// check; `src/routes/oauth.ts` renders a refusal.

import { ConfigError } from "./config-schema.js";
import { validIdentityReference } from "./identity.js";
import type { AuthenticatedIdentity } from "./types.js";
import { isWorkspaceAddress } from "./workspace-address.js";

/**
 * One allowed account: an exact address (compared case-insensitively), or
 * `{ domain }`, any account the downstream attests belongs to that
 * organization's domain.
 */
export type OAuthAccountRule = string | { readonly domain: string };

/** One rule or several; any one of them allows the account. */
export type OAuthAccountRules = OAuthAccountRule | readonly OAuthAccountRule[];

/**
 * Personal grants: rules for everyone, or a map from a person to their rules.
 * A key is a bare principal id, resolved in the namespace of the deployment's
 * one interactive auth provider exactly as a pool member is; `"*"` is everyone
 * without their own entry. A person with no entry and no `"*"` cannot connect.
 */
export type OAuthPersonalAccounts = OAuthAccountRules | Readonly<Record<string, OAuthAccountRules>>;

/** What the downstream attests about the account a code exchange signed into. */
export interface OAuthAccount {
  /** The verified address. */
  address: string;
  /** The organization domain the downstream attests, such as Google's `hd`; absent for none. */
  domain?: string;
}

/** The tokens a code exchange returned, for `identify` to read. */
export interface OAuthExchangedTokens {
  accessToken: string;
  /** An OpenID Connect ID token, when the token response carried one. */
  idToken?: string;
}

/**
 * `api()` OAuth's account restriction: which downstream account a consent may
 * bind. Checked in the OAuth callback, after the code exchange and before the
 * grant is stored; a refused account stores nothing and revokes nothing.
 */
export interface ApiOAuthAccountCheck {
  /**
   * Learn, from a verified source, the account the code exchange signed into:
   * a signature-checked ID token, or the provider's account endpoint called
   * with the fresh access token. Throw when it cannot be learned; the
   * callback then stores nothing. Never trust an unverified claim.
   */
  identify(tokens: OAuthExchangedTokens, init: { signal: AbortSignal }): Promise<OAuthAccount>;
  /**
   * The accounts allowed to bind. A shared connector takes rules; a personal
   * one takes rules for everyone or a map from person to rules.
   */
  allow: OAuthPersonalAccounts;
}

/** A rule after construction: lowercased and trimmed. */
type ParsedRule = { kind: "address"; address: string } | { kind: "domain"; domain: string };

/** A checked restriction, ready to match. */
export interface AccountRestriction {
  readonly identify: ApiOAuthAccountCheck["identify"];
  /** Rules for everyone (shared, or personal without per-person entries, or `"*"`). */
  readonly everyone?: readonly ParsedRule[];
  /** Personal per-person rules, by bare principal id. */
  readonly people?: ReadonlyMap<string, readonly ParsedRule[]>;
}

const EVERYONE = "*";
/** A DNS name: labels of letters, digits and hyphens, with a dot. */
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === null || Object.getPrototypeOf(proto) === null;
}

/** `{ domain }` and nothing else. */
function isDomainRule(value: unknown): value is { domain: unknown } {
  return isPlainRecord(value) && Object.keys(value).length === 1 && Object.hasOwn(value, "domain");
}

function isRules(value: unknown): boolean {
  return typeof value === "string" || Array.isArray(value) || isDomainRule(value);
}

function parseRule(value: unknown, path: string): ParsedRule {
  if (typeof value === "string") {
    const address = value.trim();
    if (!isWorkspaceAddress(address)) throw new ConfigError(`${path} must be an email address or { domain }.`);
    return { kind: "address", address: address.toLowerCase() };
  }
  if (isDomainRule(value)) {
    const domain = typeof value.domain === "string" ? value.domain.trim().toLowerCase() : "";
    if (!DOMAIN.test(domain)) {
      throw new ConfigError(`${path}.domain must be a domain name without "@".`);
    }
    return { kind: "domain", domain };
  }
  throw new ConfigError(`${path} must be an email address or { domain }.`);
}

function parseRules(value: unknown, path: string): readonly ParsedRule[] {
  const list = Array.isArray(value) ? value : [value];
  if (list.length === 0) throw new ConfigError(`${path} is empty; list at least one account.`);
  return Object.freeze(list.map((rule, index) => parseRule(rule, Array.isArray(value) ? `${path}[${index}]` : path)));
}

/**
 * Check an account restriction at construction, for a connector of the given
 * auth scope. Throws a `ConfigError` naming the path on any malformed rule or
 * person key; never quotes a value it refused.
 */
export function accountRestriction(value: unknown, authScope: "shared" | "personal", path: string): AccountRestriction {
  if (!isPlainRecord(value)) throw new ConfigError(`${path} must be { identify, allow }.`);
  const { identify, allow } = value;
  if (typeof identify !== "function") {
    throw new ConfigError(`${path}.identify must be a function.`);
  }
  return Object.freeze({
    identify: identify as ApiOAuthAccountCheck["identify"],
    ...allowedAccounts(allow, authScope, `${path}.allow`),
  });
}

/**
 * Check the allowed accounts alone, for a provider that validates its own
 * option before building `oauth.account`. Throws a `ConfigError` naming `at`.
 */
export function allowedAccounts(
  allow: unknown,
  authScope: "shared" | "personal",
  at: string,
): Pick<AccountRestriction, "everyone" | "people"> {
  if (allow === undefined) throw new ConfigError(`${at} is required: the accounts this connection may bind.`);
  if (isRules(allow)) return { everyone: parseRules(allow, at) };
  if (authScope === "shared") {
    throw new ConfigError(`${at} for a shared connection is the one account's rules, not a map from person.`);
  }
  if (!isPlainRecord(allow)) throw new ConfigError(`${at} must be rules or a map from person to rules.`);
  const keys = Object.keys(allow);
  if (keys.length === 0) throw new ConfigError(`${at} is empty; list at least one person or "*".`);
  let everyone: readonly ParsedRule[] | undefined;
  const people = new Map<string, readonly ParsedRule[]>();
  for (const key of keys) {
    const rules = parseRules(allow[key], `${at}.${key}`);
    if (key === EVERYONE) {
      everyone = rules;
      continue;
    }
    if (key.startsWith("agent:")) {
      throw new ConfigError(`${at}.${key} names an agent; agents never use a personal connection.`);
    }
    if (key.includes(":") || !validIdentityReference({ namespace: "x", id: key })) {
      throw new ConfigError(`${at} keys must be bare principal ids without ":", or "*".`);
    }
    people.set(key, rules);
  }
  return {
    ...(everyone ? { everyone } : {}),
    ...(people.size ? { people } : {}),
  };
}

/**
 * Bare person keys resolve in the namespace of the deployment's one
 * interactive auth provider, as pool members do. Called by `createConnecta`
 * with the deployment's interactive namespaces; throws when they cannot.
 */
export function assertAccountPeopleResolve(
  restriction: AccountRestriction,
  interactiveNamespaces: ReadonlyArray<string | undefined>,
  path: string,
): void {
  if (!restriction.people) return;
  if (interactiveNamespaces.length !== 1 || interactiveNamespaces[0] === undefined) {
    throw new ConfigError(
      `${path} names people by bare principal id, which needs exactly one interactive auth provider with an activityActorNamespace.`,
    );
  }
}

/** The rules that apply to the person connecting, or undefined when none do. */
function rulesFor(
  restriction: AccountRestriction,
  identity: Readonly<AuthenticatedIdentity> | undefined,
): readonly ParsedRule[] | undefined {
  if (!restriction.people) return restriction.everyone;
  const principal = identity?.agent === undefined ? identity?.principal : undefined;
  return (principal && restriction.people.get(principal.id)) ?? restriction.everyone;
}

/** Whether one verified account satisfies one rule; case-insensitive. */
function matches(rule: ParsedRule, account: OAuthAccount): boolean {
  if (rule.kind === "address") return account.address.trim().toLowerCase() === rule.address;
  return typeof account.domain === "string" && account.domain.trim().toLowerCase() === rule.domain;
}

/** The expected account(s) for one person, as words for the callback page. */
function expectedText(rules: readonly ParsedRule[]): string {
  const words = rules.map((rule) => (rule.kind === "address" ? rule.address : `an account in ${rule.domain}`));
  return words.length <= 1 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} or ${words.at(-1)}`;
}

/**
 * A code exchange whose account could not be learned from a verified source:
 * a missing, unsigned or forged ID token, or an unreachable key set. Nothing
 * was stored. The cause stays with the error and is never rendered or logged.
 */
export class OAuthAccountUnverifiedError extends Error {
  constructor(cause: unknown) {
    super("The signed-in downstream account could not be verified.", { cause });
    this.name = "OAuthAccountUnverifiedError";
  }
}

/** A consent whose account the deployment does not allow; nothing was stored. */
export class OAuthAccountRefusedError extends Error {
  /**
   * The account(s) this person may connect, as configured, or undefined when
   * no account is allowed for them. Never the account actually used.
   */
  readonly expected: string | undefined;
  constructor(expected: string | undefined) {
    super("The signed-in downstream account is not allowed; nothing was stored.");
    this.name = "OAuthAccountRefusedError";
    this.expected = expected;
  }
}

/**
 * Check a verified account against the restriction for the person connecting
 * (`identity`, absent for a shared connection). Returns the address to keep as
 * the grant's label; throws `OAuthAccountRefusedError` otherwise.
 */
export function admitAccount(
  restriction: AccountRestriction,
  identity: Readonly<AuthenticatedIdentity> | undefined,
  account: OAuthAccount,
): string {
  const rules = rulesFor(restriction, identity);
  if (!rules) throw new OAuthAccountRefusedError(undefined);
  const address = typeof account?.address === "string" ? account.address.trim().toLowerCase() : "";
  if (!isWorkspaceAddress(address) || !rules.some((rule) => matches(rule, { ...account, address }))) {
    throw new OAuthAccountRefusedError(expectedText(rules));
  }
  return address;
}

/** The account refusal behind `error`, wherever it is wrapped. */
export function accountRefusalOf(error: unknown): OAuthAccountRefusedError | OAuthAccountUnverifiedError | undefined {
  const seen = new Set<unknown>();
  for (let current = error; current instanceof Error && !seen.has(current); current = current.cause) {
    if (current instanceof OAuthAccountRefusedError || current instanceof OAuthAccountUnverifiedError) return current;
    seen.add(current);
  }
  return undefined;
}

const restrictions = new WeakMap<object, AccountRestriction>();

/** Tag a connector with its account restriction, for construction-time checks. */
export function tagAccountRestriction<C extends object>(connector: C, restriction: AccountRestriction): C {
  restrictions.set(connector, restriction);
  return connector;
}

/** A tagged connector's restriction; walks the prototype chain, as wrappers inherit. */
export function accountRestrictionOf(connector: object): AccountRestriction | undefined {
  for (let current: object | null = connector; current; current = Object.getPrototypeOf(current) as object | null) {
    const restriction = restrictions.get(current);
    if (restriction) return restriction;
  }
  return undefined;
}
