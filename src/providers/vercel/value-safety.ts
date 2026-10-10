// Value safety for Vercel's REST connector (decision 0005, "Value safety").
//
// No tool response, success or error, returns a credential (API, service, or
// bypass tokens, signing secrets, deploy-hook and other bearer URLs, private
// keys, authorization verifiers, auth headers) or a stored secret value
// (environment variables, Global Config items), unless a reviewed named tool
// exists to return it. Three layers, strongest first:
//
// 1. Refuse by operation. `scripts/value-safety.mjs` flags every operation in
//    the pinned spec whose response may carry one (committed as
//    `value-safety.candidates.json`); each needs a verdict here, and
//    `value-safety.node.test.ts` fails on any flagged operation without one.
// 2. Reviewed field paths for `redact` verdicts, applied to every success body
//    on every path (generic tools, HEAD data, named tools, logs, uploads)
//    before cursors or `select` read it. Secret-family operations (`refuse`
//    and `redact`) also answer failures with fixed messages, never the
//    vendor's text.
// 3. A key-name heuristic, defense in depth only, over every body: any
//    subtree under a credential-named key, labelled key/value records whose
//    label is credential-named, environment-variable containers, and URLs with
//    userinfo or credential query parameters.
//
// Residual risk, as with Infisical: a secret a person typed into a free-text
// name, description, log line, or identifier is out of scope.

/** What a removed secret reads as. */
export const REDACTED = "[redacted]";

/** Credential vocabulary over normalized names; mirrors `scripts/value-safety.mjs`. */
export const CREDENTIAL_WORDS = [
  "token",
  "secret",
  "password",
  "passphrase",
  "privatekey",
  "apikey",
  "accesskey",
  "authorization",
  "cookie",
  "signature",
  "jwt",
  "credential",
  "bypass",
  "verifier",
  "devicecode",
  "authcode",
  "keyvalue",
  "invitecode",
  "joincode",
  "claimcode",
  "transfercode",
  "accesscode",
];

/** Suffixes of metadata about a credential (ids, prefixes, last four, counts, expiry, scopes); mirrors the script. */
export const METADATA_SUFFIXES = [
  "id",
  "ids",
  "prefix",
  "suffix",
  "lastfour",
  "lastfourchars",
  "count",
  "type",
  "types",
  "name",
  "names",
  "at",
  "expiry",
  "expires",
  "scope",
  "scopes",
  "enabled",
  "changed",
  "protection",
  "details",
  "length",
  "mode",
  "kind",
  "status",
];

/** Exact metadata names that contain a credential word; mirrors the script. */
export const METADATA_NAMES = [
  "partialkeyvalue",
  "partialkey",
  "inputtokens",
  "outputtokens",
  "totaltokens",
  "cachecreationinputtokens",
  "cachereadinputtokens",
  "usedapptoken",
  "includesrefreshtoken",
  "hasauthorizationdetails",
  "tokensdeleted",
  "istokenexpired",
  "tokenclaims",
  "oidctokenclaims",
  "preauthorizationamount",
  "secretrotation",
  "secretssync",
  "strictpasswordprotectionsettings",
  "disjunctiveproductionsecretpolicy",
  "stripesharedpaymenttokenused",
  "bypassall",
  "bypasssystem",
];

/** Keys whose contents are environment variables, whatever their `key` or `type` says. */
const ENV_CONTAINERS = ["env", "envs", "envvar", "envvars", "newenvvar", "oldenvvar", "sharedenvvar", "sharedenvvars"];
const ENV_VALUE_FIELDS = ["value", "vsmValue", "legacyValue", "decryptedValue"];
/** Query parameters that carry a credential in a URL. */
const URL_CREDENTIAL_PARAMS = /token|secret|password|passwd|signature|^sig$|key|auth|code|jwt|credential|bypass/i;

type JsonRecord = Record<string, unknown>;

export type ValueSafetyVerdict =
  | { readonly verdict: "refuse"; readonly reason: string }
  | {
      readonly verdict: "redact";
      readonly reason: string;
      /**
       * Reviewed field paths: `a.b`, `[]` for list items, `{}` for every value of
       * a map, `@keys` for a map keyed by secrets (keys become placeholders),
       * `url:` to sanitize a URL, `origin:` to keep only a URL's scheme and
       * host, `[?env]` for list items whose `type` names an environment
       * variable, `[?credential]` for list items labelled with a credential
       * name (`key`, `name`, or `target.key`), and `[?header]` for header,
       * cookie, or query rules. Every value at a path becomes
       * `[redacted]`.
       */
      readonly paths: readonly string[];
      /** Paths whose names the heuristic must not treat as credentials. */
      readonly allow?: readonly string[];
    }
  | { readonly verdict: "safe"; readonly reason: string; readonly allow?: readonly string[] };

const refuse = (reason: string): ValueSafetyVerdict => ({ verdict: "refuse", reason });
const redact = (reason: string, paths: readonly string[], allow: readonly string[] = []): ValueSafetyVerdict => ({
  verdict: "redact",
  reason,
  paths,
  ...(allow.length ? { allow } : {}),
});
const safe = (reason: string, allow: readonly string[] = []): ValueSafetyVerdict => ({
  verdict: "safe",
  reason,
  ...(allow.length ? { allow } : {}),
});

/** Paths under each prefix. */
function under(prefixes: readonly string[], paths: readonly string[]): string[] {
  return prefixes.flatMap((prefix) =>
    paths.map((path) => {
      if (!prefix) return path;
      // A directive (`url:`, `origin:`) stays in front of the whole path.
      const directive = /^(?:url|origin):/.exec(path)?.[0] ?? "";
      return `${directive}${prefix}.${path.slice(directive.length)}`;
    }),
  );
}

/** A project object: env values, deploy hooks, and protection-bypass secrets. */
const PROJECT = [
  "env[].value",
  "env[].vsmValue",
  "env[].legacyValue",
  "link.deployHooks[].url",
  "protectionBypass@keys",
];
/** Project metadata whose names contain a credential word. */
const PROJECT_ALLOW = [
  "protectionBypass",
  "oidcTokenConfig",
  "security.firewallBypassIps",
  "usageStatus.bypassThrottleUntil",
];
const DRAIN = [
  "delivery.secret",
  "delivery.headers{}",
  "origin:delivery.endpoint",
  "origin:delivery.endpoint.traces",
  "secret",
  "headers{}",
  "origin:url",
];
const SHARED_ENV = ["data[].value", "created[].value", "updated[].value", "failed[].error.value"];
const PROJECT_ENV = ["value", "legacyValue", "vsmValue", "[].value", "[].legacyValue"];
const CONNECTOR_ALLOW = ["appTokens", "userTokens"];
const PROJECT_REASON = "Project objects embed environment values, deploy hook URLs, and protection-bypass secrets.";
const DRAIN_REASON =
  "Drains store destination credentials (headers, URLs whose path or query can be a bearer secret) and a signing secret.";
const WEBHOOK = ["secret", "origin:url"];
const WEBHOOK_REASON = "Webhooks carry a signing secret and a destination URL whose path can be a bearer secret.";
/** Route rules: a transform that sets a credential-named header carries the credential in `args`. */
/**
 * Route rules: every header, cookie, or query transform's `args` and every
 * header, cookie, or query condition's `value` go, whatever the target key's
 * form (a string, or a predicate object such as `{ eq: "Authorization" }`);
 * a header-name list would always miss one (`X-Auth-Key`).
 */
const ROUTE_TRANSFORMS = ["transforms[].args", "has[?header].value", "missing[?header].value"];
const DEPLOYMENT = [
  ...under(["routes[]", "services[].routes[]", "services[].rewrites[]", "services[].redirects[]"], ROUTE_TRANSFORMS),
  "services[].headers[].headers[].value",
];
const DEPLOYMENT_REASON =
  "Deployment routes can set credential-named headers (transforms with target.key Authorization) whose args are the credential.";
const ROUTE_REASON = "Route transforms can set credential-named headers whose args are the credential.";
const ENV_REASON = "Environment-variable bodies carry decrypted or encrypted values.";
const NO_SECRET_REASON = "Answers status or nothing; the flag is the operation's name, not its response.";
const EDGE_ITEMS =
  "returns Global Config item values, which may be secrets; read them from your application with the Edge Config SDK.";
const MINT = "mints a credential and returns it in cleartext.";
const MODEL_CONFIG = "AI Gateway routing configuration; its descriptions mention tokens as model usage units.";
const KMS_POLICY = "Issuer policies name environments and claims; signing keys stay with Vercel.";
/** A firewall rule's header, cookie, and query conditions: their values can be credentials (an `X-Auth-Key` match). */
const FIREWALL_CONDITIONS = [
  "conditionGroup[].conditions[?header].value",
  "conditionGroup[].conditions[?header].values",
];
/** Every firewall config shape: rules, rulesets, and top-level conditions, active, draft, and versions. */
const FIREWALL = under(["rules[]", "rulesets[]", "conditions[]"], FIREWALL_CONDITIONS);
const FIREWALL_REASON =
  "Firewall rules match header, cookie, and query values, which can be credentials a rule checks for (an X-Auth-Key).";
const TEAM_INVITE = "Teams carry inviteCode, which lets its holder join the team (visible to owners).";

/**
 * The reviewed verdict for every flagged operation, keyed `METHOD /path`.
 * `refuse` is never sent by the generic tools; named tools that need one of
 * these operations project it themselves (value-safe environment variables).
 */
export const VALUE_SAFETY: Readonly<Record<string, ValueSafetyVerdict>> = {
  "PATCH /aliases/{id}/protection-bypass": refuse("creates a shareable link that bypasses Deployment Protection."),
  "POST /api-keys": refuse("mints an AI Gateway API key and returns it in cleartext."),
  "POST /v1/connect/authorize/{connector}": refuse(
    "starts a Connect authorization for a caller-chosen subject and returns its verifier and device code.",
  ),
  "POST /v1/connect/connectors": safe(
    "Connector capability metadata; appTokens and userTokens describe grants, not tokens.",
    CONNECTOR_ALLOW,
  ),
  "GET /v1/connect/connectors/{connector}": safe("Connector capability metadata.", CONNECTOR_ALLOW),
  "POST /v1/connect/connectors/{connector}/managed/eject": safe("Connector capability metadata.", CONNECTOR_ALLOW),
  "PATCH /v1/connect/connectors/{connector}/trigger-destinations": safe(
    "Connector capability metadata.",
    CONNECTOR_ALLOW,
  ),
  "GET /v2/connect/connectors": safe("Connector capability metadata.", under(["connectors[]"], CONNECTOR_ALLOW)),
  "PATCH /v2/connect/connectors/{connector}": safe(
    "Connector capability metadata.",
    under(["connector"], CONNECTOR_ALLOW),
  ),
  "POST /v1/connect/token/{connector}": refuse("mints a token for a Connect connector."),
  "GET /v1/drains": redact(DRAIN_REASON, under(["drains[]"], DRAIN)),
  "POST /v1/drains": redact(DRAIN_REASON, DRAIN),
  "POST /v1/drains/test": redact("Answers a delivery test; treated as part of the drain family.", DRAIN),
  "GET /v1/drains/{id}": redact(DRAIN_REASON, DRAIN),
  "PATCH /v1/drains/{id}": redact(DRAIN_REASON, DRAIN),
  "DELETE /v1/drains/{id}": safe(NO_SECRET_REASON),
  "GET /v1/log-drains": redact(DRAIN_REASON, under(["drains[]", "[]"], DRAIN)),
  "POST /v1/log-drains": redact(DRAIN_REASON, DRAIN),
  "GET /v1/log-drains/{id}": redact(DRAIN_REASON, DRAIN),
  "DELETE /v1/log-drains/{id}": safe(NO_SECRET_REASON),
  "GET /v2/integrations/log-drains": redact(DRAIN_REASON, under(["[]"], DRAIN)),
  "POST /v2/integrations/log-drains": redact(DRAIN_REASON, DRAIN),
  "DELETE /v1/integrations/log-drains/{id}": safe(NO_SECRET_REASON),
  "GET /v1/webhooks": redact(WEBHOOK_REASON, under(["[]", "webhooks[]"], WEBHOOK)),
  "POST /v1/webhooks": redact(WEBHOOK_REASON, WEBHOOK),
  "GET /v1/webhooks/{id}": redact(WEBHOOK_REASON, WEBHOOK),
  "DELETE /v1/webhooks/{id}": safe(NO_SECRET_REASON),
  "GET /v1/env": redact(ENV_REASON, SHARED_ENV),
  "POST /v1/env": redact(ENV_REASON, SHARED_ENV),
  "PATCH /v1/env": redact(ENV_REASON, SHARED_ENV),
  "DELETE /v1/env": redact(ENV_REASON, SHARED_ENV),
  "GET /v1/env/{id}": refuse("returns a shared environment variable's decrypted value."),
  "PATCH /v1/env/{id}/unlink/{projectId}": redact(ENV_REASON, ["value"]),
  "GET /v1/global-config": safe("Global Config metadata: ids, slugs, sizes, and digests, without items."),
  "POST /v1/global-config": safe("Answers the created Global Config's metadata."),
  "GET /v1/global-config/{edgeConfigId}": safe("Global Config metadata without items."),
  "PUT /v1/global-config/{edgeConfigId}": safe("Answers the updated Global Config's metadata."),
  "DELETE /v1/global-config/{edgeConfigId}": safe(NO_SECRET_REASON),
  "GET /v1/global-config/{edgeConfigId}/backups": safe("Lists backup versions and sizes, without items."),
  "GET /v1/global-config/{edgeConfigId}/backups/{edgeConfigBackupVersionId}": refuse(EDGE_ITEMS),
  "POST /v1/global-config/{edgeConfigId}/backups/{edgeConfigBackupVersionId}/restore": safe(NO_SECRET_REASON),
  "GET /v1/global-config/{edgeConfigId}/item/{edgeConfigItemKey}": refuse(EDGE_ITEMS),
  "GET /v1/global-config/{edgeConfigId}/items": refuse(EDGE_ITEMS),
  "PATCH /v1/global-config/{edgeConfigId}/items": safe("Answers a status; item values are write input only."),
  "GET /v1/global-config/{edgeConfigId}/schema": safe("A JSON Schema for items, without values."),
  "POST /v1/global-config/{edgeConfigId}/schema": safe("Answers the schema, without values."),
  "DELETE /v1/global-config/{edgeConfigId}/schema": safe(NO_SECRET_REASON),
  "POST /v1/global-config/{edgeConfigId}/token": refuse(MINT),
  "GET /v1/global-config/{edgeConfigId}/token/{token}": refuse("returns a Global Config read token."),
  "GET /v1/global-config/{edgeConfigId}/tokens": refuse("returns every Global Config read token in cleartext."),
  "DELETE /v1/global-config/{edgeConfigId}/tokens": safe(NO_SECRET_REASON),
  "GET /v1/installations/{integrationConfigurationId}/resources/{resourceId}/experimentation/global-config":
    refuse(EDGE_ITEMS),
  "PUT /v1/installations/{integrationConfigurationId}/resources/{resourceId}/experimentation/global-config": redact(
    "Answers the synced Global Config, items included; item values can be secrets.",
    ["items"],
  ),
  "HEAD /v1/installations/{integrationConfigurationId}/resources/{resourceId}/experimentation/global-config": safe(
    "Headers only; the heuristic still covers them.",
  ),
  "POST /v1/installations/{integrationConfigurationId}/credentials/revoke": safe(NO_SECRET_REASON),
  "POST /v1/installations/{integrationConfigurationId}/credentials/rotate": refuse(
    "rotates an installation credential and returns the new access token.",
  ),
  "PUT /v1/installations/{integrationConfigurationId}/resources/{resourceId}/secrets": safe(
    "Answers nothing; secrets are write input only.",
  ),
  "POST /v1/integrations/sso/token": refuse("exchanges an integration SSO code for access, ID, and refresh tokens."),
  "POST /v1/kms/issuers/{issuerId}/keys": safe(
    "Answers public key material and key metadata; private keys stay with Vercel.",
  ),
  "POST /v1/kms/issuers/{issuerId}/keys/{keyId}/activate": safe("Answers key metadata."),
  "POST /v1/kms/issuers/{issuerId}/keys/{keyId}/revoke": safe(
    "Answers issuer metadata; tokenClaims are policy, not tokens.",
  ),
  "POST /v1/kms/issuers/{issuerId}/sign/message": refuse(
    "signs a message with the issuer's private key, acting as the organization.",
  ),
  "POST /v1/kms/issuers/{issuerId}/sign/token": refuse("signs a token with the issuer's private key."),
  "GET /v1/microfrontends/groups/{groupId}/projects": redact(
    PROJECT_REASON,
    under(["projects[]"], PROJECT),
    under(["projects[]"], PROJECT_ALLOW),
  ),
  "POST /v1/projects/traces/session": refuse("mints a trace session token for a deployment."),
  "POST /v1/projects/{idOrName}/avatar": redact(PROJECT_REASON, PROJECT, PROJECT_ALLOW),
  "DELETE /v1/projects/{idOrName}/avatar": redact(PROJECT_REASON, PROJECT, PROJECT_ALLOW),
  "DELETE /v1/projects/{idOrName}/env": redact(ENV_REASON, PROJECT_ENV),
  "GET /v1/projects/{idOrName}/env/{id}": refuse(
    "returns one environment variable's decrypted value. Read its metadata with list_project_env_vars.",
  ),
  "PATCH /v1/projects/{idOrName}/protection-bypass": refuse("generates Protection Bypass for Automation secrets."),
  "POST /v1/projects/{idOrName}/token": refuse("mints a project OIDC token."),
  "GET /v1/projects/{projectIdOrName}/feature-flags/sdk-keys": safe(
    "Lists SDK key metadata with masked partialKeyValue.",
  ),
  "PUT /v1/projects/{projectIdOrName}/feature-flags/sdk-keys": refuse(
    "mints a Flags SDK key and returns it in cleartext.",
  ),
  "DELETE /v1/projects/{projectIdOrName}/feature-flags/sdk-keys/{hashKey}": safe(NO_SECRET_REASON),
  "PATCH /v1/projects/{projectId}/microfrontends": redact(PROJECT_REASON, PROJECT, PROJECT_ALLOW),
  "GET /v1/projects/{projectId}/routes": redact(ROUTE_REASON, under(["routes[].route"], ROUTE_TRANSFORMS)),
  "POST /v1/projects/{projectId}/routes": redact(ROUTE_REASON, under(["route.route"], ROUTE_TRANSFORMS)),
  "POST /v1/projects/{projectId}/routes/generate": redact(ROUTE_REASON, [
    ...under(["route"], ROUTE_TRANSFORMS),
    "route.actions[].headers[].value",
    "route.conditions[?header].value",
  ]),
  "PATCH /v1/projects/{projectId}/routes/{routeId}": redact(ROUTE_REASON, under(["route.route"], ROUTE_TRANSFORMS)),
  "GET /v1/registrar/domains/{domain}/auth-code": refuse(
    "returns the domain's transfer authorization code, which lets its holder move the domain to another registrar.",
  ),
  "GET /v1/security/firewall/bypass": safe("IP bypass rules are firewall configuration: addresses, not secrets."),
  "POST /v1/security/firewall/bypass": safe("IP bypass rules are firewall configuration."),
  "DELETE /v1/security/firewall/bypass": safe("IP bypass rules are firewall configuration."),
  "GET /v1/security/firewall/config": redact(FIREWALL_REASON, under(["active", "draft", "versions[]"], FIREWALL)),
  "PUT /v1/security/firewall/config": redact(FIREWALL_REASON, under(["active", "draft", "versions[]"], FIREWALL)),
  "POST /v1/security/firewall/config/generate-rule": redact(FIREWALL_REASON, under(["rule"], FIREWALL_CONDITIONS)),
  "GET /v1/security/firewall/config/{configVersion}": redact(FIREWALL_REASON, FIREWALL),
  "POST /v1/security/firewall/config/{configVersion}/activate": redact(FIREWALL_REASON, FIREWALL),
  "POST /v1/storage/stores/integration/direct": safe("store.secrets lists secret names and lengths, never values.", [
    "store.secrets",
    "store.secretRotationRequestedBy",
    "store.secretRotationRequestedReason",
  ]),
  "GET /v1/vcr/repository/{idOrName}/images/{imageIdOrDigest}": redact(
    "Image layer environment entries are build-time NAME=value pairs.",
    ["image.layers[].env"],
  ),
  "GET /v10/projects": redact(
    PROJECT_REASON,
    under(["projects[]", "[]"], PROJECT),
    under(["projects[]", "[]"], PROJECT_ALLOW),
  ),
  "GET /v10/projects/{idOrName}/env": refuse(
    "returns environment values beside their metadata. Use list_project_env_vars, which never decrypts or returns a value.",
  ),
  "POST /v10/projects/{idOrName}/env": redact(ENV_REASON, [
    "created.value",
    "created.vsmValue",
    "created.legacyValue",
    "created[].value",
    "created[].vsmValue",
    "created[].legacyValue",
    "failed[].error.value",
  ]),
  "POST /v11/projects": redact(PROJECT_REASON, PROJECT, PROJECT_ALLOW),
  "PATCH /v12/deployments/{id}/cancel": redact(DEPLOYMENT_REASON, DEPLOYMENT),
  "POST /v13/deployments": redact(DEPLOYMENT_REASON, DEPLOYMENT),
  "GET /v13/deployments/{idOrUrl}": redact(DEPLOYMENT_REASON, DEPLOYMENT),
  "GET /v2/deployments/{id}/aliases": redact(
    "Aliases carry protection-bypass secrets as map keys.",
    ["aliases[].protectionBypass@keys"],
    ["aliases[].protectionBypass"],
  ),
  "POST /v2/deployments/{id}/aliases": safe("Answers the alias assignment."),
  "GET /v2/user": safe("ipBypass lists firewall IP rules, not secrets.", ["user.resourceConfig.security.ipBypass"]),
  "PATCH /v3/domains/{domain}": redact(
    "A move-out answers a transfer token; Connecta refuses move-out by body, and redacts any token.",
    ["token"],
  ),
  "GET /v3/events": redact(
    "Audit events carry environment variables (with or without key or type) and credential metadata in payloads.",
    [
      "events[].payload.newEnvVar.value",
      "events[].payload.oldEnvVar.value",
      "events[?env].payload.value",
      "events[?env].payload.vsmValue",
      "events[].payload.apiKey",
      "events[].payload.credential",
    ],
  ),
  "POST /v3/user/tokens": refuse("mints a Vercel access token."),
  "DELETE /v3/user/tokens/{tokenId}": safe(NO_SECRET_REASON),
  "GET /v4/aliases": redact(
    "Aliases carry protection-bypass secrets as map keys.",
    ["aliases[].protectionBypass@keys"],
    ["aliases[].protectionBypass"],
  ),
  "GET /v4/aliases/{idOrAlias}": redact(
    "Aliases carry protection-bypass secrets as map keys.",
    ["protectionBypass@keys"],
    ["protectionBypass"],
  ),
  "GET /v5/user/tokens/{tokenId}": safe(
    "Answers token metadata (`token` is an object of ids, prefix, suffix, and scopes).",
    ["token"],
  ),
  "GET /v6/user/tokens": safe("Lists token metadata, never token values.", ["tokens"]),
  "GET /v9/projects/{idOrName}": redact(PROJECT_REASON, PROJECT, PROJECT_ALLOW),
  "PATCH /v9/projects/{idOrName}": redact(PROJECT_REASON, PROJECT, PROJECT_ALLOW),
  "PATCH /v9/projects/{idOrName}/env/{id}": redact(ENV_REASON, PROJECT_ENV),
  "DELETE /v9/projects/{idOrName}/env/{id}": redact(ENV_REASON, PROJECT_ENV),
  // Flagged by description or a transfer/claim/invite family (round 3).
  "POST /projects/{idOrName}/transfer-request": refuse(
    "returns a code that lets another team claim the project for 24 hours.",
  ),
  "PUT /projects/transfer-request/{code}": safe(
    "Accepts a transfer with a code the caller holds; answers transfer results.",
  ),
  "GET /ai-gateway/virtual-model-configs": safe(MODEL_CONFIG),
  "POST /ai-gateway/virtual-model-configs": safe(MODEL_CONFIG),
  "PATCH /ai-gateway/virtual-model-configs": safe(MODEL_CONFIG),
  "GET /ai-gateway/virtual-model-configs/list": safe(MODEL_CONFIG),
  "GET /ai-gateway/virtual-model-configs/{vmcSlug}": safe(MODEL_CONFIG),
  "PATCH /ai-gateway/virtual-model-configs/{vmcSlug}": safe(MODEL_CONFIG),
  "GET /v1/ai-gateway/routers": safe(MODEL_CONFIG),
  "POST /storage/stores/blob": safe("store.kind names the store type; no token is returned."),
  "GET /v1/installations/{integrationConfigurationId}/resources/{resourceId}": safe(
    "customClaims are OIDC claim configuration, not tokens.",
  ),
  "GET /v1/integrations/configuration/{id}/products": safe(
    "protocols.authentication describes supported auth flows, not credentials.",
  ),
  "GET /v1/kms/issuers": safe(KMS_POLICY),
  "POST /v1/kms/issuers": safe(KMS_POLICY),
  "GET /v1/kms/issuers/{issuerId}": safe(KMS_POLICY),
  "PATCH /v1/kms/issuers/{issuerId}": safe(KMS_POLICY),
  "POST /v1/kms/issuers/{issuerId}/policies": safe(KMS_POLICY),
  "PATCH /v1/kms/issuers/{issuerId}/policies/{kind}/{policyKey}": safe(KMS_POLICY),
  "GET /v1/registrar/domains/{domain}/transfer": safe("Answers a transfer-in status only."),
  "POST /v1/registrar/domains/{domain}/transfer": safe("Answers an order id; the auth code is request input only."),
  "DELETE /v1/teams/{teamId}/invites/{inviteId}": safe(NO_SECRET_REASON),
  "GET /v2/teams": redact(TEAM_INVITE, ["teams[].inviteCode"]),
  "GET /v2/teams/{teamId}": redact(TEAM_INVITE, ["inviteCode"]),
  "PATCH /v2/teams/{teamId}": redact(TEAM_INVITE, ["inviteCode"]),
  "GET /v3/teams/{teamId}/members": safe(
    "emailInviteCodes lists pending invitations (email, role, expiry) without codes.",
    ["emailInviteCodes"],
  ),
  "POST /v2/teams/{teamId}/members": safe("Answers the invited email, role, and permissions; no invite link or code."),
  "POST /v7/domains": safe("Answers the added domain's metadata."),
  "POST /v9/domains/{domain}/claim": safe("Claims by verified TXT record and answers domain metadata; issues nothing."),
};

/** The reviewed verdict for one operation, if it was flagged. */
export function verdictFor(method: string, path: string): ValueSafetyVerdict | undefined {
  return VALUE_SAFETY[`${method} ${path}`];
}

/** A secret family answers failures with fixed messages, never the vendor's text. */
export function secretFamily(method: string, path: string): boolean {
  const verdict = verdictFor(method, path);
  return verdict !== undefined && verdict.verdict !== "safe";
}

function normalizedName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Whether a key names a credential rather than metadata about one. */
export function credentialName(name: string): boolean {
  const normalized = normalizedName(name);
  if (!CREDENTIAL_WORDS.some((word) => normalized.includes(word))) return false;
  if (METADATA_NAMES.includes(normalized)) return false;
  return !METADATA_SUFFIXES.some((suffix) => normalized.endsWith(suffix) && normalized !== suffix);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A URL without userinfo or credential query parameters; anything unparseable is withheld. */
function sanitizeUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return REDACTED;
  }
  let changed = false;
  if (url.username || url.password) {
    url.username = "redacted";
    url.password = "";
    changed = true;
  }
  // A snapshot of the names: setting a parameter while iterating the live list is unsafe.
  for (const name of Array.from(url.searchParams.keys())) {
    if (URL_CREDENTIAL_PARAMS.test(name)) {
      url.searchParams.set(name, REDACTED);
      changed = true;
    }
  }
  if (url.hash && /token|secret|key|code|auth/i.test(url.hash)) {
    url.hash = "";
    changed = true;
  }
  // An ordinary URL comes back exactly as Vercel sent it.
  return changed ? url.toString() : value;
}

const URL_SHAPE = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * A destination URL reduced to its origin: webhook and drain URLs can carry a
 * bearer secret in the path itself (`hooks.slack.com/services/…/<secret>`), so
 * only the scheme and host come back.
 */
function originOnly(value: string): string {
  try {
    const url = new URL(value);
    const bare = (url.pathname === "/" || url.pathname === "") && !url.search && !url.hash && !url.username;
    return bare ? url.origin : `${url.origin}/${REDACTED}`;
  } catch {
    return REDACTED;
  }
}

/**
 * The label a record carries for its value: `key`, `name`, or a transform's
 * `target.key` (`{ op: "set", target: { key: "Authorization" }, args }`).
 */
function labelOf(value: JsonRecord): string | undefined {
  if (typeof value["key"] === "string") return value["key"];
  if (typeof value["name"] === "string") return value["name"];
  const target = value["target"];
  return isRecord(target) && typeof target["key"] === "string" ? target["key"] : undefined;
}

/** Whether a record's label names a credential, so its value or args are one. */
function credentialLabelled(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const label = labelOf(value);
  return label !== undefined && credentialName(label);
}

/** A header, cookie, or query rule (`request.headers`, `header`, `cookie`, `query`, …). */
function headerLike(value: unknown): boolean {
  return isRecord(value) && typeof value["type"] === "string" && /header|cookie|query/i.test(value["type"]);
}

/** The fields of a header, cookie, or query rule that hold the matched or set value. */
const HEADER_RULE_VALUES = ["value", "values", "args"];

/** Keys whose absolute URL is a route or redirect destination. */
const DESTINATION_KEYS = ["dest", "destination", "location"];

/** A route-like object: its `headers` are set on requests or responses. */
function routeLike(value: JsonRecord): boolean {
  return ["src", "source", "dest", "destination"].some((key) => key in value);
}

/** The fields of a labelled record that hold what the label names. */
const LABELLED_VALUE_FIELDS = [...ENV_VALUE_FIELDS, "args"];

/** Apply one reviewed path to a body in place of its value. */
function applyPath(body: unknown, path: string): unknown {
  const mode = path.startsWith("url:") ? "url" : path.startsWith("origin:") ? "origin" : "redact";
  const segments = (mode === "redact" ? path : path.slice(path.indexOf(":") + 1)).split(".").flatMap((part) => {
    const out: string[] = [];
    const match = /^([^[{@]*)((?:\[\??[a-z]*\]|\{\}|@keys)*)$/.exec(part);
    if (!match) return [part];
    if (match[1]) out.push(match[1]);
    for (const token of match[2]!.match(/\[\??[a-z]*\]|\{\}|@keys/g) ?? []) out.push(token);
    return out;
  });
  const step = (current: unknown, index: number): unknown => {
    if (index === segments.length) {
      if (current === undefined) return current;
      if (mode === "url") return typeof current === "string" ? sanitizeUrl(current) : current;
      if (mode === "origin") return typeof current === "string" ? originOnly(current) : current;
      return REDACTED;
    }
    const segment = segments[index]!;
    if (segment === "[]" || segment === "[?env]" || segment === "[?credential]" || segment === "[?header]") {
      if (!Array.isArray(current)) return current;
      return current.map((item) => {
        if (segment === "[?env]" && !/env/i.test(String(isRecord(item) ? item["type"] : ""))) return item;
        if (segment === "[?credential]" && !credentialLabelled(item)) return item;
        if (segment === "[?header]" && !headerLike(item)) return item;
        return step(item, index + 1);
      });
    }
    if (segment === "{}") {
      if (!isRecord(current)) return current;
      return Object.fromEntries(Object.entries(current).map(([key, item]) => [key, step(item, index + 1)]));
    }
    if (segment === "@keys") {
      if (!isRecord(current)) return current;
      return Object.fromEntries(Object.values(current).map((item, position) => [`${REDACTED} ${position + 1}`, item]));
    }
    if (!isRecord(current) || !(segment in current)) return current;
    return { ...current, [segment]: step(current[segment], index + 1) };
  };
  return step(body, 0);
}

/** Whether a reviewed allow path names this key path (list items carry no segment). */
function allowed(allow: readonly string[], trail: readonly string[]): boolean {
  if (allow.length === 0) return false;
  const here = trail.join(".");
  return allow.some((path) => path.replace(/\[\]/g, "").split(".").filter(Boolean).join(".") === here);
}

/**
 * The contents of an environment container: every variable loses its value
 * fields whether or not it has a `key` or `type`, a `NAME → value` map (no
 * `key` or `id`, only strings) loses every value, and `NAME=value` strings go.
 */
function scrubEnv(value: unknown, depth: number): unknown {
  if (depth > 32) return REDACTED;
  if (Array.isArray(value)) {
    return value.map((item) => (typeof item === "string" && item.includes("=") ? REDACTED : scrubEnv(item, depth + 1)));
  }
  if (!isRecord(value)) return value;
  const entries = Object.entries(value);
  const map =
    !("key" in value) &&
    !("id" in value) &&
    !ENV_VALUE_FIELDS.some((field) => field in value) &&
    entries.length > 0 &&
    entries.every(([, item]) => typeof item === "string");
  if (map) return Object.fromEntries(entries.map(([key]) => [key, REDACTED]));
  const out: JsonRecord = {};
  for (const [key, item] of entries) {
    if (ENV_VALUE_FIELDS.includes(key)) continue;
    out[key] = scrubEnv(item, depth + 1);
  }
  return out;
}

/** An operation body that is environment variables: values go, nothing else changes. */
function scrubValues(value: unknown, depth: number): unknown {
  if (depth > 32) return REDACTED;
  if (Array.isArray(value)) return value.map((item) => scrubValues(item, depth + 1));
  if (!isRecord(value)) return value;
  const out: JsonRecord = {};
  for (const [key, item] of Object.entries(value)) {
    if (!ENV_VALUE_FIELDS.includes(key)) out[key] = scrubValues(item, depth + 1);
  }
  return out;
}

/**
 * The defense-in-depth pass over any body: credential-named subtrees, labelled
 * key/value records, environment containers, deploy hook URLs, destination
 * headers, header/cookie/query transform args and condition values, route
 * headers, external route destinations reduced to their origin, permission
 * scopes kept, and other URLs sanitized.
 */
/** Every value of a headers map, or of a list of `{ key, value }` header pairs, withheld. */
function headerValues(value: unknown): unknown {
  if (isRecord(value)) return Object.fromEntries(Object.keys(value).map((name) => [name, REDACTED]));
  if (Array.isArray(value)) {
    return value.map((item) => (isRecord(item) && "value" in item ? { ...item, value: REDACTED } : item));
  }
  return value;
}

function heuristic(value: unknown, allow: readonly string[]): unknown {
  const walk = (current: unknown, trail: string[], parent: string, depth: number): unknown => {
    if (depth > 48) return REDACTED;
    if (typeof current === "string") return URL_SHAPE.test(current) ? sanitizeUrl(current) : current;
    if (Array.isArray(current)) return current.map((item) => walk(item, trail, parent, depth + 1));
    if (!isRecord(current)) return current;
    const labelled = credentialLabelled(current);
    const destination = parent === "delivery" || "endpoint" in current || "deliveryFormat" in current;
    const out: JsonRecord = {};
    for (const [key, item] of Object.entries(current)) {
      const path = [...trail, key];
      const normalized = normalizedName(key);
      if (labelled && LABELLED_VALUE_FIELDS.includes(key)) {
        out[key] = REDACTED;
      } else if (parent === "permissions" && Array.isArray(item) && item.every((entry) => typeof entry === "string")) {
        // Permission scopes: action names under a resource name, never secrets.
        out[key] = item;
      } else if (credentialName(key) && !allowed(allow, path)) {
        out[key] = REDACTED;
      } else if (ENV_CONTAINERS.includes(normalized)) {
        out[key] = scrubEnv(item, depth + 1);
      } else if (parent === "deployhooks" && key === "url") {
        out[key] = REDACTED;
      } else if (key === "headers" && destination && isRecord(item)) {
        out[key] = Object.fromEntries(Object.keys(item).map((header) => [header, REDACTED]));
      } else if (HEADER_RULE_VALUES.includes(key) && headerLike(current)) {
        // Any header, cookie, or query rule — a route condition, a firewall
        // condition, a transform — matches or sets this value, wherever the
        // rule sits and whatever its key's form; it can be a credential.
        out[key] = REDACTED;
      } else if (key === "headers" && routeLike(current)) {
        out[key] = headerValues(item);
      } else if (DESTINATION_KEYS.includes(key) && typeof item === "string" && URL_SHAPE.test(item)) {
        // An external destination can carry its secret in the path; relative paths stay.
        out[key] = originOnly(item);
      } else {
        out[key] = walk(item, path, normalized, depth + 1);
      }
    }
    return out;
  };
  return walk(value, [], "", 0);
}

/** Operations whose whole body is environment variables, `key` or not. */
const ENV_BODY = /^\/v\d+\/(?:env(?:\/|$)|projects\/\{[^}]+\}\/env(?:\/|$))/;

/**
 * Make one success body value-safe: the operation's reviewed paths, then
 * environment-only bodies scrubbed whole, then the heuristic. Refused
 * operations never reach here from the generic tools.
 */
export function redactResponse(body: unknown, method: string, path: string): unknown {
  const verdict = verdictFor(method, path);
  let out = body;
  if (verdict?.verdict === "redact") for (const reviewed of verdict.paths) out = applyPath(out, reviewed);
  if (ENV_BODY.test(path)) out = scrubValues(out, 0);
  return heuristic(out, verdict && verdict.verdict !== "refuse" ? (verdict.allow ?? []) : []);
}
