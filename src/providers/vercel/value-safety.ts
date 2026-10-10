// Vercel's reviewed value-safety table (decision 0005, "Value safety"), on the
// shared mechanism in `../_shared/rest/value-safety.ts`.
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
//    `value-safety.node.test.ts` runs the shared harness over this table.
// 2. Reviewed field paths for `redact` verdicts, applied to every success body
//    on every path (generic tools, HEAD data, named tools, logs, uploads)
//    before cursors or `select` read it. Every reviewed operation, and every
//    one whose request accepts a credential-named field, also answers
//    failures with fixed messages, never the vendor's text.
// 3. The shared key-name heuristic, defense in depth only, over every body:
//    any subtree under a credential-named key, labelled key/value records
//    whose label is credential-named, environment-variable containers, and
//    URLs with userinfo or credential query parameters.
//
// Residual risk, as with Infisical: a secret a person typed into a free-text
// name, description, log line, or identifier is out of scope.

import {
  redact,
  refuse as refusal,
  safe,
  under,
  type ValueSafetyTable,
  type ValueSafetyVerdict,
} from "../_shared/rest/value-safety.js";

/** A refusal's reason reads as a sentence about the operation: "It mints …". */
const refuse = (reason: string): ValueSafetyVerdict => refusal(`It ${reason}`);

/** A project object: env values, deploy hooks, and protection-bypass secrets. */
const PROJECT = [
  "env[].value",
  "env[].vsmValue",
  "env[].legacyValue",
  "link.deployHooks[].url",
  "protectionBypass@keys",
  // Header, cookie, and query conditions on internal and firewall routes.
  "internalRoutes[].has[?header].value",
  "internalRoutes[].missing[?header].value",
  "security.firewallRoutes[].has[?header].value",
  "security.firewallRoutes[].missing[?header].value",
];
/** Project metadata whose names contain a credential word. */
const PROJECT_ALLOW = [
  "protectionBypass",
  "oidcTokenConfig",
  "security.firewallBypassIps",
  "usageStatus.bypassThrottleUntil",
  "dismissedToasts[].value",
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
const ROUTE_TRANSFORMS = [
  "transforms[].args",
  "has[?header].value",
  "missing[?header].value",
  // Headers a route sets, and the locale cookie it reads (its name is credential vocabulary).
  "headers{}",
  "locale.cookie",
];
const DEPLOYMENT = [
  ...under(["routes[]", "services[].routes[]", "services[].rewrites[]", "services[].redirects[]"], ROUTE_TRANSFORMS),
  "services[].headers[].headers[].value",
  "services[].headers[].has[?header].value",
  "services[].headers[].missing[?header].value",
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
const VALUE_SAFETY: Readonly<Record<string, ValueSafetyVerdict>> = {
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
      "events[].payload.inviteCode",
      "events[].payload.gitCredentialSource",
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
  "GET /storage/stores/{id}": safe(
    "A store's metadata; projectsMetadata lists environment variable names, not values.",
  ),
  "GET /v1/installations/{integrationConfigurationId}/resources/{resourceId}": safe(
    "customClaims are OIDC claim configuration, not tokens.",
  ),
  "GET /v1/integrations/configuration/{id}/products": redact(
    "protocols.authentication describes supported auth flows, not credentials; a product's log and trace drain protocols carry destination headers.",
    [
      "products[].protocols.logDrain.headers{}",
      "products[].protocols.traceDrain.headers{}",
      "origin:products[].protocols.logDrain.endpoint",
      "origin:products[].protocols.traceDrain.endpoint",
    ],
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

/**
 * Vercel's reviewed table. Environment-variable endpoints answer bodies that
 * are environment variables whether or not each carries a `key`, so their
 * values go whole; `permissions` maps list action scopes under resource
 * names, which the heuristic leaves.
 */
export const VERCEL_VALUE_SAFETY: ValueSafetyTable = {
  title: "Vercel",
  operations: VALUE_SAFETY,
  envBodies: /^\/v\d+\/(?:env(?:\/|$)|projects\/\{[^}]+\}\/env(?:\/|$))/,
  scopeMaps: ["permissions"],
  fields: Object.fromEntries(
    (
      [
        ["env", "Environment names and variable-name lists; values inside environment containers go structurally."],
        ["environments", "Environment slugs or ids a policy or variable applies to."],
        ["environmentVariables", "Environment variable names a store connects, never values."],
        ["type", "A variable's or record's type (plain, encrypted, sensitive, secret)."],
        ["visibility", "A variable's visibility setting."],
        ["keys", "Rate-limit key kinds (ip, ja4) and changed variable names."],
        ["logHeaders", "Header names a firewall rule logs."],
        ["log_headers", "Header names the firewall logs."],
        ["signingKeys", "KMS signing key metadata and public key material; private keys stay with Vercel."],
        ["bindings", "Service-to-service binding names and targets."],
        ["canaryResponseHeader", "Whether a canary response sets a header; a boolean."],
        ["inferenceRegion", "An AI Gateway routing region."],
        ["providerTimeouts", "Provider timeouts in milliseconds."],
        ["redirectUri", "A connector's registered OAuth redirect URI, public by design."],
        ["supportsRevocation", "Whether a connector can revoke tokens; a boolean."],
        ["claims", "OIDC claim matchers a policy requires, not tokens."],
        ["customClaims", "OIDC claim configuration, not tokens."],
        ["limited", "Whether a record is limited by the token's privileges; a boolean."],
        ["enforced", "Whether SAML is enforced; a boolean."],
        ["kind", "A store or record kind."],
        ["budget", "An AI Gateway key's spend budget."],
        ["origin", "How a token was issued (manual, oauth)."],
        ["scope", "A token's scope (user, team, project)."],
        ["issuedBefore", "A revocation cutoff timestamp."],
        ["issuerUrl", "The OIDC issuer URL, public by design."],
        ["oidcSubject", "The OIDC subject claim, an identifier."],
        ["next", "A pagination cursor; it grants nothing."],
        ["partialKeyValue", "A masked SDK key preview."],
        ["appUrlRegistrationSupport", "Whether a partner accepts app URLs; a boolean."],
        ["disjunctiveProductionSecretPolicy", "A team policy setting."],
        ["sensitiveEnvironmentVariablePolicy", "A team policy setting."],
        ["strictPasswordProtectionSettings", "A team policy setting."],
      ] as const
    ).map(([name, reason]) => [name, { verdict: "keep" as const, reason }]),
  ),
};
