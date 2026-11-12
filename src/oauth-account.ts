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
 * One person's entry in the list form: `person` is a principal reference as
 * pool members name people (a bare principal id, or `{ namespace, id }`), or
 * `"*"` for everyone without their own entry.
 */
export interface OAuthPersonAccounts {
  readonly person: string | Readonly<{ namespace: string; id: string }>;
  readonly accounts: OAuthAccountRules;
}

/**
 * Personal grants: rules for everyone, a map from person to rules, or a list
 * of `{ person, accounts }`. A map key is a bare principal id, resolved in the
 * namespace of the deployment's one interactive auth provider exactly as a
 * pool member is; the list form also takes `{ namespace, id }`. `"*"` is
 * everyone without their own entry. A person matches on namespace and id
 * both; one with no entry and no `"*"` cannot connect.
 */
export type OAuthPersonalAccounts =
  | OAuthAccountRules
  | Readonly<Record<string, OAuthAccountRules>>
  | readonly OAuthPersonAccounts[];

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
  /** Personal per-person rules, as configured; resolved by `createConnecta`. */
  readonly people?: readonly PersonRules[];
}

/** One person's rules: a bare id (needing the deployment's namespace) or an explicit reference. */
interface PersonRules {
  readonly person: string | { readonly namespace: string; readonly id: string };
  readonly rules: readonly ParsedRule[];
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

/** `{ person, accounts }` and nothing else. */
function isPersonEntry(value: unknown): value is { person: unknown; accounts: unknown } {
  return (
    isPlainRecord(value) &&
    Object.keys(value).length === 2 &&
    Object.hasOwn(value, "person") &&
    Object.hasOwn(value, "accounts")
  );
}

function isRules(value: unknown): boolean {
  return typeof value === "string" || (Array.isArray(value) && !value.some(isPersonEntry)) || isDomainRule(value);
}

/** A person reference as pool members take it, with `"*"`; never an agent. */
function parsePerson(value: unknown, at: string): PersonRules["person"] {
  if (typeof value === "string") {
    if (value === EVERYONE) return value;
    if (value.startsWith("agent:"))
      throw new ConfigError(`${at} names an agent; agents never use a personal connection.`);
    if (value.includes(":") || !validIdentityReference({ namespace: "x", id: value })) {
      throw new ConfigError(`${at} must be a bare principal id without ":", { namespace, id }, or "*".`);
    }
    return value;
  }
  if (
    isPlainRecord(value) &&
    Object.keys(value).length === 2 &&
    typeof value.namespace === "string" &&
    typeof value.id === "string" &&
    validIdentityReference({ namespace: value.namespace, id: value.id })
  ) {
    return Object.freeze({ namespace: value.namespace, id: value.id });
  }
  throw new ConfigError(`${at} must be a bare principal id without ":", { namespace, id }, or "*".`);
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
  const entries: Array<[unknown, unknown, string]> = [];
  if (Array.isArray(allow)) {
    if (!allow.every(isPersonEntry)) {
      throw new ConfigError(`${at} must list either rules or { person, accounts } entries, not both.`);
    }
    allow.forEach((entry, index) => entries.push([entry.person, entry.accounts, `${at}[${index}]`]));
  } else if (isPlainRecord(allow)) {
    for (const key of Object.keys(allow)) entries.push([key, allow[key], `${at}.${key}`]);
  } else {
    throw new ConfigError(`${at} must be rules, a map from person to rules, or a list of { person, accounts }.`);
  }
  if (entries.length === 0) throw new ConfigError(`${at} is empty; list at least one person or "*".`);
  let everyone: readonly ParsedRule[] | undefined;
  const people: PersonRules[] = [];
  const seen = new Set<string>();
  for (const [ref, accounts, path] of entries) {
    const person = parsePerson(ref, Array.isArray(allow) ? `${path}.person` : path);
    const rules = parseRules(accounts, Array.isArray(allow) ? `${path}.accounts` : path);
    const key = typeof person === "string" ? `bare\n${person}` : `ref\n${person.namespace}\n${person.id}`;
    if (seen.has(key)) throw new ConfigError(`${path} repeats an earlier person.`);
    seen.add(key);
    if (person === EVERYONE) everyone = rules;
    else people.push(Object.freeze({ person, rules }));
  }
  return {
    ...(everyone ? { everyone } : {}),
    ...(people.length ? { people: Object.freeze(people) } : {}),
  };
}

const principalKey = (namespace: string, id: string) => `${namespace}\n${id}`;

/** Each restriction's people by `{ namespace, id }`, once `createConnecta` resolved them. */
const resolutions = new WeakMap<AccountRestriction, ReadonlyMap<string, readonly ParsedRule[]>>();

/**
 * Resolve person keys to `{ namespace, id }`, as pool members resolve: a bare
 * id in the namespace of the deployment's one interactive auth provider. Called
 * by `createConnecta`; throws when a bare id cannot resolve, when two entries
 * name one person, or when the same connector was resolved differently for
 * another deployment.
 */
export function resolveAccountPeople(
  restriction: AccountRestriction,
  interactiveNamespaces: ReadonlyArray<string | undefined>,
  path: string,
): void {
  if (!restriction.people) return;
  const resolved = new Map<string, readonly ParsedRule[]>();
  for (const { person, rules } of restriction.people) {
    let key: string;
    if (typeof person === "string") {
      if (interactiveNamespaces.length !== 1 || interactiveNamespaces[0] === undefined) {
        throw new ConfigError(
          `${path} names a person by bare principal id, which needs exactly one interactive auth provider with an activityActorNamespace; write { namespace, id }.`,
        );
      }
      key = principalKey(interactiveNamespaces[0], person);
    } else key = principalKey(person.namespace, person.id);
    if (resolved.has(key)) throw new ConfigError(`${path} names one person twice.`);
    resolved.set(key, rules);
  }
  const earlier = resolutions.get(restriction);
  if (earlier && [...resolved].some(([key, rules]) => earlier.get(key) !== rules)) {
    throw new ConfigError(
      `${path} resolves differently in another deployment; give each deployment its own connector.`,
    );
  }
  resolutions.set(restriction, resolved);
}

/**
 * The people a restriction names. Before `createConnecta` resolves it, only
 * explicit `{ namespace, id }` entries count: a bare id matches nobody.
 */
function peopleOf(restriction: AccountRestriction): ReadonlyMap<string, readonly ParsedRule[]> {
  const resolved = resolutions.get(restriction);
  if (resolved) return resolved;
  const explicit = new Map<string, readonly ParsedRule[]>();
  for (const { person, rules } of restriction.people ?? [])
    if (typeof person !== "string") explicit.set(principalKey(person.namespace, person.id), rules);
  return explicit;
}

/**
 * The rules that apply to the person connecting, or undefined when none do.
 * A person matches on namespace and id both: the same id in another namespace
 * is someone else, who gets `"*"` or nothing.
 */
function rulesFor(
  restriction: AccountRestriction,
  identity: Readonly<AuthenticatedIdentity> | undefined,
): readonly ParsedRule[] | undefined {
  if (!restriction.people) return restriction.everyone;
  const principal = identity?.agent === undefined ? identity?.principal : undefined;
  const own = principal ? peopleOf(restriction).get(principalKey(principal.namespace, principal.id)) : undefined;
  return own ?? restriction.everyone;
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
