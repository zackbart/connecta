// Cloudflare's reviewed value-safety table (#801): every operation whose path,
// summary, or success-response fields carry credential vocabulary has one
// verdict here. `provider.test.ts` derives the candidates from the pinned
// index (`openapi.secrets` records the spec's credential-named response
// fields) and fails on any candidate without a verdict.
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

export type ValueSafetyVerdict =
  | { readonly refuse: string }
  | { readonly redact: readonly string[]; readonly keep?: readonly string[] }
  | { readonly safe: string; readonly keep?: readonly string[] };

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

const METADATA = "Returns names, ids, status, and timestamps; no credential value.";
const REVOKES = "Revokes or deletes; returns no credential value.";
const CALLER_SUPPLIED = "The caller supplies the secret; the response returns only its name and metadata.";

const refuse = (reason: string) => ({ refuse: reason }) as const;
const redact = (...paths: string[]) => ({ redact: paths }) as const;
const safe = (reason: string, ...keep: string[]) => ({ safe: reason, ...(keep.length ? { keep } : {}) }) as const;

const ACCESS_APP = redact(
  "saas_app.client_secret",
  "scim_config.authentication.client_secret",
  "scim_config.authentication.password",
  "scim_config.authentication.token",
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
const IDENTITY_PROVIDER = redact("config.client_secret", "scim_config.secret");
const PAGES_PROJECT = safe(
  "The Web Analytics token is a public beacon id embedded in every page.",
  "build_config.web_analytics_token",
  "canonical_deployment.build_config.web_analytics_token",
  "latest_deployment.build_config.web_analytics_token",
);
const LIVE_INPUT = redact(
  "rtmps.streamKey",
  "rtmpsPlayback.streamKey",
  "srt.passphrase",
  "srtPlayback.passphrase",
  "webRTC.url#url",
);
const WORKER_SECRET = redact("text", "key_base64", "key_jwk");
const WORKER_VERSION = redact("assets.jwt");
const ZARAZ = redact("variables.*.value", "debugKey", "*.variables.*.value", "*.debugKey");
const TSIG = redact("secret");
const LIVESTREAM = redact("data.stream_key", "data.livestream.stream_key", "data.livestreams.stream_key");

const A = "/accounts/{account_id}";
const Z = "/zones/{zone_id}";

export const VALUE_SAFETY: Readonly<Record<string, ValueSafetyVerdict>> = {
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
  [`GET ${A}/ai-gateway/gateways`]: redact("otel.authorization", "stripe.authorization"),
  [`POST ${A}/ai-gateway/gateways`]: redact("otel.authorization", "stripe.authorization"),
  [`GET ${A}/ai-gateway/gateways/{id}`]: redact("otel.authorization", "stripe.authorization"),
  [`PUT ${A}/ai-gateway/gateways/{id}`]: redact("otel.authorization", "stripe.authorization"),
  [`DELETE ${A}/ai-gateway/gateways/{id}`]: redact("otel.authorization", "stripe.authorization"),
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
  [`GET ${A}/containers/applications`]: safe("A pagination cursor.", "next_page_token", "page_token"),
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
  [`POST ${A}/dlp/datasets`]: redact("secret"),
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
  [`POST ${A}/magic/ipsec_tunnels/psk`]: redact("successfully_applied_psks.*.psk"),
  [`POST ${A}/magic/ipsec_tunnels/{ipsec_tunnel_id}/psk_generate`]: refuse(MINT),
  [`POST ${A}/mnm/vpc-flows/token`]: refuse(MINT),
  [`POST ${A}/managed-defense/vulnerability-discovery/repos`]: redact("upload.token"),
  // MoQ
  [`POST ${A}/moq/relays`]: redact("issuers.cloudflare_tokens.secret"),
  [`GET ${A}/moq/relays/{relay_id}/tokens`]: redact("issuers.cloudflare_tokens.secret"),
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
      `GET ${A}/secrets_store/quota`,
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
  [`GET ${Z}/leaked-credential-checks`]: safe(METADATA),
  [`POST ${Z}/leaked-credential-checks`]: safe(METADATA),
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
    ].map((key) => [key, safe("cookie lists cache-key cookie names.", "actions.value.cookie")]),
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
  [`PUT ${Z}/token_validation/config/{config_id}/credentials`]: safe("Public JWKS keys."),
  [`PATCH ${Z}/token_validation/config/{config_id}/credentials`]: safe("Public JWKS keys."),
  [`GET ${Z}/token_validation/rules`]: safe(METADATA),
  [`POST ${Z}/token_validation/rules`]: safe(METADATA),
  [`POST ${Z}/token_validation/rules/bulk`]: safe(METADATA),
  [`PATCH ${Z}/token_validation/rules/bulk`]: safe(METADATA),
  [`POST ${Z}/token_validation/rules/preview`]: safe(METADATA),
  [`GET ${Z}/token_validation/rules/{rule_id}`]: safe(METADATA),
  [`PATCH ${Z}/token_validation/rules/{rule_id}`]: safe(METADATA),
  [`DELETE ${Z}/token_validation/rules/{rule_id}`]: safe(REVOKES),
};

/** Normalized key names the heuristic treats as credentials (compared lowercase, without `_` or `-`). */
const CREDENTIAL_KEY =
  /(token|secret|password|passphrase|privatekey|apikey|authkey|authorization|cookie|signature|jwt|credentials?|psk|streamkey|uploadurl|signedurl|jwk|verifier|devicecode|bypass)$/;
/** Pagination cursors share the vocabulary but grant nothing; redacting them would break paging. */
const CURSORS = new Set(["pagetoken", "nextpagetoken", "continuationtoken", "nextcontinuationtoken"]);
/** Query parameters that carry credentials inside a URL. */
const CREDENTIAL_PARAM = /(token|secret|password|passphrase|key|signature|sig|credential|auth|authorization|jwt)$/;
const REDACTED = "[redacted]";

function normalized(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, "");
}

/** A URL with its userinfo password and credential-named query values replaced. */
function sanitizeUrl(value: string): string {
  if (!/^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(value)) return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value;
  }
  let changed = false;
  if (url.password) {
    url.password = REDACTED;
    changed = true;
  }
  for (const name of new Set(url.searchParams.keys())) {
    if (CREDENTIAL_PARAM.test(normalized(name))) {
      url.searchParams.set(name, REDACTED);
      changed = true;
    }
  }
  return changed ? url.toString() : value;
}

/** Only a URL's scheme and host: its path or query may itself be the credential. */
function urlHost(value: unknown): unknown {
  if (typeof value !== "string") return value === null || value === undefined ? value : REDACTED;
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname.length > 1 || url.search ? "/[redacted]" : ""}`;
  } catch {
    return REDACTED;
  }
}

function eachAt(
  value: unknown,
  parts: readonly string[],
  apply: (holder: Record<string, unknown>, key: string) => void,
) {
  if (Array.isArray(value)) {
    for (const item of value) eachAt(item, parts, apply);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const holder = value as Record<string, unknown>;
  const [head, ...rest] = parts;
  if (head === undefined) return;
  const keys = head === "*" ? Object.keys(holder) : Object.hasOwn(holder, head) ? [head] : [];
  for (const key of keys) {
    if (rest.length === 0) apply(holder, key);
    else eachAt(holder[key], rest, apply);
  }
}

function clone(value: unknown): unknown {
  return value === undefined ? undefined : (JSON.parse(JSON.stringify(value)) as unknown);
}

/** Replace every string under a credential-bearing node, keeping its shape. */
function scrub(value: unknown): unknown {
  if (typeof value === "string") return REDACTED;
  if (Array.isArray(value)) return value.map(scrub);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrub(item)]));
  }
  return value;
}

/**
 * Apply an operation's reviewed redactions, then the key-name heuristic, the
 * typed-secret rule (`{ type: "secret…", value }`), and URL sanitization
 * across the whole value. Runs on every method's successful data.
 */
export function redactValues(data: unknown, verdict: ValueSafetyVerdict | undefined): unknown {
  if (typeof data !== "object" || data === null) return typeof data === "string" ? sanitizeUrl(data) : data;
  const out = clone(data);
  if (verdict && "redact" in verdict) {
    for (const path of verdict.redact) {
      const [field, mode] = path.split("#");
      eachAt(out, field!.split("."), (holder, key) => {
        if (holder[key] === null || holder[key] === undefined) return;
        holder[key] = mode === "url" ? urlHost(holder[key]) : REDACTED;
      });
    }
  }
  const keep = new Set(verdict && "keep" in verdict ? verdict.keep : []);
  const walk = (value: unknown, path: string): unknown => {
    if (typeof value === "string") return sanitizeUrl(value);
    if (Array.isArray(value)) return value.map((item) => walk(item, path));
    if (typeof value !== "object" || value === null) return value;
    const record = value as Record<string, unknown>;
    const typedSecret = typeof record["type"] === "string" && /secret/i.test(record["type"]);
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(record)) {
      const at = path ? `${path}.${key}` : key;
      const name = normalized(key);
      if (keep.has(at) || CURSORS.has(name)) result[key] = item;
      else if (CREDENTIAL_KEY.test(name)) result[key] = scrub(item);
      else if (typedSecret && (key === "value" || key === "text") && typeof item === "string") result[key] = REDACTED;
      else result[key] = walk(item, at);
    }
    return result;
  };
  return walk(out, "");
}
