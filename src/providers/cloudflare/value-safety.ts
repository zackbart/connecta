// Cloudflare's reviewed value-safety table (#801), on the shared mechanism in
// `../_shared/rest/value-safety.ts`: every operation the detector flags in
// the pinned spec (`value-safety.candidates.json`) has one verdict here, and
// `value-safety.node.test.ts` runs the shared harness over it.
//
// - `refuse`: the operation exists to mint, rotate, or hand back a credential
//   (or move money through a payment secret); nothing is sent.
// - `redact`: the operation is useful, and these field paths carry a
//   credential or stored secret; they are replaced before the result is
//   returned, on every method. A path ending in `#url` keeps only the URL's
//   scheme and host.
// - `safe`: no credential value comes back; `keep` names credential-named
//   fields reviewed as metadata, which the key-name heuristic leaves alone.
//
// Paths are dot paths into the data a tool returns (Cloudflare's `result`,
// or the whole body when it is not an envelope); lists are traversed
// implicitly and `*` matches every key of an object.
import {
  redact as reviewed,
  refuse,
  safe as reviewedSafe,
  type ValueSafetyTable,
  type ValueSafetyVerdict,
} from "../_shared/rest/value-safety.js";

const MINT =
  "Connecta does not create, rotate, or return credentials; an operator manages this credential in the Cloudflare dashboard.";
const API_TOKENS =
  "Connecta does not create, roll, edit, or delete API tokens; an operator manages tokens in the Cloudflare dashboard.";
const PAYMENT =
  "This starts a payment and returns its client secret; billing changes belong in the Cloudflare dashboard.";
const BEARER =
  "This returns a URL or upload token that grants access without Cloudflare authentication; Connecta does not hand those out. Upload through cloudflare_api_upload.";
const ACTS = "This GET acts rather than reads (it completes a connection or an unsubscribe), so it is not a read.";
const INTERNAL = "An internal Cloudflare test route; it is not part of the supported API.";
const CAPTURE =
  "A URL scan's captured session (cookies, request and response headers, response bodies, DOM) can carry credentials, so Connecta does not return it. Read scan verdicts with GET /accounts/{account_id}/urlscanner/v2/search.";

const METADATA = "Returns names, ids, status, and timestamps; no credential value.";
const REVOKES = "Revokes or deletes; returns no credential value.";
const CALLER_SUPPLIED = "The caller supplies the secret; the response returns only its name and metadata.";

/** The reason a bare `redact(...)` verdict states: the reviewed paths are the finding. */
const CARRIES = "These fields carry a credential or a stored secret value; they are redacted, the rest returned.";

const redact = (...paths: string[]) => reviewed(CARRIES, paths);
const safe = (reason: string, ...keep: string[]) => reviewedSafe(reason, keep);

const ACCESS_APP = reviewed(
  "Access applications carry SaaS and SCIM client secrets, passwords, and bearer tokens.",
  [
    "saas_app.client_secret",
    "scim_config.authentication.client_secret",
    "scim_config.authentication.password",
    "scim_config.authentication.token",
  ],
  [
    "cors_headers.allowed_headers",
    "read_service_tokens_from_header",
    "saas_app.custom_claims",
    ...["exclude", "include", "require"].flatMap((rule) =>
      ["any_valid_service_token", "linked_app_token", "service_token"].map((name) => `policies.${rule}.${name}`),
    ),
  ],
);
const ACCESS_RULES = safe(
  "Access rules name service tokens by id; no token value.",
  "exclude.any_valid_service_token",
  "exclude.linked_app_token",
  "exclude.service_token",
  "include.any_valid_service_token",
  "include.linked_app_token",
  "include.service_token",
  "require.any_valid_service_token",
  "require.linked_app_token",
  "require.service_token",
  "is_default.any_valid_service_token",
  "is_default.linked_app_token",
  "is_default.service_token",
);
const IDENTITY_PROVIDER = reviewed(
  "Identity providers carry OAuth client secrets and SCIM secrets.",
  ["config.client_secret", "scim_config.secret"],
  ["config.prompt", "config.attributes", "config.claims"],
);
/**
 * Environment variable values are redacted wherever they appear, names and
 * types kept. Cloudflare returns plain-text variables in the clear, and
 * operators routinely put API keys in them (a Stripe key in a Pages
 * variable); the value stays readable in the dashboard.
 */
const PAGES_PROJECT = reviewed(
  "Pages projects and deployments embed environment variable values.",
  [
    "env_vars.*.value",
    "canonical_deployment.env_vars.*.value",
    "latest_deployment.env_vars.*.value",
    "deployment_configs.preview.env_vars.*.value",
    "deployment_configs.production.env_vars.*.value",
  ],
  [
    "build_config.web_analytics_token",
    "canonical_deployment.build_config.web_analytics_token",
    "latest_deployment.build_config.web_analytics_token",
    "deployment_configs.preview.ai_bindings",
    "deployment_configs.preview.hyperdrive_bindings",
    "deployment_configs.preview.vectorize_bindings",
    "deployment_configs.production.ai_bindings",
    "deployment_configs.production.hyperdrive_bindings",
    "deployment_configs.production.vectorize_bindings",
  ],
);
const LIVE_INPUT = reviewed(
  "Live inputs carry RTMPS stream keys, SRT passphrases, and a WebRTC URL that is itself the credential.",
  ["rtmps.streamKey", "rtmpsPlayback.streamKey", "srt.passphrase", "srtPlayback.passphrase", "webRTC.url#url"],
  ["rtmps.url", "rtmpsPlayback.url", "srt.url", "srtPlayback.url", "webRTCPlayback.url"],
);
const WORKER_SECRET = redact("text", "key_base64", "key_jwk", "*.text", "*.key_base64", "*.key_jwk");
/**
 * Worker bindings: plain-text and JSON binding values are redacted (the same
 * judgment as environment variables: they are often credentials in
 * practice); names, types, and resource ids are kept.
 */
const WORKER_BINDINGS = redact("bindings.text", "bindings.json");
const WORKER_VERSION = redact("assets.jwt", "bindings.text", "bindings.json", "env.*.text", "env.*.json");
const ZARAZ = redact(
  "variables.*.value",
  "debugKey",
  "*.variables.*.value",
  "*.debugKey",
  "*.config.variables.*.value",
  "*.config.debugKey",
);
const TSIG = redact("secret");
/**
 * Rulesets: a transform rule's static header value is sent to the origin or
 * the visitor and can be a credential (`Authorization: Bearer …`); its name,
 * operation, and expression stay. Cache-key cookie and header lists, logged
 * cookie fields, and exposed-credential expressions name fields, not values.
 */
const RULESET = reviewed(
  "Transform rules set header values, which can be credentials sent to an origin; the rest is rule configuration.",
  ["rules.action_parameters.headers.*.value"],
  [
    "rules.exposed_credential_check",
    "rules.action_parameters.cache_key.custom_key.cookie",
    "rules.action_parameters.cache_key.custom_key.header",
    "rules.action_parameters.cookie_fields",
    "rules.action_parameters.vary.headers",
  ],
);
/** A webhook destination URL can carry a bearer secret in its path (a Slack or Discord hook); only its origin comes back. */
const WEBHOOK_DESTINATION = reviewed(
  "Notification webhook destinations: a URL path can be the bearer secret (a Slack or Discord hook), and the signing secret is write-only.",
  ["secret", "origin:url"],
);
const KIT_WEBHOOK = reviewed(
  "RealtimeKit webhook destinations: a URL path can be the bearer secret, so only the origin comes back.",
  ["origin:data.url"],
);
const POSTURE_WEBHOOK = reviewed(
  "Data security webhooks: header values and a destination URL whose path can be a bearer secret.",
  ["headers", "origin:destination_url"],
);
const HYPERDRIVE = reviewed(
  "Hyperdrive origins carry the database password and an Access client secret (write-only; redacted if ever returned).",
  ["origin.password", "origin.access_client_secret"],
);
/** RealtimeKit recording storage: third-party storage credentials (write-only; redacted if ever returned). */
const KIT_STORAGE_REASON =
  "Recording storage configurations carry third-party storage access keys, secrets, SFTP passwords, and private keys.";
const storageCredentials = (...prefixes: string[]) =>
  prefixes.flatMap((prefix) => ["access_key", "secret", "password", "private_key"].map((name) => `${prefix}.${name}`));
const KIT_MEETING_STORAGE = reviewed(KIT_STORAGE_REASON, storageCredentials("data.recording_config.storage_config"));
const KIT_RECORDING_STORAGE = reviewed(KIT_STORAGE_REASON, storageCredentials("data.storage_config"));
const BINDING_VALUES = reviewed(
  "Worker bindings: plain-text, JSON, and key-material values are often credentials; names, types, and resource ids stay.",
  ["text", "json", "key_base64", "key_jwk"],
);
const WORKER = reviewed(
  "Workers carry the bindings new previews get, keyed by name; plain-text and JSON values are often credentials.",
  ["previews_base_config.env.*.text", "previews_base_config.env.*.json"],
);
const MOQ_TOKENS = reviewed(
  "MoQ relay token issuers carry signing secrets; token ids and allowed operations are metadata.",
  ["issuers.cloudflare_tokens.secret"],
  ["issuers.cloudflare_tokens.jti", "issuers.cloudflare_tokens.operations"],
);
const KV_DATA =
  "Workers KV is application data storage, not a secret store (Workers Secrets and the Secrets Store hold secrets, and their values are write-only); returning what the caller stored is the operation's purpose.";
const DLP_FLAG = "`secret` is a boolean marking a DLP dataset or entry as sensitive, not a secret.";
const CERTIFICATE =
  "Certificates and their metadata; `signature` names the signature algorithm and is withheld by the field review.";
const OBSERVABILITY =
  "Saved query filters and telemetry values from the caller's own Workers; no Cloudflare credential (a secret an application logged is out of scope).";
const COUNTS = "Request token counts, quotas, and costs; no credential.";
const CURSOR = "A pagination cursor.";
const ANSWERS_ID = "Answers the destination's id; no secret.";
const TRACE = "Worker settings; trace propagation names a policy, not a token.";
const TRACE_POLICY = (paths: string[] = []) => safe(TRACE, ...paths);
const LIVESTREAM = redact("data.stream_key", "data.livestream.stream_key", "data.livestreams.stream_key");

/** Container environment values redacted, names kept; authorized keys are public SSH keys. */
const CONTAINER_APP = reviewed(
  "Container applications embed environment variable values.",
  [
    "configuration.environment_variables.value",
    "current_configuration.environment_variables.value",
    "target_configuration.environment_variables.value",
  ],
  [
    "next_page_token",
    "page_token",
    "configuration.authorized_keys",
    "current_configuration.authorized_keys",
    "target_configuration.authorized_keys",
  ],
);
/** Workers Builds environment values redacted, names kept. */
const BUILD_ENV = redact(
  "*.value",
  "build_trigger_metadata.environment_variables.*.value",
  "builds.*.build_trigger_metadata.environment_variables.*.value",
  "previews_base_config.environment_variables.*.value",
  "production_settings.environment_variables.*.value",
  "settings.environment_variables.*.value",
);
/** A BGP session's MD5 key authenticates the session. */
const BGP = (...paths: string[]) => redact(...paths.map((path) => `${path}.bgp.md5_key`));
const ROOT_BGP = redact("bgp.md5_key");
/** Probe and health-check headers often carry authorization. */
const HEALTH_HEADERS = redact("http_config.header");
const DESCRIBED_ONLY =
  "The spec mentions credentials in this field's description; the value is metadata, names, or counts.";

const A = "/accounts/{account_id}";
const Z = "/zones/{zone_id}";

const OPERATIONS: Readonly<Record<string, ValueSafetyVerdict>> = {
  // Access
  [`GET ${A}/access/apps`]: ACCESS_APP,
  [`POST ${A}/access/apps`]: ACCESS_APP,
  [`GET ${A}/access/apps/{app_id}`]: ACCESS_APP,
  [`PUT ${A}/access/apps/{app_id}`]: ACCESS_APP,
  [`GET ${Z}/access/apps`]: ACCESS_APP,
  [`POST ${Z}/access/apps`]: ACCESS_APP,
  [`GET ${Z}/access/apps/{app_id}`]: ACCESS_APP,
  [`PUT ${Z}/access/apps/{app_id}`]: ACCESS_APP,
  [`GET ${A}/access/apps/{app_id}/policies`]: ACCESS_RULES,
  [`POST ${A}/access/apps/{app_id}/policies`]: ACCESS_RULES,
  [`GET ${A}/access/apps/{app_id}/policies/{policy_id}`]: ACCESS_RULES,
  [`PUT ${A}/access/apps/{app_id}/policies/{policy_id}`]: ACCESS_RULES,
  [`PUT ${A}/access/apps/{app_id}/policies/{policy_id}/make_reusable`]: ACCESS_RULES,
  [`GET ${A}/access/groups`]: ACCESS_RULES,
  [`POST ${A}/access/groups`]: ACCESS_RULES,
  [`GET ${A}/access/groups/{group_id}`]: ACCESS_RULES,
  [`PUT ${A}/access/groups/{group_id}`]: ACCESS_RULES,
  [`GET ${A}/access/policies`]: ACCESS_RULES,
  [`POST ${A}/access/policies`]: ACCESS_RULES,
  [`GET ${A}/access/policies/{policy_id}`]: ACCESS_RULES,
  [`PUT ${A}/access/policies/{policy_id}`]: ACCESS_RULES,
  [`GET ${Z}/access/apps/{app_id}/policies`]: ACCESS_RULES,
  [`POST ${Z}/access/apps/{app_id}/policies`]: ACCESS_RULES,
  [`GET ${Z}/access/apps/{app_id}/policies/{policy_id}`]: ACCESS_RULES,
  [`PUT ${Z}/access/apps/{app_id}/policies/{policy_id}`]: ACCESS_RULES,
  [`GET ${Z}/access/groups`]: ACCESS_RULES,
  [`POST ${Z}/access/groups`]: ACCESS_RULES,
  [`GET ${Z}/access/groups/{group_id}`]: ACCESS_RULES,
  [`PUT ${Z}/access/groups/{group_id}`]: ACCESS_RULES,
  [`GET ${A}/access/identity_providers`]: IDENTITY_PROVIDER,
  [`POST ${A}/access/identity_providers`]: IDENTITY_PROVIDER,
  [`GET ${A}/access/identity_providers/{identity_provider_id}`]: IDENTITY_PROVIDER,
  [`PUT ${A}/access/identity_providers/{identity_provider_id}`]: IDENTITY_PROVIDER,
  [`GET ${Z}/access/identity_providers`]: IDENTITY_PROVIDER,
  [`POST ${Z}/access/identity_providers`]: IDENTITY_PROVIDER,
  [`GET ${Z}/access/identity_providers/{identity_provider_id}`]: IDENTITY_PROVIDER,
  [`PUT ${Z}/access/identity_providers/{identity_provider_id}`]: IDENTITY_PROVIDER,
  [`POST ${A}/access/apps/{app_id}/revoke_tokens`]: safe(REVOKES),
  [`POST ${Z}/access/apps/{app_id}/revoke_tokens`]: safe(REVOKES),
  [`POST ${A}/access/organizations/revoke_user`]: safe(REVOKES),
  [`POST ${Z}/access/organizations/revoke_user`]: safe(REVOKES),
  [`POST ${A}/access/keys/rotate`]: safe(
    "Rotates Cloudflare-held signing keys; returns the key configuration, no key.",
  ),
  [`POST ${A}/access/saml_certificates/{saml_cert_set_id}/rotate`]: safe(
    "Rotates a Cloudflare-held SAML certificate; returns the public certificate.",
  ),
  [`GET ${A}/access/service_tokens`]: safe(METADATA),
  [`POST ${A}/access/service_tokens`]: refuse(MINT),
  [`GET ${A}/access/service_tokens/{service_token_id}`]: safe(METADATA),
  [`PUT ${A}/access/service_tokens/{service_token_id}`]: safe(METADATA),
  [`DELETE ${A}/access/service_tokens/{service_token_id}`]: safe(REVOKES),
  [`POST ${A}/access/service_tokens/{service_token_id}/refresh`]: safe(
    "Extends the token's expiry; returns no secret.",
  ),
  [`POST ${A}/access/service_tokens/{service_token_id}/rotate`]: refuse(MINT),
  [`GET ${Z}/access/service_tokens`]: safe(METADATA),
  [`POST ${Z}/access/service_tokens`]: refuse(MINT),
  [`GET ${Z}/access/service_tokens/{service_token_id}`]: safe(METADATA),
  [`PUT ${Z}/access/service_tokens/{service_token_id}`]: safe(METADATA),
  [`DELETE ${Z}/access/service_tokens/{service_token_id}`]: safe(REVOKES),
  // Addressing
  ...Object.fromEntries(
    [
      `GET ${A}/addressing/prefixes`,
      `POST ${A}/addressing/prefixes`,
      `GET ${A}/addressing/prefixes/{prefix_id}`,
      `PATCH ${A}/addressing/prefixes/{prefix_id}`,
      `POST ${A}/addressing/prefixes/{prefix_id}/validate`,
    ].map((key) => [
      key,
      safe("The ownership token is published in DNS to prove ownership.", "ownership_validation_token"),
    ]),
  ),
  // AI Gateway, AI Search
  [`POST ${A}/ai-gateway/billing/topup`]: refuse(PAYMENT),
  ...Object.fromEntries(
    [
      `GET ${A}/ai-gateway/gateways`,
      `POST ${A}/ai-gateway/gateways`,
      `GET ${A}/ai-gateway/gateways/{id}`,
      `PUT ${A}/ai-gateway/gateways/{id}`,
      `DELETE ${A}/ai-gateway/gateways/{id}`,
    ].map((key) => [key, redact("otel.authorization", "otel.headers", "stripe.authorization")]),
  ),
  // Custom providers carry auth headers as a JSON-encoded string or an object.
  ...Object.fromEntries(
    [
      `GET ${A}/ai-gateway/custom-providers`,
      `POST ${A}/ai-gateway/custom-providers`,
      `GET ${A}/ai-gateway/custom-providers/{id}`,
      `PATCH ${A}/ai-gateway/custom-providers/{id}`,
      `DELETE ${A}/ai-gateway/custom-providers/{id}`,
    ].map((key) => [key, redact("headers")]),
  ),
  [`PUT ${A}/ai-gateway/gateways/{gateway_id}/provider_configs/{id}`]: safe(
    "The caller supplies the provider key; the response returns a masked preview.",
  ),
  [`GET ${A}/ai-search/tokens`]: safe(METADATA),
  [`POST ${A}/ai-search/tokens`]: refuse(MINT),
  [`GET ${A}/ai-search/tokens/{id}`]: safe(METADATA),
  [`PUT ${A}/ai-search/tokens/{id}`]: safe(METADATA),
  [`DELETE ${A}/ai-search/tokens/{id}`]: safe(REVOKES),
  // Alerting
  [`POST ${A}/alerting/v3/destinations/pagerduty/connect`]: refuse(MINT),
  [`GET ${A}/alerting/v3/destinations/pagerduty/connect/{token_id}`]: refuse(ACTS),
  [`GET ${A}/alerting/v3/policies/{policy_id}/email/unsubscribe`]: refuse(ACTS),
  // Artifacts
  [`POST ${A}/artifacts/namespaces/{namespace}/repos`]: redact("token"),
  [`POST ${A}/artifacts/namespaces/{namespace}/repos/{name}/fork`]: redact("token"),
  [`POST ${A}/artifacts/namespaces/{namespace}/repos/{name}/import`]: redact("token"),
  [`GET ${A}/artifacts/namespaces/{namespace}/repos/{name}/tokens`]: safe(METADATA),
  [`POST ${A}/artifacts/namespaces/{namespace}/tokens`]: refuse(MINT),
  [`DELETE ${A}/artifacts/namespaces/{namespace}/tokens/{id}`]: safe(REVOKES),
  // R2 Data Catalog
  [`POST ${A}/basin-catalog/{bucket_name}/credential`]: safe(CALLER_SUPPLIED),
  [`GET ${A}/basin-catalog/{bucket_name}/credential/status`]: safe(METADATA),
  [`GET ${A}/basin-catalog/{bucket_name}/namespaces`]: safe("A pagination cursor.", "next_page_token"),
  [`GET ${A}/basin-catalog/{bucket_name}/namespaces/{namespace}/tables`]: safe(
    "A pagination cursor.",
    "next_page_token",
  ),
  [`GET ${A}/basin-catalog/{bucket_name}/namespaces/{namespace}/tables/{table_name}/maintenance-runs`]: safe(
    "A pagination cursor.",
    "next_page_token",
  ),
  // Billing
  [`POST ${A}/billing/profile/payment-method`]: refuse(PAYMENT),
  [`POST ${A}/client-secret`]: refuse(PAYMENT),
  [`POST ${A}/pay-bad-debt`]: refuse(PAYMENT),
  [`POST ${A}/pay-invoice`]: refuse(PAYMENT),
  // Workers Builds
  [`GET ${A}/builds/tokens`]: safe(METADATA),
  [`POST ${A}/builds/tokens`]: refuse(MINT),
  [`DELETE ${A}/builds/tokens/{build_token_uuid}`]: safe(REVOKES),
  [`GET ${A}/builds/workers/{script_name}/deploy_hooks`]: redact("deploy_hook_uuid"),
  [`POST ${A}/builds/workers/{script_name}/deploy_hooks`]: refuse(BEARER),
  [`GET ${A}/builds/workers/{script_name}/deploy_hooks/{deploy_hook_uuid}`]: redact("deploy_hook_uuid"),
  [`PUT ${A}/builds/workers/{script_name}/deploy_hooks/{deploy_hook_uuid}`]: redact("deploy_hook_uuid"),
  [`DELETE ${A}/builds/workers/{script_name}/deploy_hooks/{deploy_hook_uuid}`]: safe(REVOKES),
  [`POST /workers/builds/deploy_hooks/{deploy_hook_uuid}`]: safe(
    "Triggers a build with a hook id the caller already holds; returns no credential.",
  ),
  // Calls, Turnstile
  [`POST ${A}/calls/apps`]: redact("secret"),
  [`GET ${A}/calls/turn_keys`]: safe(METADATA),
  [`POST ${A}/calls/turn_keys`]: refuse(MINT),
  [`GET ${A}/calls/turn_keys/{key_id}`]: safe(METADATA),
  [`PUT ${A}/calls/turn_keys/{key_id}`]: safe(METADATA),
  [`DELETE ${A}/calls/turn_keys/{key_id}`]: safe(REVOKES),
  [`POST ${A}/challenges/widgets`]: redact("secret"),
  [`GET ${A}/challenges/widgets/{sitekey}`]: redact("secret"),
  [`PUT ${A}/challenges/widgets/{sitekey}`]: redact("secret"),
  [`DELETE ${A}/challenges/widgets/{sitekey}`]: redact("secret"),
  [`POST ${A}/challenges/widgets/{sitekey}/rotate_secret`]: refuse(MINT),
  // Tunnels
  [`POST ${A}/cfd_tunnel/{tunnel_id}/management`]: refuse(MINT),
  [`GET ${A}/cfd_tunnel/{tunnel_id}/token`]: refuse(
    "A tunnel token lets anyone run this tunnel; Connecta does not return it. Read the tunnel itself instead.",
  ),
  [`GET ${A}/warp_connector/{tunnel_id}/token`]: refuse(
    "A Mesh node token lets anyone run this connector; Connecta does not return it.",
  ),
  // Cloudforce One
  [`GET ${A}/cloudforce-one/v2/credential-monitor/domains`]: safe(METADATA),
  [`POST ${A}/cloudforce-one/v2/credential-monitor/domains`]: safe(METADATA),
  [`DELETE ${A}/cloudforce-one/v2/credential-monitor/domains/{id}`]: safe(REVOKES),
  [`GET ${A}/cloudforce-one/v2/credential-monitor/matches`]: safe(
    "Matches name the domain and username, not a password.",
  ),
  [`GET ${A}/cloudforce-one/v2/requests/{project_type}/quota`]: safe("A request quota, not a token."),
  // Containers
  [`GET ${A}/containers/applications`]: CONTAINER_APP,
  [`GET ${A}/containers/applications/{application_id}/instances-v2`]: safe(
    "A pagination cursor.",
    "next_page_token",
    "page_token",
  ),
  [`POST ${A}/containers/registries/{domain}/credentials`]: refuse(MINT),
  // Custom pages
  [`POST ${A}/custom_pages/preview_tokens`]: refuse(MINT),
  [`POST ${Z}/custom_pages/preview_tokens`]: refuse(MINT),
  // D1, DLP, Email Security
  [`POST ${A}/d1/database/{database_id}/export`]: redact("result.signed_url#url", "signed_url#url"),
  [`POST ${A}/d1/database/{database_id}/import`]: redact("upload_url#url"),
  [`POST ${A}/dlp/datasets`]: reviewed(CARRIES, ["secret"], ["dataset.secret"]),
  [`POST ${A}/dlp/datasets/{dataset_id}/upload`]: redact("secret"),
  [`GET ${A}/dlp/email/account_mapping`]: redact("addin_identifier_token"),
  [`POST ${A}/dlp/email/account_mapping`]: redact("addin_identifier_token"),
  ...Object.fromEntries(
    [
      `GET ${A}/email-security/settings/domains`,
      `POST ${A}/email-security/settings/domains`,
      `GET ${A}/email-security/settings/domains/{domain_id}`,
      `PUT ${A}/email-security/settings/domains/{domain_id}`,
      `PATCH ${A}/email-security/settings/domains/{domain_id}`,
    ].map((key) => [key, safe("authorization is the domain's authorization status.", "authorization")]),
  ),
  [`POST ${A}/email-security/settings/domains/batch`]: safe(
    "authorization is each domain's authorization status.",
    "patches.authorization",
    "posts.authorization",
    "puts.authorization",
  ),
  [`POST ${A}/gateway/audit_ssh_settings/rotate_seed`]: safe("Returns the new seed's id and public key."),
  // Hyperdrive
  [`POST ${A}/hyperdrive/integrationsOperations/planetScale/createDatabaseSignature`]: refuse(MINT),
  // Images
  [`GET ${A}/images/v1/keys`]: redact("keys.value"),
  [`PUT ${A}/images/v1/keys/{signing_key_name}`]: refuse(MINT),
  [`DELETE ${A}/images/v1/keys/{signing_key_name}`]: redact("keys.value"),
  [`GET ${A}/images/v2`]: safe("A pagination cursor.", "continuation_token"),
  [`POST ${A}/images/v2/direct_upload`]: refuse(BEARER),
  // Load Balancing monitors: probe headers often carry authorization.
  ...Object.fromEntries(
    [
      `GET ${A}/load_balancers/monitors`,
      `POST ${A}/load_balancers/monitors`,
      `GET ${A}/load_balancers/monitors/{monitor_id}`,
      `PUT ${A}/load_balancers/monitors/{monitor_id}`,
      `PATCH ${A}/load_balancers/monitors/{monitor_id}`,
      `GET /user/load_balancers/monitors`,
      `POST /user/load_balancers/monitors`,
      `GET /user/load_balancers/monitors/{monitor_id}`,
      `PUT /user/load_balancers/monitors/{monitor_id}`,
      `PATCH /user/load_balancers/monitors/{monitor_id}`,
    ].map((key) => [key, redact("header")]),
  ),
  // Logpush destinations carry credentials in their query string.
  ...Object.fromEntries(
    [
      `GET ${A}/logpush/jobs`,
      `POST ${A}/logpush/jobs`,
      `GET ${A}/logpush/jobs/{job_id}`,
      `PUT ${A}/logpush/jobs/{job_id}`,
      `GET ${Z}/logpush/jobs`,
      `POST ${Z}/logpush/jobs`,
      `GET ${Z}/logpush/jobs/{job_id}`,
      `PUT ${Z}/logpush/jobs/{job_id}`,
    ].map((key) => [key, redact("destination_conf#url")]),
  ),
  // Magic WAN
  [`POST ${A}/magic/ipsec_tunnels/psk`]: reviewed(
    "Applied pre-shared keys authenticate IPsec tunnels.",
    ["successfully_applied_psks.*.psk"],
    ["unapplied_psks"],
  ),
  [`POST ${A}/magic/ipsec_tunnels/{ipsec_tunnel_id}/psk_generate`]: refuse(MINT),
  [`POST ${A}/mnm/vpc-flows/token`]: refuse(MINT),
  [`POST ${A}/managed-defense/vulnerability-discovery/repos`]: redact("upload.token"),
  // MoQ
  [`POST ${A}/moq/relays`]: MOQ_TOKENS,
  [`GET ${A}/moq/relays/{relay_id}/tokens`]: MOQ_TOKENS,
  [`POST ${A}/moq/relays/{relay_id}/tokens`]: refuse(MINT),
  [`DELETE ${A}/moq/relays/{relay_id}/tokens/{jti}`]: safe(REVOKES),
  // OAuth clients
  [`POST ${A}/oauth_clients`]: refuse(MINT),
  [`POST ${A}/oauth_clients/{oauth_client_id}/rotate_secret`]: refuse(MINT),
  [`DELETE ${A}/oauth_clients/{oauth_client_id}/rotate_secret`]: safe(REVOKES),
  // Pages
  [`GET ${A}/pages/projects`]: PAGES_PROJECT,
  [`POST ${A}/pages/projects`]: PAGES_PROJECT,
  [`GET ${A}/pages/projects/{project_name}`]: PAGES_PROJECT,
  [`PATCH ${A}/pages/projects/{project_name}`]: PAGES_PROJECT,
  [`GET ${A}/pages/projects/{project_name}/deployments`]: PAGES_PROJECT,
  [`POST ${A}/pages/projects/{project_name}/deployments`]: PAGES_PROJECT,
  [`GET ${A}/pages/projects/{project_name}/deployments/{deployment_id}`]: PAGES_PROJECT,
  [`POST ${A}/pages/projects/{project_name}/deployments/{deployment_id}/retry`]: PAGES_PROJECT,
  [`POST ${A}/pages/projects/{project_name}/deployments/{deployment_id}/rollback`]: PAGES_PROJECT,
  [`POST ${A}/pages/projects/{project_name}/source`]: PAGES_PROJECT,
  [`DELETE ${A}/pages/projects/{project_name}/source`]: PAGES_PROJECT,
  [`GET ${A}/pages/projects/{project_name}/upload-token`]: refuse(BEARER),
  // Pipelines, R2
  [`POST ${A}/pipelines/v1/sinks`]: redact("config.credentials", "config.token"),
  [`GET ${A}/r2/buckets/{bucket_name}/jobs`]: safe("A pagination cursor.", "nextContinuationToken"),
  [`POST ${A}/r2/temp-access-credentials`]: refuse(MINT),
  // RealtimeKit (bare `data` bodies)
  [`GET ${A}/realtime/kit/{app_id}/livestreams`]: LIVESTREAM,
  [`GET ${A}/realtime/kit/{app_id}/livestreams/{livestream_id}`]: LIVESTREAM,
  [`GET ${A}/realtime/kit/{app_id}/livestreams/{livestream_id}/active-livestream-session`]: LIVESTREAM,
  [`GET ${A}/realtime/kit/{app_id}/meetings/{meeting_id}/active-livestream`]: LIVESTREAM,
  [`GET ${A}/realtime/kit/{app_id}/meetings/{meeting_id}/livestream`]: LIVESTREAM,
  [`POST ${A}/realtime/kit/{app_id}/meetings/{meeting_id}/livestreams`]: LIVESTREAM,
  [`POST ${A}/realtime/kit/{app_id}/meetings/{meeting_id}/participants`]: refuse(MINT),
  [`PUT ${A}/realtime/kit/{app_id}/meetings/{meeting_id}/participants/{participant_id}`]: redact("data.token"),
  [`PATCH ${A}/realtime/kit/{app_id}/meetings/{meeting_id}/participants/{participant_id}`]: redact("data.token"),
  [`POST ${A}/realtime/kit/{app_id}/meetings/{meeting_id}/participants/{participant_id}/token`]: refuse(MINT),
  // Web Analytics
  ...Object.fromEntries(
    [
      `POST ${A}/rum/site_info`,
      `GET ${A}/rum/site_info/list`,
      `GET ${A}/rum/site_info/{site_id}`,
      `PUT ${A}/rum/site_info/{site_id}`,
    ].map((key) => [key, safe("The site token is a public beacon id embedded in pages.", "site_token")]),
  ),
  [`GET ${A}/scim/v2/ServiceProviderConfig`]: safe("Describes SCIM features; no credential.", "changePassword"),
  // Secondary DNS
  [`GET ${A}/secondary_dns/tsigs`]: TSIG,
  [`POST ${A}/secondary_dns/tsigs`]: TSIG,
  [`GET ${A}/secondary_dns/tsigs/{tsig_id}`]: TSIG,
  [`PUT ${A}/secondary_dns/tsigs/{tsig_id}`]: TSIG,
  [`DELETE ${A}/secondary_dns/tsigs/{tsig_id}`]: safe(REVOKES),
  // Secrets Store: values are write-only.
  ...Object.fromEntries(
    [
      `GET ${A}/secrets_store/stores`,
      `POST ${A}/secrets_store/stores`,
      `GET ${A}/secrets_store/stores/{store_id}`,
      `GET ${A}/secrets_store/stores/{store_id}/secrets`,
      `POST ${A}/secrets_store/stores/{store_id}/secrets`,
      `GET ${A}/secrets_store/stores/{store_id}/secrets/{secret_id}`,
      `PATCH ${A}/secrets_store/stores/{store_id}/secrets/{secret_id}`,
      `POST ${A}/secrets_store/stores/{store_id}/secrets/{secret_id}/duplicate`,
    ].map((key) => [key, safe(CALLER_SUPPLIED)]),
  ),
  [`GET ${A}/secrets_store/quota`]: safe("A usage count of secrets.", "secrets"),
  [`DELETE ${A}/secrets_store/stores/{store_id}`]: safe(REVOKES),
  [`DELETE ${A}/secrets_store/stores/{store_id}/secrets`]: safe(REVOKES),
  [`DELETE ${A}/secrets_store/stores/{store_id}/secrets/{secret_id}`]: safe(REVOKES),
  // Stream
  [`POST ${A}/stream/direct_upload`]: refuse(BEARER),
  [`GET ${A}/stream/keys`]: safe(METADATA),
  [`POST ${A}/stream/keys`]: refuse(MINT),
  [`DELETE ${A}/stream/keys/{identifier}`]: safe(REVOKES),
  [`GET ${A}/stream/live_inputs`]: LIVE_INPUT,
  [`POST ${A}/stream/live_inputs`]: LIVE_INPUT,
  [`GET ${A}/stream/live_inputs/{live_input_identifier}`]: LIVE_INPUT,
  [`PUT ${A}/stream/live_inputs/{live_input_identifier}`]: LIVE_INPUT,
  [`POST ${A}/stream/live_inputs/{live_input_identifier}/disable`]: LIVE_INPUT,
  [`POST ${A}/stream/live_inputs/{live_input_identifier}/enable`]: LIVE_INPUT,
  [`POST ${A}/stream/live_inputs/{live_input_identifier}/rotate_keys`]: refuse(MINT),
  [`GET ${A}/stream/live_inputs/{live_input_identifier}/outputs`]: redact("streamKey", "url#url"),
  [`POST ${A}/stream/live_inputs/{live_input_identifier}/outputs`]: redact("streamKey", "url#url"),
  [`PUT ${A}/stream/live_inputs/{live_input_identifier}/outputs/{output_identifier}`]: redact("streamKey", "url#url"),
  [`GET ${A}/stream/webhook`]: redact("secret"),
  [`PUT ${A}/stream/webhook`]: redact("secret"),
  [`POST ${A}/stream/{identifier}/token`]: refuse(BEARER),
  // API tokens
  [`GET ${A}/tokens`]: safe(METADATA),
  [`POST ${A}/tokens`]: refuse(API_TOKENS),
  [`GET ${A}/tokens/permission_groups`]: safe(METADATA),
  [`GET ${A}/tokens/verify`]: safe(METADATA),
  [`GET ${A}/tokens/{token_id}`]: safe(METADATA),
  [`PUT ${A}/tokens/{token_id}`]: refuse(API_TOKENS),
  [`DELETE ${A}/tokens/{token_id}`]: refuse(API_TOKENS),
  [`PUT ${A}/tokens/{token_id}/value`]: refuse(API_TOKENS),
  [`GET /user/tokens`]: safe(METADATA),
  [`POST /user/tokens`]: refuse(API_TOKENS),
  [`GET /user/tokens/permission_groups`]: safe(METADATA),
  [`GET /user/tokens/verify`]: safe(METADATA),
  [`GET /user/tokens/{token_id}`]: safe(METADATA),
  [`PUT /user/tokens/{token_id}`]: refuse(API_TOKENS),
  [`DELETE /user/tokens/{token_id}`]: refuse(API_TOKENS),
  [`PUT /user/tokens/{token_id}/value`]: refuse(API_TOKENS),
  // Vulnerability scanner: credential values are write-only.
  ...Object.fromEntries(
    [
      `GET ${A}/vuln_scanner/credential_sets`,
      `POST ${A}/vuln_scanner/credential_sets`,
      `GET ${A}/vuln_scanner/credential_sets/{credential_set_id}`,
      `PUT ${A}/vuln_scanner/credential_sets/{credential_set_id}`,
      `PATCH ${A}/vuln_scanner/credential_sets/{credential_set_id}`,
      `GET ${A}/vuln_scanner/credential_sets/{credential_set_id}/credentials`,
      `POST ${A}/vuln_scanner/credential_sets/{credential_set_id}/credentials`,
      `GET ${A}/vuln_scanner/credential_sets/{credential_set_id}/credentials/{credential_id}`,
      `PUT ${A}/vuln_scanner/credential_sets/{credential_set_id}/credentials/{credential_id}`,
      `PATCH ${A}/vuln_scanner/credential_sets/{credential_set_id}/credentials/{credential_id}`,
    ].map((key) => [key, safe(CALLER_SUPPLIED)]),
  ),
  [`DELETE ${A}/vuln_scanner/credential_sets/{credential_set_id}`]: safe(REVOKES),
  [`DELETE ${A}/vuln_scanner/credential_sets/{credential_set_id}/credentials/{credential_id}`]: safe(REVOKES),
  // Workers
  [`POST ${A}/workers/assets/upload`]: refuse(BEARER),
  [`POST ${A}/workers/scripts/{script_name}/assets-upload-session`]: refuse(BEARER),
  [`POST ${A}/workers/dispatch/namespaces/{dispatch_namespace}/scripts/{script_name}/assets-upload-session`]:
    refuse(BEARER),
  [`GET ${A}/workers/scripts/{script_name}/secrets`]: WORKER_SECRET,
  [`PUT ${A}/workers/scripts/{script_name}/secrets`]: WORKER_SECRET,
  [`PATCH ${A}/workers/scripts/{script_name}/secrets-bulk`]: WORKER_SECRET,
  [`GET ${A}/workers/scripts/{script_name}/secrets/{secret_name}`]: WORKER_SECRET,
  [`DELETE ${A}/workers/scripts/{script_name}/secrets/{secret_name}`]: safe(REVOKES),
  [`GET ${A}/workers/dispatch/namespaces/{dispatch_namespace}/scripts/{script_name}/secrets`]: WORKER_SECRET,
  [`PUT ${A}/workers/dispatch/namespaces/{dispatch_namespace}/scripts/{script_name}/secrets`]: WORKER_SECRET,
  [`PATCH ${A}/workers/dispatch/namespaces/{dispatch_namespace}/scripts/{script_name}/secrets-bulk`]: WORKER_SECRET,
  [`GET ${A}/workers/dispatch/namespaces/{dispatch_namespace}/scripts/{script_name}/secrets/{secret_name}`]:
    WORKER_SECRET,
  [`DELETE ${A}/workers/dispatch/namespaces/{dispatch_namespace}/scripts/{script_name}/secrets/{secret_name}`]:
    safe(REVOKES),
  [`GET ${A}/workers/workers/{worker_id}/previews/{preview_id}/deployments`]: WORKER_VERSION,
  [`POST ${A}/workers/workers/{worker_id}/previews/{preview_id}/deployments`]: WORKER_VERSION,
  [`PATCH ${A}/workers/workers/{worker_id}/previews/{preview_id}/deployments/latest`]: WORKER_VERSION,
  [`GET ${A}/workers/workers/{worker_id}/previews/{preview_id}/deployments/{deployment_id}`]: WORKER_VERSION,
  [`GET ${A}/workers/workers/{worker_id}/versions`]: WORKER_VERSION,
  [`POST ${A}/workers/workers/{worker_id}/versions`]: WORKER_VERSION,
  [`GET ${A}/workers/workers/{worker_id}/versions/latest`]: WORKER_VERSION,
  [`PATCH ${A}/workers/workers/{worker_id}/versions/latest`]: WORKER_VERSION,
  [`GET ${A}/workers/workers/{worker_id}/versions/{version_id}`]: WORKER_VERSION,
  [`GET ${A}/workflows/{workflow_name}/instances/{instance_id}/subscribe/token`]: refuse(MINT),
  // Unscoped
  [`GET /organizations`]: safe("A pagination cursor.", "next_page_token"),
  [`GET /organizations/{organization_id}/accounts`]: safe("A pagination cursor.", "next_page_token"),
  [`GET /organizations/{organization_id}/members`]: safe("A pagination cursor.", "next_page_token"),
  [`GET /radar/leaked_credential_checks/summary/{dimension}`]: safe("Aggregate internet statistics."),
  [`GET /radar/leaked_credential_checks/timeseries_groups/{dimension}`]: safe("Aggregate internet statistics."),
  [`GET /signed-url`]: refuse(INTERNAL),
  // Zones
  [`GET ${Z}/leaked-credential-checks`]: safe(METADATA, "enabled"),
  [`POST ${Z}/leaked-credential-checks`]: safe(METADATA, "enabled"),
  ...Object.fromEntries(
    [
      `GET ${Z}/leaked-credential-checks/detections`,
      `POST ${Z}/leaked-credential-checks/detections`,
      `GET ${Z}/leaked-credential-checks/detections/{detection_id}`,
      `PUT ${Z}/leaked-credential-checks/detections/{detection_id}`,
    ].map((key) => [key, safe("password is an expression locating the field, not a password.", "password")]),
  ),
  [`DELETE ${Z}/leaked-credential-checks/detections/{detection_id}`]: safe(REVOKES),
  [`GET ${Z}/origin_tls_client_auth`]: redact("private_key"),
  [`POST ${Z}/origin_tls_client_auth`]: redact("private_key"),
  [`PUT ${Z}/origin_tls_client_auth/hostnames`]: redact("private_key"),
  [`GET ${Z}/origin_tls_client_auth/{certificate_id}`]: redact("private_key"),
  [`DELETE ${Z}/origin_tls_client_auth/{certificate_id}`]: redact("private_key"),
  ...Object.fromEntries(
    [
      `GET ${Z}/pagerules`,
      `POST ${Z}/pagerules`,
      `GET ${Z}/pagerules/{pagerule_id}`,
      `PUT ${Z}/pagerules/{pagerule_id}`,
      `PATCH ${Z}/pagerules/{pagerule_id}`,
    ].map((key) => [
      key,
      safe("cookie and header list cache-key names.", "actions.value.cookie", "actions.value.header"),
    ]),
  ),
  ...Object.fromEntries(
    [`GET ${Z}/settings/zaraz/config`, `PUT ${Z}/settings/zaraz/config`, `GET ${Z}/settings/zaraz/default`].map(
      (key) => [key, ZARAZ],
    ),
  ),
  [`GET ${Z}/settings/zaraz/export`]: ZARAZ,
  [`GET ${Z}/settings/zaraz/history/configs`]: ZARAZ,
  [`GET ${Z}/token_validation/config`]: safe("credentials are public JWKS keys.", "credentials"),
  [`POST ${Z}/token_validation/config`]: safe("credentials are public JWKS keys.", "credentials"),
  [`GET ${Z}/token_validation/config/{config_id}`]: safe("credentials are public JWKS keys.", "credentials"),
  [`PATCH ${Z}/token_validation/config/{config_id}`]: safe(METADATA),
  [`DELETE ${Z}/token_validation/config/{config_id}`]: safe(REVOKES),
  [`PUT ${Z}/token_validation/config/{config_id}/credentials`]: safe("Public JWKS keys.", "keys"),
  [`PATCH ${Z}/token_validation/config/{config_id}/credentials`]: safe("Public JWKS keys.", "keys"),
  [`GET ${Z}/token_validation/rules`]: safe(METADATA),
  [`POST ${Z}/token_validation/rules`]: safe(METADATA),
  [`POST ${Z}/token_validation/rules/bulk`]: safe(METADATA),
  [`PATCH ${Z}/token_validation/rules/bulk`]: safe(METADATA),
  [`POST ${Z}/token_validation/rules/preview`]: safe(METADATA),
  [`GET ${Z}/token_validation/rules/{rule_id}`]: safe(METADATA),
  [`PATCH ${Z}/token_validation/rules/{rule_id}`]: safe(METADATA),
  [`DELETE ${Z}/token_validation/rules/{rule_id}`]: safe(REVOKES),
  // Round 2: candidates surfaced by plurals, headers, environment variables,
  // credential descriptions, and x-sensitive.
  [`POST ${A}/bulk/subscriptions`]: refuse(PAYMENT),
  [`POST ${A}/devices/override_codes`]: refuse(MINT),
  ...Object.fromEntries(
    [
      `GET ${A}/builds/builds`,
      `GET ${A}/builds/builds/latest`,
      `GET ${A}/builds/builds/{build_uuid}`,
      `POST ${A}/builds/triggers/{trigger_uuid}/builds`,
      `GET ${A}/builds/triggers/{trigger_uuid}/environment_variables`,
      `PATCH ${A}/builds/triggers/{trigger_uuid}/environment_variables`,
      `POST ${A}/builds/workers`,
      `GET ${A}/builds/workers/{external_script_id}/builds`,
      `GET ${A}/builds/workers/{script_tag}`,
      `PATCH ${A}/builds/workers/{script_tag}`,
      `POST ${A}/builds/workers/{script_tag}/migrate_to_previews`,
      `GET ${A}/builds/workers/{script_tag}/previews/{preview_id}`,
      `PATCH ${A}/builds/workers/{script_tag}/previews/{preview_id}`,
      `GET ${A}/builds/workers/{script_tag}/previews/{preview_id}/builds`,
      `POST ${A}/builds/workers/{script_tag}/previews/{preview_id}/builds`,
    ].map((key) => [key, BUILD_ENV]),
  ),
  ...Object.fromEntries(
    [
      `POST ${A}/containers/applications`,
      `GET ${A}/containers/applications/{application_id}`,
      `PATCH ${A}/containers/applications/{application_id}`,
      `POST ${A}/containers/applications/{application_id}/rollouts`,
      `GET ${A}/containers/applications/{application_id}/versions`,
    ].map((key) => [key, CONTAINER_APP]),
  ),
  [`GET ${A}/containers/registries`]: safe("A registry's public key.", "public_key"),
  [`POST ${A}/containers/registries`]: safe("A registry's public key.", "public_key"),
  ...Object.fromEntries(
    [`GET ${A}/cni/cnis`, `POST ${A}/cni/cnis`, `GET ${A}/cni/cnis/{cni}`, `PUT ${A}/cni/cnis/{cni}`].map((key) => [
      key,
      redact("bgp.md5_key", "items.bgp.md5_key"),
    ]),
  ),
  [`GET ${A}/magic/cf_interconnects`]: BGP("interconnects"),
  [`PUT ${A}/magic/cf_interconnects`]: BGP("modified_interconnects"),
  [`GET ${A}/magic/cf_interconnects/{cf_interconnect_id}`]: BGP("interconnect"),
  [`PUT ${A}/magic/cf_interconnects/{cf_interconnect_id}`]: BGP("modified_interconnect"),
  [`GET ${A}/magic/gre_tunnels`]: BGP("gre_tunnels"),
  [`POST ${A}/magic/gre_tunnels`]: ROOT_BGP,
  [`PUT ${A}/magic/gre_tunnels`]: BGP("modified_gre_tunnels"),
  [`GET ${A}/magic/gre_tunnels/{gre_tunnel_id}`]: BGP("gre_tunnel"),
  [`PUT ${A}/magic/gre_tunnels/{gre_tunnel_id}`]: BGP("modified_gre_tunnel"),
  [`DELETE ${A}/magic/gre_tunnels/{gre_tunnel_id}`]: BGP("deleted_gre_tunnel"),
  [`GET ${A}/magic/ipsec_tunnels`]: BGP("ipsec_tunnels"),
  [`POST ${A}/magic/ipsec_tunnels`]: ROOT_BGP,
  [`PUT ${A}/magic/ipsec_tunnels`]: BGP("modified_ipsec_tunnels"),
  [`GET ${A}/magic/ipsec_tunnels/{ipsec_tunnel_id}`]: BGP("ipsec_tunnel"),
  [`PUT ${A}/magic/ipsec_tunnels/{ipsec_tunnel_id}`]: BGP("modified_ipsec_tunnel"),
  [`DELETE ${A}/magic/ipsec_tunnels/{ipsec_tunnel_id}`]: BGP("deleted_ipsec_tunnel"),
  ...Object.fromEntries(
    [
      `GET ${A}/data-security/posture/webhooks`,
      `POST ${A}/data-security/posture/webhooks`,
      `GET ${A}/data-security/posture/webhooks/{webhook_id}`,
      `PUT ${A}/data-security/posture/webhooks/{webhook_id}`,
    ].map((key) => [key, POSTURE_WEBHOOK]),
  ),
  ...Object.fromEntries(
    [
      `GET ${A}/gateway/rules`,
      `POST ${A}/gateway/rules`,
      `PATCH ${A}/gateway/rules`,
      `GET ${A}/gateway/rules/tenant`,
      `GET ${A}/gateway/rules/{rule_id}`,
      `PUT ${A}/gateway/rules/{rule_id}`,
      `PATCH ${A}/gateway/rules/{rule_id}`,
      `POST ${A}/gateway/rules/{rule_id}/reset_expiration`,
    ].map((key) => [
      key,
      reviewed(
        "Gateway rules that add or set headers can carry credential header values.",
        ["rule_settings.add_headers", "rule_settings.set_headers"],
        ["rule_settings.delete_headers"],
      ),
    ]),
  ),
  [`GET ${A}/logpush/datasets/{dataset_id}/jobs`]: redact("destination_conf#url"),
  [`GET ${Z}/logpush/datasets/{dataset_id}/jobs`]: redact("destination_conf#url"),
  [`GET ${A}/workers/observability/destinations`]: redact(
    "configuration.headers",
    "configuration.destination_conf#url",
  ),
  [`GET ${A}/workers/observability/issues/{issueId}/occurrences`]: redact("request.headers"),
  [`GET ${A}/workers/scripts/{script_name}/settings`]: WORKER_BINDINGS,
  [`PATCH ${A}/workers/scripts/{script_name}/settings`]: WORKER_BINDINGS,
  [`GET ${A}/workers/dispatch/namespaces/{dispatch_namespace}/scripts/{script_name}/settings`]: WORKER_BINDINGS,
  [`PATCH ${A}/workers/dispatch/namespaces/{dispatch_namespace}/scripts/{script_name}/settings`]: WORKER_BINDINGS,
  [`POST ${A}/workers/scripts/{script_name}/versions`]: redact("resources.bindings.text", "resources.bindings.json"),
  [`GET ${A}/workers/scripts/{script_name}/versions/{version_id}`]: redact(
    "resources.bindings.text",
    "resources.bindings.json",
  ),
  ...Object.fromEntries(
    [
      `GET ${Z}/custom_hostnames`,
      `POST ${Z}/custom_hostnames`,
      `GET ${Z}/custom_hostnames/{custom_hostname_id}`,
      `PATCH ${Z}/custom_hostnames/{custom_hostname_id}`,
      `PUT ${Z}/custom_hostnames/{custom_hostname_id}/certificate_pack/{certificate_pack_id}/certificates/{certificate_id}`,
    ].map((key) => [key, redact("ssl.custom_key")]),
  ),
  [`GET ${Z}/dnssec/zsk`]: reviewed(
    "The zone signing key's private key and key-encryption key sign the zone.",
    ["SigningKey.privkey", "SigningKey.kek"],
    ["SigningKey.pubkey"],
  ),
  ...Object.fromEntries(
    [
      `GET ${Z}/healthchecks`,
      `POST ${Z}/healthchecks`,
      `POST ${Z}/healthchecks/preview`,
      `GET ${Z}/healthchecks/preview/{healthcheck_id}`,
      `GET ${Z}/healthchecks/{healthcheck_id}`,
      `PUT ${Z}/healthchecks/{healthcheck_id}`,
      `PATCH ${Z}/healthchecks/{healthcheck_id}`,
      `GET ${Z}/smart_shield/healthchecks`,
      `POST ${Z}/smart_shield/healthchecks`,
      `GET ${Z}/smart_shield/healthchecks/{healthcheck_id}`,
      `PUT ${Z}/smart_shield/healthchecks/{healthcheck_id}`,
      `PATCH ${Z}/smart_shield/healthchecks/{healthcheck_id}`,
    ].map((key) => [key, HEALTH_HEADERS]),
  ),
  [`PUT ${Z}/settings/zaraz/history`]: ZARAZ,
  // URL Scanner captures the scanned session: cookies, request and response
  // headers (Authorization among them), raw response bodies, and the DOM.
  // No reviewed projection exists, so these are refused; scan verdicts are in
  // the search results and the screenshot is an image.
  [`GET ${A}/urlscanner/v2/result/{scan_id}`]: refuse(CAPTURE),
  [`GET ${A}/urlscanner/v2/har/{scan_id}`]: refuse(CAPTURE),
  [`GET ${A}/urlscanner/v2/dom/{scan_id}`]: refuse(CAPTURE),
  [`GET ${A}/urlscanner/v2/responses/{response_id}`]: refuse(CAPTURE),
  // Reviewed safe: the flagged field is metadata, a header name list, a count, or third-party data the operation exists to return.
  ...Object.fromEntries(
    (
      [
        [`GET ${A}/access/ai-controls/mcp/portals`, "servers.auth_config_summary"],
        [`POST ${A}/access/ai-controls/mcp/portals`, "servers.auth_config_summary"],
        [`GET ${A}/access/ai-controls/mcp/portals/{id}`, "servers.auth_config_summary"],
        [`PUT ${A}/access/ai-controls/mcp/portals/{id}`, "servers.auth_config_summary"],
        [`GET ${A}/access/ai-controls/mcp/servers`, "auth_config_summary"],
        [`POST ${A}/access/ai-controls/mcp/servers`, "auth_config_summary"],
        [`GET ${A}/access/ai-controls/mcp/servers/{id}`, "auth_config_summary"],
        [`PUT ${A}/access/ai-controls/mcp/servers/{id}`, "auth_config_summary"],
        [`DELETE ${A}/access/ai-controls/mcp/servers/{id}`, "auth_config_summary"],
        [`GET ${A}/access/users/{user_id}/last_seen_identity`, "passkeys"],
        [`GET ${A}/ai-search/namespaces/{name}/instances`, "source_params.web_crawler.parse_options.include_headers"],
        [`POST ${A}/ai-search/namespaces/{name}/instances`, "source_params.web_crawler.parse_options.include_headers"],
        [
          `GET ${A}/ai-search/namespaces/{name}/instances/{id}`,
          "source_params.web_crawler.parse_options.include_headers",
        ],
        [
          `PUT ${A}/ai-search/namespaces/{name}/instances/{id}`,
          "source_params.web_crawler.parse_options.include_headers",
        ],
        [
          `DELETE ${A}/ai-search/namespaces/{name}/instances/{id}`,
          "source_params.web_crawler.parse_options.include_headers",
        ],
        [`POST ${A}/ai/tomarkdown`, "tokens"],
        [`GET ${A}/basin-catalog/{bucket_name}/maintenance-configs`, ""],
        [`GET ${A}/billable/usage/billable-metrics`, "DimensionKeys"],
        [`POST ${A}/browser-rendering/accessibilityTree`, "meta.headers", "meta.redirectChain.headers"],
        [`POST ${A}/browser-rendering/content`, "meta.headers", "meta.redirectChain.headers"],
        [`POST ${A}/browser-rendering/json`, "meta.headers", "meta.redirectChain.headers"],
        [`POST ${A}/browser-rendering/links`, "meta.headers", "meta.redirectChain.headers"],
        [`POST ${A}/browser-rendering/markdown`, "meta.headers", "meta.redirectChain.headers"],
        [`POST ${A}/browser-rendering/scrape`, "meta.headers", "meta.redirectChain.headers"],
        [`POST ${A}/browser-rendering/snapshot`, "meta.headers", "meta.redirectChain.headers"],
        [
          `GET ${A}/cfd_tunnel/{tunnel_id}/configurations`,
          "config.originRequest.httpHostHeader",
          "config.ingress.originRequest.httpHostHeader",
        ],
        [
          `PUT ${A}/cfd_tunnel/{tunnel_id}/configurations`,
          "config.originRequest.httpHostHeader",
          "config.ingress.originRequest.httpHostHeader",
        ],
        [`GET ${A}/cloudforce-one/rules/structured/schema`, "headers"],
        [`GET ${A}/custom_pages`, "required_tokens"],
        [`GET ${A}/custom_pages/{identifier}`, "required_tokens"],
        [`PUT ${A}/custom_pages/{identifier}`, "required_tokens"],
        [`GET ${Z}/custom_pages`, "required_tokens"],
        [`GET ${Z}/custom_pages/{identifier}`, "required_tokens"],
        [`PUT ${Z}/custom_pages/{identifier}`, "required_tokens"],
        [`GET ${A}/data-security/posture/content`, "integration.credentials_expiry", "integration.last_hydrated"],
        [`GET ${A}/data-security/posture/findings`, "integration.credentials_expiry", "integration.last_hydrated"],
        [
          `POST ${A}/data-security/posture/findings/ignore`,
          "integration.credentials_expiry",
          "integration.last_hydrated",
        ],
        [
          `POST ${A}/data-security/posture/findings/unignore`,
          "integration.credentials_expiry",
          "integration.last_hydrated",
        ],
        [
          `GET ${A}/data-security/posture/findings/{finding_id}`,
          "integration.credentials_expiry",
          "integration.last_hydrated",
        ],
        [
          `POST ${A}/data-security/posture/findings/{finding_id}/reset_finding_severity`,
          "integration.credentials_expiry",
          "integration.last_hydrated",
        ],
        [
          `POST ${A}/data-security/posture/findings/{finding_id}/tune_finding_severity`,
          "integration.credentials_expiry",
          "integration.last_hydrated",
        ],
        [`GET ${A}/data-security/posture/remediations/jobs`, "triggered_by_user"],
        [`POST ${A}/data-security/posture/remediations/jobs`, "created.triggered_by_user"],
        [`GET ${A}/email-security/investigate/{investigate_id}/detections`, "headers"],
        [`GET ${A}/images/v2/metadata/keys`, "keys"],
        [`GET ${A}/logs/audit`, "actor.context"],
        [`GET ${A}/logs/audit/{id}/history`, "actor.context"],
        [`GET ${A}/logs/list`, "keys"],
        [
          `GET ${A}/one/applications/{application_id}/auth-methods`,
          "instructions",
          "payload_example",
          "payload_schema",
        ],
        [`POST ${A}/one/integrations`, "credentials_expiry", "authorization_link"],
        [`GET ${A}/one/integrations/{id}`, "credentials_expiry", "authorization_link"],
        [`PATCH ${A}/one/integrations/{id}`, "credentials_expiry", "authorization_link"],
        [`POST ${A}/one/integrations/{id}/pause`, "credentials_expiry", "authorization_link"],
        [`POST ${A}/one/integrations/{id}/resume`, "credentials_expiry", "authorization_link"],
        [`GET ${A}/r2/buckets/{bucket_name}/cors`, "rules.allowed.headers", "rules.exposeHeaders"],
        [`POST ${A}/realtime/kit/{app_id}/presets`, "data.ui.design_tokens"],
        [`GET ${A}/realtime/kit/{app_id}/presets/{preset_id}`, "data.ui.design_tokens"],
        [`PUT ${A}/realtime/kit/{app_id}/presets/{preset_id}`, "data.ui.design_tokens"],
        [`PATCH ${A}/realtime/kit/{app_id}/presets/{preset_id}`, "data.ui.design_tokens"],
        [`DELETE ${A}/realtime/kit/{app_id}/presets/{preset_id}`, "data.ui.design_tokens"],
        [`GET ${A}/slurper/jobs`, "source.keys"],
        [`GET ${A}/slurper/jobs/{job_id}`, "source.keys"],
        [`PUT ${A}/storage/kv/namespaces/{namespace_id}/bulk`, "unsuccessful_keys"],
        [`POST ${A}/storage/kv/namespaces/{namespace_id}/bulk/delete`, "unsuccessful_keys"],
        [`GET /organizations/{organization_id}/logs/audit`, "actor.context"],
        [`GET /organizations/{organization_id}/logs/audit/{id}/history`, "actor.context"],
        [`POST /subscriptions/{subscription_id}/consume`, "records.headers"],
        [`GET ${Z}/managed_headers`, "managed_request_headers", "managed_response_headers"],
        [`PATCH ${Z}/managed_headers`, "managed_request_headers", "managed_response_headers"],
      ] as const
    ).map(([key, ...paths]) => [key, safe(DESCRIBED_ONLY, ...paths.filter(Boolean))]),
  ),
  ...Object.fromEntries(
    [
      `GET ${A}/load_balancers/pools`,
      `POST ${A}/load_balancers/pools`,
      `PATCH ${A}/load_balancers/pools`,
      `GET ${A}/load_balancers/pools/{pool_id}`,
      `PUT ${A}/load_balancers/pools/{pool_id}`,
      `PATCH ${A}/load_balancers/pools/{pool_id}`,
      `GET /user/load_balancers/pools`,
      `POST /user/load_balancers/pools`,
      `PATCH /user/load_balancers/pools`,
      `GET /user/load_balancers/pools/{pool_id}`,
      `PUT /user/load_balancers/pools/{pool_id}`,
      `PATCH /user/load_balancers/pools/{pool_id}`,
    ].map((key) => [key, safe("An origin's header map is limited to Host.", "origins.header")]),
  ),
  ...Object.fromEntries(
    [
      `GET ${A}/load_balancers`,
      `POST ${A}/load_balancers`,
      `GET ${A}/load_balancers/{load_balancer_id}`,
      `PUT ${A}/load_balancers/{load_balancer_id}`,
      `PATCH ${A}/load_balancers/{load_balancer_id}`,
      `GET ${Z}/load_balancers`,
      `POST ${Z}/load_balancers`,
      `GET ${Z}/load_balancers/{load_balancer_id}`,
      `PUT ${Z}/load_balancers/{load_balancer_id}`,
      `PATCH ${Z}/load_balancers/{load_balancer_id}`,
    ].map((key) => [
      key,
      safe(
        "Session affinity names the headers to hash, not their values.",
        "session_affinity_attributes.headers",
        "rules.overrides.session_affinity_attributes.headers",
      ),
    ]),
  ),
  ...Object.fromEntries(
    [
      `GET ${A}/rulesets/phases/{ruleset_phase}/entrypoint`,
      `GET ${A}/rulesets/phases/{ruleset_phase}/entrypoint/versions/{ruleset_version}`,
      `GET ${A}/rulesets/{ruleset_id}`,
      `GET ${A}/rulesets/{ruleset_id}/versions/{ruleset_version}`,
      `GET ${A}/rulesets/{ruleset_id}/versions/{ruleset_version}/by_tag/{rule_tag}`,
      `GET ${Z}/rulesets/phases/{ruleset_phase}/entrypoint`,
      `GET ${Z}/rulesets/phases/{ruleset_phase}/entrypoint/versions/{ruleset_version}`,
      `GET ${Z}/rulesets/{ruleset_id}`,
      `GET ${Z}/rulesets/{ruleset_id}/versions/{ruleset_version}`,
      `GET ${Z}/rulesets/{ruleset_id}/versions/{ruleset_version}/by_tag/{rule_tag}`,
      `POST ${A}/rulesets`,
      `PUT ${A}/rulesets/phases/{ruleset_phase}/entrypoint`,
      `PUT ${A}/rulesets/{ruleset_id}`,
      `POST ${A}/rulesets/{ruleset_id}/rules`,
      `PATCH ${A}/rulesets/{ruleset_id}/rules/{rule_id}`,
      `DELETE ${A}/rulesets/{ruleset_id}/rules/{rule_id}`,
      `POST ${Z}/rulesets`,
      `PUT ${Z}/rulesets/phases/{ruleset_phase}/entrypoint`,
      `PUT ${Z}/rulesets/{ruleset_id}`,
      `POST ${Z}/rulesets/{ruleset_id}/rules`,
      `PATCH ${Z}/rulesets/{ruleset_id}/rules/{rule_id}`,
      `DELETE ${Z}/rulesets/{ruleset_id}/rules/{rule_id}`,
    ].map((key) => [key, RULESET]),
  ),
  ...Object.fromEntries(
    [
      `GET ${Z}/custom_certificates`,
      `POST ${Z}/custom_certificates`,
      `PUT ${Z}/custom_certificates/prioritize`,
      `GET ${Z}/custom_certificates/{custom_certificate_id}`,
      `PATCH ${Z}/custom_certificates/{custom_certificate_id}`,
      `GET ${Z}/ssl/certificate_packs`,
      `POST ${Z}/ssl/certificate_packs/order`,
      `GET ${Z}/ssl/certificate_packs/{certificate_pack_id}`,
      `PATCH ${Z}/ssl/certificate_packs/{certificate_pack_id}`,
    ].map((key) => [
      key,
      safe(DESCRIBED_ONLY, "geo_restrictions", "policy_restrictions", "certificates.geo_restrictions"),
    ]),
  ),
  // Round 3 (#801): candidates the consolidated detector surfaced (the union
  // of the two former detectors, with transfer, claim, invite, key, signing,
  // and webhook families).
  [`GET ${A}/abuse-reports/submitted/{report_id}`]: safe(
    "An abuse report; the authorization statement is the reporter's text.",
  ),
  [`GET ${A}/access/keys`]: safe("Signing key rotation settings; no key."),
  [`PUT ${A}/access/keys`]: safe("Signing key rotation settings; no key."),
  ...Object.fromEntries(
    [
      `GET ${A}/access/organizations`,
      `POST ${A}/access/organizations`,
      `PUT ${A}/access/organizations`,
      `GET ${A}/access/organizations/doh`,
      `PUT ${A}/access/organizations/doh`,
      `GET ${Z}/access/organizations`,
      `POST ${Z}/access/organizations`,
      `PUT ${Z}/access/organizations`,
    ].map((key) => [key, safe("Organization session and service-token policies; durations and flags, no token.")]),
  ),
  ...Object.fromEntries(
    [
      `GET ${A}/ai-gateway/custom-providers/costs`,
      `POST ${A}/ai-gateway/custom-providers/costs`,
      `GET ${A}/ai-gateway/custom-providers/costs/{id}`,
      `PATCH ${A}/ai-gateway/custom-providers/costs/{id}`,
      `DELETE ${A}/ai-gateway/custom-providers/costs/{id}`,
    ].map((key) => [key, safe("Per-token model pricing; no credential.")]),
  ),
  ...Object.fromEntries(
    [
      `GET ${A}/ai-gateway/gateways/{gateway_id}/datasets`,
      `POST ${A}/ai-gateway/gateways/{gateway_id}/datasets`,
      `GET ${A}/ai-gateway/gateways/{gateway_id}/datasets/{id}`,
      `PUT ${A}/ai-gateway/gateways/{gateway_id}/datasets/{id}`,
      `DELETE ${A}/ai-gateway/gateways/{gateway_id}/datasets/{id}`,
    ].map((key) => [key, safe("Dataset filters match log fields (model, cost, tokens).", "filters.value")]),
  ),
  ...Object.fromEntries(
    [
      `GET ${A}/ai-gateway/gateways/{gateway_id}/evaluations`,
      `POST ${A}/ai-gateway/gateways/{gateway_id}/evaluations`,
      `GET ${A}/ai-gateway/gateways/{gateway_id}/evaluations/{id}`,
      `DELETE ${A}/ai-gateway/gateways/{gateway_id}/evaluations/{id}`,
    ].map((key) => [key, safe("Evaluation datasets filter log fields.", "datasets.filters.value")]),
  ),
  [`GET ${A}/ai-gateway/gateways/{gateway_id}/logs`]: safe("Gateway logs with token counts; no credential."),
  [`GET ${A}/ai-gateway/gateways/{gateway_id}/logs/{id}`]: safe("A gateway log with token counts; no credential."),
  ...Object.fromEntries(
    [
      `GET ${A}/ai-gateway/gateways/{gateway_id}/provider_configs`,
      `POST ${A}/ai-gateway/gateways/{gateway_id}/provider_configs`,
      `GET ${A}/ai-gateway/gateways/{gateway_id}/provider_configs/{id}`,
      `DELETE ${A}/ai-gateway/gateways/{gateway_id}/provider_configs/{id}`,
    ].map((key) => [key, safe("The caller supplies the provider key; the response returns a masked preview.")]),
  ),
  [`POST ${A}/ai/run/{model_name}`]: safe("Model output and token usage counts; no credential."),
  [`GET ${A}/alerting/v3/destinations/webhooks`]: WEBHOOK_DESTINATION,
  [`POST ${A}/alerting/v3/destinations/webhooks`]: safe(ANSWERS_ID),
  [`GET ${A}/alerting/v3/destinations/webhooks/{webhook_id}`]: WEBHOOK_DESTINATION,
  [`PUT ${A}/alerting/v3/destinations/webhooks/{webhook_id}`]: safe(ANSWERS_ID),
  [`DELETE ${A}/alerting/v3/destinations/webhooks/{webhook_id}`]: safe(REVOKES),
  [`GET ${A}/billable/usage`]: safe(COUNTS),
  [`POST ${A}/billable/usage`]: safe(COUNTS),
  [`GET /organizations/{organization_id}/billable/usage`]: safe(COUNTS),
  ...Object.fromEntries(
    [
      `POST ${A}/cloudforce-one/requests`,
      `POST ${A}/cloudforce-one/requests/new`,
      `GET ${A}/cloudforce-one/requests/priority/quota`,
      `GET ${A}/cloudforce-one/requests/priority/{priority_id}`,
      `PUT ${A}/cloudforce-one/requests/priority/{priority_id}`,
      `GET ${A}/cloudforce-one/requests/{request_id}`,
      `PUT ${A}/cloudforce-one/requests/{request_id}`,
      `POST ${A}/cloudforce-one/v2/requests/{project_type}`,
      `GET ${A}/cloudforce-one/v2/requests/{project_type}/{request_id}`,
      `PUT ${A}/cloudforce-one/v2/requests/{project_type}/{request_id}`,
    ].map((key) => [key, safe(COUNTS, "tokens")]),
  ),
  ...Object.fromEntries(
    [
      `GET ${A}/cloudforce-one/requests/priority/quota`,
      `GET ${A}/cloudforce-one/requests/quota`,
      `GET ${A}/cloudforce-one/v2/requests/{project_type}/constants`,
      `GET ${A}/cloudforce-one/v2/requests/{project_type}/types`,
    ].map((key) => [key, safe(COUNTS)]),
  ),
  ...Object.fromEntries(
    (
      [
        [`GET ${A}/cloudforce-one/rules`, "rules.meta.value"],
        [`POST ${A}/cloudforce-one/rules`, "meta.value"],
        [`GET ${A}/cloudforce-one/rules/approvals/{id}`, "approval.current_rule.meta.value"],
        [`GET ${A}/cloudforce-one/rules/search`, "results.meta.value"],
        [`GET ${A}/cloudforce-one/rules/structured`, "rules.meta.value"],
        [`POST ${A}/cloudforce-one/rules/structured`, "meta.value"],
        [`PUT ${A}/cloudforce-one/rules/structured/approvals/{id}`, "approval.current_rule.meta.value"],
        [`GET ${A}/cloudforce-one/rules/structured/{id}`, "meta.value"],
        [`PUT ${A}/cloudforce-one/rules/structured/{id}`, "meta.value"],
        [`GET ${A}/cloudforce-one/rules/{id}`, "meta.value"],
        [`PUT ${A}/cloudforce-one/rules/{id}`, "meta.value"],
      ] as const
    ).map(([key, path]) => [key, safe("Detection rule metadata (key, type, value); no credential.", path)]),
  ),
  [`GET ${A}/cloudforce-one/v2/threat-signals/search`]: safe("Searches threat intelligence articles; no credential."),
  [`GET ${A}/cni/interconnects/{icon}/loa`]: safe("A Letter of Authorization for a cross-connect; no credential."),
  [`POST ${A}/data-security/posture/webhooks/evaluate`]: safe("Answers a delivery test's status and message."),
  [`POST ${A}/data-security/posture/webhooks/jobs`]: safe("Answers created and failed job ids."),
  [`DELETE ${A}/data-security/posture/webhooks/{webhook_id}`]: safe(REVOKES),
  [`POST ${A}/data-security/posture/webhooks/{webhook_id}/evaluate`]: safe(
    "Answers a delivery test's status and message.",
  ),
  [`GET ${A}/devices/physical-devices`]: safe(CURSOR),
  [`GET ${A}/devices/registrations`]: safe(CURSOR),
  [`DELETE ${A}/devices/registrations`]: safe(CURSOR),
  [`GET ${A}/r2/buckets`]: safe(CURSOR),
  [`GET ${A}/registrar-sandbox/extensions`]: safe(CURSOR),
  [`GET ${A}/registrar/extensions`]: safe(CURSOR),
  ...Object.fromEntries(
    [
      `GET ${A}/devices/posture`,
      `POST ${A}/devices/posture`,
      `GET ${A}/devices/posture/{rule_id}`,
      `PUT ${A}/devices/posture/{rule_id}`,
    ].map((key) => [key, safe("Device posture rules; check_private_key is a boolean.")]),
  ),
  ...Object.fromEntries(
    [
      `GET ${A}/dlp/datasets`,
      `GET ${A}/dlp/datasets/{dataset_id}`,
      `PUT ${A}/dlp/datasets/{dataset_id}`,
      `POST ${A}/dlp/datasets/{dataset_id}/upload/{version}`,
      `GET ${A}/dlp/entries`,
      `GET ${A}/dlp/entries/{entry_id}`,
      `PUT ${A}/dlp/entries/{entry_id}`,
    ].map((key) => [key, safe(DLP_FLAG, "secret")]),
  ),
  ...Object.fromEntries(
    [
      `GET ${A}/dlp/profiles`,
      `GET ${A}/dlp/profiles/custom`,
      `POST ${A}/dlp/profiles/custom`,
      `GET ${A}/dlp/profiles/custom/{profile_id}`,
      `PUT ${A}/dlp/profiles/custom/{profile_id}`,
      `POST ${A}/dlp/profiles/predefined`,
      `GET ${A}/dlp/profiles/predefined/{profile_id}`,
      `PUT ${A}/dlp/profiles/predefined/{profile_id}`,
      `GET ${A}/dlp/profiles/predefined/{profile_id}/config`,
      `POST ${A}/dlp/profiles/predefined/{profile_id}/config`,
      `PUT ${A}/dlp/profiles/predefined/{profile_id}/config`,
      `GET ${A}/dlp/profiles/{profile_id}`,
    ].map((key) => [key, safe(DLP_FLAG, "entries.secret", "shared_entries.secret")]),
  ),
  [`GET ${A}/email-security/settings/domains/{domain_id}/verification`]: safe(
    "The TXT record value is published in DNS to prove ownership.",
  ),
  ...Object.fromEntries(
    [
      `GET ${A}/gateway/locations`,
      `POST ${A}/gateway/locations`,
      `GET ${A}/gateway/locations/{location_id}`,
      `PUT ${A}/gateway/locations/{location_id}`,
    ].map((key) => [key, safe("Gateway locations; require_token is a boolean.")]),
  ),
  ...Object.fromEntries(
    [
      `GET ${A}/hyperdrive/configs`,
      `POST ${A}/hyperdrive/configs`,
      `GET ${A}/hyperdrive/configs/{hyperdrive_id}`,
      `PUT ${A}/hyperdrive/configs/{hyperdrive_id}`,
      `PATCH ${A}/hyperdrive/configs/{hyperdrive_id}`,
      `POST ${A}/hyperdrive/configs/{hyperdrive_id}/restart`,
    ].map((key) => [key, HYPERDRIVE]),
  ),
  ...Object.fromEntries(
    (
      [
        [`GET ${A}/iam/resource_groups`, "meta.value"],
        [`POST ${A}/iam/resource_groups`, "meta.value"],
        [`GET ${A}/iam/resource_groups/{resource_group_id}`, "meta.value"],
        [`PUT ${A}/iam/resource_groups/{resource_group_id}`, "meta.value"],
        [`GET ${A}/iam/user_groups`, "policies.resource_groups.meta.value"],
        [`POST ${A}/iam/user_groups`, "policies.resource_groups.meta.value"],
        [`GET ${A}/iam/user_groups/{user_group_id}`, "policies.resource_groups.meta.value"],
        [`PUT ${A}/iam/user_groups/{user_group_id}`, "policies.resource_groups.meta.value"],
        [`GET ${A}/members`, "policies.resource_groups.meta.value"],
        [`POST ${A}/members`, "policies.resource_groups.meta.value"],
        [`GET ${A}/members/{member_id}`, "policies.resource_groups.meta.value"],
        [`PUT ${A}/members/{member_id}`, "policies.resource_groups.meta.value"],
        [`GET /memberships`, "policies.resource_groups.meta.value"],
        [`GET /memberships/{membership_id}`, "policies.resource_groups.meta.value"],
        [`PUT /memberships/{membership_id}`, "policies.resource_groups.meta.value"],
        [`GET /user/memberships/{membership_id}`, "policies.resource_groups.meta.value"],
      ] as const
    ).map(([key, path]) => [key, safe("Resource group attributes scope a policy; no credential.", path)]),
  ),
  ...Object.fromEntries(
    [
      `GET ${A}/k2/streams`,
      `POST ${A}/k2/streams`,
      `GET ${A}/k2/streams/{stream_id}`,
      `PATCH ${A}/k2/streams/{stream_id}`,
    ].map((key) => [
      key,
      safe("http.authentication is a boolean: whether producers need a token.", "http.authentication"),
    ]),
  ),
  ...Object.fromEntries(
    [
      `GET ${A}/magic/cloud/providers`,
      `POST ${A}/magic/cloud/providers`,
      `GET ${A}/magic/cloud/providers/{provider_id}`,
      `PUT ${A}/magic/cloud/providers/{provider_id}`,
      `PATCH ${A}/magic/cloud/providers/{provider_id}`,
    ].map((key) => [key, safe("Cloud provider integrations report credential health timestamps, not credentials.")]),
  ),
  ...Object.fromEntries(
    [
      `GET ${A}/mtls_certificates`,
      `POST ${A}/mtls_certificates`,
      `GET ${A}/mtls_certificates/{mtls_certificate_id}`,
      `DELETE ${A}/mtls_certificates/{mtls_certificate_id}`,
      `GET ${Z}/acm/custom_trust_store`,
      `POST ${Z}/acm/custom_trust_store`,
      `GET ${Z}/acm/custom_trust_store/{custom_origin_trust_store_id}`,
      `GET ${Z}/client_certificates`,
      `POST ${Z}/client_certificates`,
      `GET ${Z}/client_certificates/{client_certificate_id}`,
      `PATCH ${Z}/client_certificates/{client_certificate_id}`,
      `DELETE ${Z}/client_certificates/{client_certificate_id}`,
      `GET ${Z}/origin_tls_client_auth/hostnames/certificates`,
      `POST ${Z}/origin_tls_client_auth/hostnames/certificates`,
      `GET ${Z}/origin_tls_client_auth/hostnames/certificates/{certificate_id}`,
      `DELETE ${Z}/origin_tls_client_auth/hostnames/certificates/{certificate_id}`,
      `GET ${Z}/origin_tls_client_auth/hostnames/{hostname}`,
      `GET ${Z}/ssl/verification`,
    ].map((key) => [key, safe(CERTIFICATE)]),
  ),
  ...Object.fromEntries(
    [
      `GET ${A}/oauth_clients`,
      `GET ${A}/oauth_clients/{oauth_client_id}`,
      `PATCH ${A}/oauth_clients/{oauth_client_id}`,
    ].map((key) => [
      key,
      safe(
        "OAuth client registrations: ids, URIs, and whether a secret was rotated; the secret itself is refused at creation.",
      ),
    ]),
  ),
  [`GET ${A}/one/applications/{application_id}/setup-flows`]: safe(
    "Setup flows describe the OAuth authorization URL and form fields to fill, not credentials.",
    "steps.form_fields.name",
    "steps.form_fields.type",
  ),
  ...Object.fromEntries(
    [
      `GET ${A}/realtime/kit/{app_id}/meetings`,
      `POST ${A}/realtime/kit/{app_id}/meetings`,
      `GET ${A}/realtime/kit/{app_id}/meetings/{meeting_id}`,
      `PUT ${A}/realtime/kit/{app_id}/meetings/{meeting_id}`,
      `PATCH ${A}/realtime/kit/{app_id}/meetings/{meeting_id}`,
    ].map((key) => [key, KIT_MEETING_STORAGE]),
  ),
  ...Object.fromEntries(
    [
      `POST ${A}/realtime/kit/{app_id}/recordings`,
      `GET ${A}/realtime/kit/{app_id}/recordings/{recording_id}`,
      `PUT ${A}/realtime/kit/{app_id}/recordings/{recording_id}`,
    ].map((key) => [key, KIT_RECORDING_STORAGE]),
  ),
  [`GET ${A}/realtime/kit/{app_id}/recordings`]: reviewed(
    KIT_STORAGE_REASON,
    storageCredentials("data.storage_config", "data.meeting.recording_config.storage_config"),
  ),
  ...Object.fromEntries(
    [
      `GET ${A}/realtime/kit/{app_id}/webhooks`,
      `POST ${A}/realtime/kit/{app_id}/webhooks`,
      `GET ${A}/realtime/kit/{app_id}/webhooks/{webhook_id}`,
      `PUT ${A}/realtime/kit/{app_id}/webhooks/{webhook_id}`,
      `PATCH ${A}/realtime/kit/{app_id}/webhooks/{webhook_id}`,
      `DELETE ${A}/realtime/kit/{app_id}/webhooks/{webhook_id}`,
    ].map((key) => [key, KIT_WEBHOOK]),
  ),
  [`GET ${A}/realtime/kit/{app_id}/webhooks/all`]: safe("Lists event names a webhook can subscribe to."),
  [`POST ${A}/registrar/domain-transfer-check`]: safe("Answers transfer eligibility; no auth code."),
  [`POST ${A}/registrar/registrations/{domain_name}/transfer-in`]: safe(
    "Answers a workflow status; the auth code is request input only.",
  ),
  [`GET ${A}/registrar/registrations/{domain_name}/transfer-in-status`]: safe("Answers a transfer status."),
  [`POST ${A}/storage/kv/namespaces/{namespace_id}/bulk/get`]: safe(KV_DATA),
  [`GET ${A}/storage/kv/namespaces/{namespace_id}/keys`]: safe("Lists key names and metadata in a namespace."),
  [`GET ${A}/storage/kv/namespaces/{namespace_id}/metadata/{key_name}`]: safe(KV_DATA),
  [`GET ${A}/storage/kv/namespaces/{namespace_id}/values/{key_name}`]: safe(KV_DATA),
  [`PUT ${A}/storage/kv/namespaces/{namespace_id}/values/{key_name}`]: safe(
    "Answers a status; the value is request input.",
  ),
  [`DELETE ${A}/storage/kv/namespaces/{namespace_id}/values/{key_name}`]: safe(REVOKES),
  [`DELETE ${A}/stream/webhook`]: safe(REVOKES),
  [`GET ${A}/tags/keys`]: safe("Lists resource tag keys; no credential."),
  [`GET ${A}/tags/summary`]: safe("Summarizes resource tags; no credential."),
  ...Object.fromEntries(
    [`POST ${A}/vuln_scanner/scans`, `GET ${A}/vuln_scanner/scans/{scan_id}`].map((key) => [
      key,
      safe(
        "Scan reports name the credential set a step used; credential values stay write-only.",
        "report.report.tests.steps.request.credential_set",
      ),
    ]),
  ),
  ...Object.fromEntries(
    [
      `GET ${A}/waiting_rooms`,
      `GET ${Z}/waiting_rooms`,
      `POST ${Z}/waiting_rooms`,
      `GET ${Z}/waiting_rooms/{waiting_room_id}`,
      `PUT ${Z}/waiting_rooms/{waiting_room_id}`,
      `PATCH ${Z}/waiting_rooms/{waiting_room_id}`,
      `GET ${Z}/waiting_rooms/settings`,
      `PUT ${Z}/waiting_rooms/settings`,
      `PATCH ${Z}/waiting_rooms/settings`,
    ].map((key) => [key, safe("Waiting room settings; cookie attributes and the crawler bypass are flags.")]),
  ),
  [`GET ${A}/workers/dispatch/namespaces/{dispatch_namespace}/scripts/{script_name}/bindings`]: BINDING_VALUES,
  ...Object.fromEntries(
    [
      `GET ${A}/workers/dispatch/namespaces/{dispatch_namespace}/scripts`,
      `GET ${A}/workers/dispatch/namespaces/{dispatch_namespace}/scripts/{script_name}`,
      `PUT ${A}/workers/dispatch/namespaces/{dispatch_namespace}/scripts/{script_name}`,
      `PUT ${A}/workers/dispatch/namespaces/{dispatch_namespace}/scripts/{script_name}/content`,
      `GET ${A}/workers/scripts`,
      `PUT ${A}/workers/scripts/{script_name}`,
      `PUT ${A}/workers/scripts/{script_name}/content`,
      `GET ${A}/workers/scripts/{script_name}/script-settings`,
      `PATCH ${A}/workers/scripts/{script_name}/script-settings`,
      `PUT ${A}/workers/services/{service_name}/environments/{environment_name}/content`,
      `GET ${A}/workers/services/{service_name}/environments/{environment_name}/settings`,
      `PATCH ${A}/workers/services/{service_name}/environments/{environment_name}/settings`,
    ].map((key) => [key, TRACE_POLICY()]),
  ),
  ...Object.fromEntries(
    [
      `GET ${A}/workers/workers`,
      `POST ${A}/workers/workers`,
      `GET ${A}/workers/workers/{worker_id}`,
      `PUT ${A}/workers/workers/{worker_id}`,
      `PATCH ${A}/workers/workers/{worker_id}`,
    ].map((key) => [key, WORKER]),
  ),
  ...Object.fromEntries(
    (
      [
        [`GET ${A}/workers/observability/queries`, "parameters.filters.value", "parameters.havings.value"],
        [`POST ${A}/workers/observability/queries`, "parameters.filters.value", "parameters.havings.value"],
        [`GET ${A}/workers/observability/queries/{queryId}`, "parameters.filters.value", "parameters.havings.value"],
        [`PATCH ${A}/workers/observability/queries/{queryId}`, "parameters.filters.value", "parameters.havings.value"],
        [`DELETE ${A}/workers/observability/queries/{queryId}`, "parameters.filters.value", "parameters.havings.value"],
        [`POST ${A}/workers/observability/telemetry/keys`],
        [`POST ${A}/workers/observability/telemetry/values`, "value"],
        ...[`GET ${A}/workers/observability/shared/query/{id}`, `POST ${A}/workers/observability/telemetry/query`].map(
          (key) =>
            [
              key,
              "calculations.aggregates.groups.value",
              "calculations.series.data.groups.value",
              "compare.aggregates.groups.value",
              "compare.series.data.groups.value",
              "run.query.parameters.filters.value",
              "run.query.parameters.havings.value",
            ] as const,
        ),
      ] as const
    ).map(([key, ...paths]) => [key, safe(OBSERVABILITY, ...paths)]),
  ),
  ...Object.fromEntries(
    [
      `GET ${A}/workflows/concurrency`,
      `POST ${A}/workflows/concurrency`,
      `GET ${A}/workflows/concurrency/{key_id}`,
      `PATCH ${A}/workflows/concurrency/{key_id}`,
      `DELETE ${A}/workflows/concurrency/{key_id}`,
    ].map((key) => [key, safe("Workflow concurrency keys: names and limits, not credentials.")]),
  ),
  [`GET /billing/rate_plans/{public_key}`]: safe("A public rate plan catalog entry."),
  [`PUT /organizations/{organization_id}/invites/{member_code}`]: safe(
    "Accepts an invitation with a code the caller holds; answers the membership.",
  ),
  [`GET /radar/bots/{bot_slug}`]: safe("A verified bot's public profile."),
  [`GET /user/invites`]: safe("Invitation metadata (organization, roles, status); no invite code."),
  [`GET /user/invites/{invite_id}`]: safe("Invitation metadata (organization, roles, status); no invite code."),
  [`PATCH /user/invites/{invite_id}`]: safe("Answers the invitation's status; no invite code."),
  ...Object.fromEntries(
    [`GET ${Z}/api_gateway/configuration`, `PUT ${Z}/api_gateway/configuration`].map((key) => [
      key,
      safe(
        "auth_id_characteristics name the header or cookie that identifies a session, not its value.",
        "auth_id_characteristics.name",
      ),
    ]),
  ),
  ...Object.fromEntries(
    [
      `GET ${Z}/api_gateway/operations`,
      `POST ${Z}/api_gateway/operations`,
      `POST ${Z}/api_gateway/operations/item`,
      `GET ${Z}/api_gateway/operations/{operation_id}`,
      `GET ${Z}/schema_validation/schemas/{schema_id}/operations`,
    ].map((key) => [key, safe("API operations with session-count thresholds; no credential.")]),
  ),
  [`DELETE ${Z}/custom_hostnames/{custom_hostname_id}/certificate_pack/{certificate_pack_id}/certificates/{certificate_id}`]:
    safe(REVOKES),
  ...Object.fromEntries(
    [`GET ${Z}/images/v1/flows`, `PUT ${Z}/images/v1/flows`].map((key) => [
      key,
      safe(
        "Image flow transformation and trigger parameters.",
        "flows.transformations.value",
        "flows.trigger.params.value",
      ),
    ]),
  ),
  [`POST ${Z}/secondary_dns/outgoing/disable`]: safe("Answers outgoing zone transfer status; no TSIG secret."),
  [`POST ${Z}/secondary_dns/outgoing/enable`]: safe("Answers outgoing zone transfer status; no TSIG secret."),
  [`GET ${Z}/secondary_dns/outgoing/status`]: safe("Answers outgoing zone transfer status; no TSIG secret."),
};

/**
 * Cloudflare's reviewed table. Pagination cursors share the credential
 * vocabulary but grant nothing; redacting them would break paging, so they
 * are reviewed metadata wherever they appear.
 */
export const CLOUDFLARE_VALUE_SAFETY: ValueSafetyTable = {
  title: "Cloudflare",
  operations: OPERATIONS,
  fields: {
    ...Object.fromEntries(
      [
        "page_token",
        "pageToken",
        "next_page_token",
        "nextPageToken",
        "continuation_token",
        "continuationToken",
        "next_continuation_token",
        "nextContinuationToken",
      ].map((name) => [name, { verdict: "keep" as const, reason: "A pagination cursor; it grants nothing." }]),
    ),
    signature: {
      verdict: "redact",
      reason: "Certificates name their signature algorithm here; withheld as credential vocabulary, as before.",
    },
    ...Object.fromEntries(
      (
        [
          ["claim_value", "An OIDC claim value an Access rule matches."],
          ["scopes", "OAuth scope names, not tokens."],
          ["token_url", "An IdP or SCIM token endpoint URL; public configuration."],
          ["authorization_url", "An OAuth authorization endpoint URL; public configuration."],
          ["certs_url", "A JWKS URL; public configuration."],
          ["redirect_uris", "OAuth redirect URIs; public configuration."],
          ["access_token_lifetime", "A token lifetime setting."],
          ["refresh_token_options", "Refresh token lifetime settings."],
          ["lifetime", "A lifetime setting."],
          ["group_filter_regex", "A group name filter."],
          ["name_by_idp", "Claim names per identity provider."],
          ["options_preflight_bypass", "A CORS preflight flag."],
          ["allow_pkce_without_client_secret", "An OAuth flow flag."],
          ["return_access_token_from_authorization_endpoint", "An OAuth flow flag."],
          ["return_id_token_from_authorization_endpoint", "An OAuth flow flag."],
          ["allow_credentials", "A CORS flag."],
          ["strict_service_token_auth", "A service token policy flag."],
          ["service_token_inactivity", "A service token inactivity policy."],
          ["amr_matching_session_duration", "A session duration."],
          ["doh_jwt_duration", "A token lifetime setting."],
          ["token_endpoint_auth_method", "An OAuth client authentication method name."],
          ["has_rotated_secret", "Whether a client secret was rotated; a flag."],
          ["secret_preview", "A masked preview of a caller-supplied key."],
          ["token_pricing", "Per-token model pricing."],
          ["tokens_in", "A token count."],
          ["tokens_out", "A token count."],
          ["message_tokens", "A token count."],
          ["request_tokens", "A token count."],
          ["response_tokens", "A token count."],
          ["prompt_tokens", "A token count."],
          ["completion_tokens", "A token count."],
          ["priority_token_surcharge", "A request cost."],
          ["auth_id_tokens", "A count of session identifiers seen."],
          ["keyword_tokenizer", "A search tokenizer name."],
          ["require_token", "Whether a DoH endpoint requires a token; a flag."],
          ["check_private_key", "A posture check flag."],
          ["search_engine_crawler_bypass", "A waiting room flag."],
          ["allow_child_bypass", "A gateway rule flag."],
          ["bypass_parent_rule", "A gateway rule flag."],
          ["cookie_attributes", "Cookie attribute settings (SameSite, Secure)."],
          ["strip_set_cookie", "A cache rule flag."],
          ["cookie_fields", "Cookie names a rule logs."],
          ["cookieDomain", "The domain Zaraz writes cookies for."],
          ["enable_binding_cookie", "An Access flag."],
          ["http_only_cookie_attribute", "An Access cookie flag."],
          ["same_site_cookie_attribute", "An Access cookie setting."],
          ["path_cookie_attribute", "An Access cookie flag."],
          ["eager_redirect_cookie_setting", "An Access cookie setting."],
          ["host_header", "A hostname a rule sets."],
          ["propagation_policy", "A trace context propagation policy name."],
          ["credentials_good_since", "A credential health timestamp."],
          ["credentials_missing_since", "A credential health timestamp."],
          ["credentials_rejected_since", "A credential health timestamp."],
          ["is_secret", "Whether a variable is hidden; a flag."],
          ["is_selectable", "Whether a permission group is selectable; a flag."],
          ["case_sensitive", "A DLP matching flag."],
          ["byok_only", "Whether a gateway requires caller-supplied keys; a flag."],
          ["sign_request", "Whether SAML requests are signed; a flag."],
          ["signatureAgentUrl", "A verified bot's public key directory URL."],
          ["reg_who_authorization_statement", "An abuse reporter's statement."],
          ["password_expression", "An expression locating a password field, not a password."],
          ["username_expression", "An expression locating a username field."],
          ["token_sources", "Header or cookie names a token is read from."],
          ["http_body", "A domain control validation token, published on the origin."],
          ["http_url", "Where a domain control validation token is published."],
          ["txt_record_value", "A TXT record value published in DNS."],
          ["author_email", "A deployment author's email."],
          ["BilledCost", "A billed amount."],
          ["EffectiveCost", "A billed amount."],
          ["quota", "A request quota."],
          ["remaining", "A remaining request count."],
          ["id", "An identifier."],
        ] as const
      ).map(([name, reason]) => [name, { verdict: "keep" as const, reason }]),
    ),
  },
};
