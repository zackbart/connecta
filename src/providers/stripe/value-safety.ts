// Stripe's reviewed value-safety table (#801), on the shared mechanism in
// `../_shared/rest/value-safety.ts`: every operation the detector flags in the
// pinned spec (`value-safety.candidates.json`) has one verdict here, and
// `value-safety.node.test.ts` runs the shared harness over it.
//
// Stripe repeats one object graph across hundreds of operations (a
// PaymentIntent is embedded in charges, invoices, and errors), so most flagged
// fields are reviewed once for the whole API in `fields` rather than per
// operation, and the detector does not walk id-or-object expansions
// (`expansions: false`): Stripe answers an id unless the caller expands it,
// and the field review and heuristic apply to whatever an expansion returns.
//
// The decisions against the bar (decision 0005, "Value safety"):
//
// - Refused: operations whose purpose is to hand out a credential. Ephemeral
//   keys and Terminal connection tokens are API credentials; account links,
//   login links, account sessions, customer sessions, and billing portal
//   sessions sign their holder into a Stripe-hosted surface as a connected
//   account or a customer; a file link makes a private file (dispute
//   evidence, identity documents) public; Financial Connections sessions and
//   the meter event session exist to return a client secret or a stream
//   token. Stripe's OAuth endpoints (connect.stripe.com) are not in the
//   pinned spec, so the generic tools refuse them as unknown paths.
// - Redacted: client secrets (PaymentIntents, SetupIntents, Checkout and
//   Identity sessions, Sources, Financial Connections, invoice confirmation
//   secrets). They are publishable-side secrets: with the account's
//   publishable key they confirm, complete, or read the object from a
//   browser. Connecta's agent works server-side and never needs one, while
//   the objects around them are the API's core, so the field goes and the
//   operation stays. Webhook and event destination signing secrets, Apps
//   secret payloads, app-install OAuth codes, Terminal Wi-Fi passwords,
//   forwarded request header values, pre-signed upload URLs, and file link
//   URLs go the same way.
// - Kept verbatim: hosted Checkout and Identity verification URLs. They are
//   payer-facing pages whose purpose is to be sent to the customer; they
//   grant no access to the account, only the ability to pay or verify, and
//   their fragment is opaque state the page needs.
// - Issuing card numbers and CVCs come back only as expansions, which the
//   connector refuses on every Issuing path (`rest.ts`); the card operations
//   also redact both fields.
import {
  redact,
  refuse,
  safe,
  vendorErrors,
  type ValueSafetyTable,
  type ValueSafetyVerdict,
} from "../_shared/rest/value-safety.js";

const EPHEMERAL_KEY =
  "It mints an ephemeral API key whose `secret` makes authorized Stripe API requests for a customer or Issuing card.";
const CONNECTION_TOKEN = "It mints a Terminal connection token whose `secret` connects a reader SDK to this account.";
const ACCOUNT_LINK =
  "It creates a single-use link that lets its holder enter or change a connected account's identity and bank details. Create account links from your platform's server code or the Dashboard.";
const LOGIN_LINK = "It creates a single-use link that signs its holder into a connected account's Express Dashboard.";
const ACCOUNT_SESSION = "It returns a client secret that grants embedded-component access to a connected account.";
const CUSTOMER_SESSION =
  "It returns a client secret that grants client-side access to a customer's saved payment methods.";
const PORTAL_SESSION =
  "It creates a customer portal session whose URL signs its holder in as the customer (payment methods, subscriptions, invoices).";
const FILE_LINK =
  "It creates a public URL to a private file (dispute evidence and identity documents among them) that anyone holding it can download.";
const FC_SESSION = "It exists to return a client secret for the Financial Connections authorization flow in a browser.";
const METER_SESSION = "It mints an authentication token for the meter event stream.";
const EPHEMERAL_REVOKE = "Revokes an ephemeral key; the answer repeats the key's secret, which is redacted.";
const WEBHOOK =
  "Webhook endpoints carry a signing secret and a destination URL whose path or query can be a bearer secret.";
const EVENT_DESTINATION =
  "Event destinations carry a webhook signing secret and a destination URL whose path or query can be a bearer secret.";
const APPS_SECRET =
  "An Apps secret's payload is the stored secret value; names and scopes stay. Expanding payload is also refused (`rest.ts`).";
const APP_INSTALL = "An app install's auth_code is an OAuth authorization code exchangeable for tokens.";
const TERMINAL_CONFIG =
  "Terminal configurations carry Wi-Fi passwords and a private key password; the key file is a File id, and the pre-shared-key network's SSID stays.";
const FORWARDING =
  "Forwarded requests carry header values sent to and returned by a third party (API keys, Authorization); header names stay.";
const PRESIGNED =
  "Product catalog imports answer pre-signed upload and error-file URLs that grant access without Stripe authentication.";
const ISSUING_CARD =
  "Full card numbers and CVCs are refused as expansions (`rest.ts`) and redacted here; the card id, last4, and expiry stay.";
const FILE =
  "A file's own URL needs the account's secret key; its file links are public bearer URLs, reduced to their origin.";
const FILE_LINK_READ = "A file link's URL lets anyone download the file; only its origin comes back.";
const CHECKOUT =
  "Checkout Sessions carry a client secret (redacted); the hosted page URL is payer-facing and comes back verbatim.";
const IDENTITY_SESSION =
  "Identity verification sessions carry a client secret (redacted); the hosted verification URL is meant for the person being verified and comes back verbatim.";
const FC_SESSION_READ = "A Financial Connections session's client secret is redacted; its linked accounts stay.";
const REPORT_FILE = "Report and query results are Files whose URL needs the account's secret key to download.";
const DELETED = "Answers a deletion; no secret.";
const PAYMENTS =
  "Payment objects: the flagged fields are payment-method options, issuer authorization codes, network-token metadata, and payer-facing redirect URLs (credential query parameters sanitized). No credential.";
const PAYMENTS_SECRET =
  "Payment objects carry a client secret, redacted; the rest is payment-method options, issuer codes, and network-token metadata.";
const BILLING =
  "Customer and billing objects: the flagged fields are payment-method settings and embedded payment metadata; embedded client secrets are redacted by the field review.";
const BILLING_SECRET =
  "Billing objects carry a client or confirmation secret, redacted; the rest is billing and payment-method metadata.";
const ACCOUNTS =
  "Connected account settings, external accounts, and requirement references (file and object ids); no credential.";
const ISSUING =
  "Issuing objects: cardholder preferences, network-token metadata, and authorization codes. Full card numbers and CVCs are refused as expansions.";
const TERMINAL = "Terminal readers and their actions; collected-input metadata, no credential.";
const MONEY =
  "Money movement and Treasury flows, flagged for transfer and flow vocabulary; financial addresses are receiving details, not credentials.";
const VERIFICATION = "Verification and Financial Connections records; flow and refresh tokens are object ids.";
const QUERY = "A saved Sigma query; flagged for its name, no credential.";

/**
 * Issuing authorizations and transactions reference each other and the
 * network token used by id (or an expanded object of metadata); the names
 * are credential vocabulary, so they are kept here by path.
 */
const ISSUING_REFERENCES = ["", "data.", "transactions.", "data.transactions."].flatMap((prefix) => [
  `${prefix}token`,
  `${prefix}authorization`,
]);
/** A Terminal reader's collected signature input is a File id. */
const TERMINAL_SIGNATURE = ["action.collect_inputs.inputs.signature", "data.action.collect_inputs.inputs.signature"];

/** The reviewed verdict for every flagged operation, and for the credential families the detector does not flag. */
const OPERATIONS: Readonly<Record<string, ValueSafetyVerdict>> = {
  "POST /v1/account_links": refuse(ACCOUNT_LINK),
  "POST /v1/account_sessions": refuse(ACCOUNT_SESSION),
  "POST /v1/accounts/{account}/login_links": refuse(LOGIN_LINK),
  "GET /v1/apps/installs": redact(APP_INSTALL, ["auth_code", "data.auth_code"]),
  "POST /v1/apps/installs": redact(APP_INSTALL, ["auth_code", "data.auth_code"]),
  "GET /v1/apps/installs/{id}": redact(APP_INSTALL, ["auth_code", "data.auth_code"]),
  "POST /v1/apps/installs/{id}": redact(APP_INSTALL, ["auth_code", "data.auth_code"]),
  "POST /v1/apps/installs/{id}/uninstall": redact(APP_INSTALL, ["auth_code", "data.auth_code"]),
  "GET /v1/apps/secrets": redact(APPS_SECRET, ["payload", "data.payload"]),
  "POST /v1/apps/secrets": redact(APPS_SECRET, ["payload", "data.payload"]),
  "POST /v1/apps/secrets/delete": redact(APPS_SECRET, ["payload", "data.payload"]),
  "GET /v1/apps/secrets/find": redact(APPS_SECRET, ["payload", "data.payload"]),
  "POST /v1/billing_portal/sessions": refuse(PORTAL_SESSION),
  "GET /v1/checkout/sessions": vendorErrors(
    redact(CHECKOUT, ["client_secret", "data.client_secret"], [], ["url", "data.url"]),
  ),
  "POST /v1/checkout/sessions": vendorErrors(
    redact(CHECKOUT, ["client_secret", "data.client_secret"], [], ["url", "data.url"]),
  ),
  "GET /v1/checkout/sessions/{session}": vendorErrors(
    redact(CHECKOUT, ["client_secret", "data.client_secret"], [], ["url", "data.url"]),
  ),
  "POST /v1/checkout/sessions/{session}": vendorErrors(
    redact(CHECKOUT, ["client_secret", "data.client_secret"], [], ["url", "data.url"]),
  ),
  "POST /v1/checkout/sessions/{session}/expire": vendorErrors(
    redact(CHECKOUT, ["client_secret", "data.client_secret"], [], ["url", "data.url"]),
  ),
  "POST /v1/customer_sessions": refuse(CUSTOMER_SESSION),
  "POST /v1/ephemeral_keys": refuse(EPHEMERAL_KEY),
  "DELETE /v1/ephemeral_keys/{key}": redact(EPHEMERAL_REVOKE, ["secret"]),
  "GET /v1/file_links": redact(FILE_LINK_READ, ["origin:url", "origin:data.url"]),
  "POST /v1/file_links": refuse(FILE_LINK),
  "GET /v1/file_links/{link}": redact(FILE_LINK_READ, ["origin:url", "origin:data.url"]),
  "POST /v1/file_links/{link}": redact(FILE_LINK_READ, ["origin:url", "origin:data.url"]),
  "GET /v1/files": vendorErrors(
    redact(FILE, ["origin:links.data.url", "origin:data.links.data.url"], ["url", "data.url"]),
  ),
  "POST /v1/files": vendorErrors(
    redact(FILE, ["origin:links.data.url", "origin:data.links.data.url"], ["url", "data.url"]),
  ),
  "GET /v1/files/{file}": vendorErrors(
    redact(FILE, ["origin:links.data.url", "origin:data.links.data.url"], ["url", "data.url"]),
  ),
  "POST /v1/financial_connections/sessions": refuse(FC_SESSION),
  "GET /v1/financial_connections/sessions/{session}": vendorErrors(redact(FC_SESSION_READ, ["client_secret"])),
  "GET /v1/forwarding/requests": redact(FORWARDING, [
    "request_details.headers.value",
    "response_details.headers.value",
    "data.request_details.headers.value",
    "data.response_details.headers.value",
  ]),
  "POST /v1/forwarding/requests": redact(FORWARDING, [
    "request_details.headers.value",
    "response_details.headers.value",
    "data.request_details.headers.value",
    "data.response_details.headers.value",
  ]),
  "GET /v1/forwarding/requests/{id}": redact(FORWARDING, [
    "request_details.headers.value",
    "response_details.headers.value",
    "data.request_details.headers.value",
    "data.response_details.headers.value",
  ]),
  "GET /v1/identity/verification_sessions": vendorErrors(
    redact(IDENTITY_SESSION, ["client_secret", "data.client_secret"], [], ["url", "data.url"]),
  ),
  "POST /v1/identity/verification_sessions": vendorErrors(
    redact(IDENTITY_SESSION, ["client_secret", "data.client_secret"], [], ["url", "data.url"]),
  ),
  "GET /v1/identity/verification_sessions/{session}": vendorErrors(
    redact(IDENTITY_SESSION, ["client_secret", "data.client_secret"], [], ["url", "data.url"]),
  ),
  "POST /v1/identity/verification_sessions/{session}": vendorErrors(
    redact(IDENTITY_SESSION, ["client_secret", "data.client_secret"], [], ["url", "data.url"]),
  ),
  "POST /v1/identity/verification_sessions/{session}/cancel": vendorErrors(
    redact(IDENTITY_SESSION, ["client_secret", "data.client_secret"], [], ["url", "data.url"]),
  ),
  "POST /v1/identity/verification_sessions/{session}/redact": vendorErrors(
    redact(IDENTITY_SESSION, ["client_secret", "data.client_secret"], [], ["url", "data.url"]),
  ),
  "GET /v1/issuing/cards": vendorErrors(redact(ISSUING_CARD, ["number", "cvc", "data.number", "data.cvc"])),
  "POST /v1/issuing/cards": vendorErrors(redact(ISSUING_CARD, ["number", "cvc", "data.number", "data.cvc"])),
  "GET /v1/issuing/cards/{card}": vendorErrors(redact(ISSUING_CARD, ["number", "cvc", "data.number", "data.cvc"])),
  "POST /v1/issuing/cards/{card}": vendorErrors(redact(ISSUING_CARD, ["number", "cvc", "data.number", "data.cvc"])),
  "POST /v1/link_account_sessions": refuse(FC_SESSION),
  "GET /v1/link_account_sessions/{session}": vendorErrors(redact(FC_SESSION_READ, ["client_secret"])),
  "GET /v1/reporting/report_runs": vendorErrors(safe(REPORT_FILE, ["result.url", "data.result.url"])),
  "POST /v1/reporting/report_runs": vendorErrors(safe(REPORT_FILE, ["result.url", "data.result.url"])),
  "GET /v1/reporting/report_runs/{report_run}": vendorErrors(safe(REPORT_FILE, ["result.url", "data.result.url"])),
  "GET /v1/sigma/scheduled_query_runs": vendorErrors(safe(REPORT_FILE, ["file.url", "data.file.url"])),
  "GET /v1/sigma/scheduled_query_runs/{scheduled_query_run}": vendorErrors(
    safe(REPORT_FILE, ["file.url", "data.file.url"]),
  ),
  "GET /v1/terminal/configurations": redact(
    TERMINAL_CONFIG,
    [
      "wifi.enterprise_eap_peap.password",
      "wifi.personal_psk.password",
      "wifi.enterprise_eap_tls.private_key_file_password",
      "data.wifi.enterprise_eap_peap.password",
      "data.wifi.personal_psk.password",
      "data.wifi.enterprise_eap_tls.private_key_file_password",
    ],
    [
      "wifi.enterprise_eap_tls.private_key_file",
      "data.wifi.enterprise_eap_tls.private_key_file",
      "wifi.personal_psk",
      "data.wifi.personal_psk",
    ],
  ),
  "POST /v1/terminal/configurations": redact(
    TERMINAL_CONFIG,
    [
      "wifi.enterprise_eap_peap.password",
      "wifi.personal_psk.password",
      "wifi.enterprise_eap_tls.private_key_file_password",
      "data.wifi.enterprise_eap_peap.password",
      "data.wifi.personal_psk.password",
      "data.wifi.enterprise_eap_tls.private_key_file_password",
    ],
    [
      "wifi.enterprise_eap_tls.private_key_file",
      "data.wifi.enterprise_eap_tls.private_key_file",
      "wifi.personal_psk",
      "data.wifi.personal_psk",
    ],
  ),
  "GET /v1/terminal/configurations/{configuration}": redact(
    TERMINAL_CONFIG,
    [
      "wifi.enterprise_eap_peap.password",
      "wifi.personal_psk.password",
      "wifi.enterprise_eap_tls.private_key_file_password",
      "data.wifi.enterprise_eap_peap.password",
      "data.wifi.personal_psk.password",
      "data.wifi.enterprise_eap_tls.private_key_file_password",
    ],
    [
      "wifi.enterprise_eap_tls.private_key_file",
      "data.wifi.enterprise_eap_tls.private_key_file",
      "wifi.personal_psk",
      "data.wifi.personal_psk",
    ],
  ),
  "POST /v1/terminal/configurations/{configuration}": redact(
    TERMINAL_CONFIG,
    [
      "wifi.enterprise_eap_peap.password",
      "wifi.personal_psk.password",
      "wifi.enterprise_eap_tls.private_key_file_password",
      "data.wifi.enterprise_eap_peap.password",
      "data.wifi.personal_psk.password",
      "data.wifi.enterprise_eap_tls.private_key_file_password",
    ],
    [
      "wifi.enterprise_eap_tls.private_key_file",
      "data.wifi.enterprise_eap_tls.private_key_file",
      "wifi.personal_psk",
      "data.wifi.personal_psk",
    ],
  ),
  "POST /v1/terminal/connection_tokens": refuse(CONNECTION_TOKEN),
  "POST /v1/test_helpers/issuing/cards/{card}/shipping/deliver": vendorErrors(
    redact(ISSUING_CARD, ["number", "cvc", "data.number", "data.cvc"]),
  ),
  "POST /v1/test_helpers/issuing/cards/{card}/shipping/fail": vendorErrors(
    redact(ISSUING_CARD, ["number", "cvc", "data.number", "data.cvc"]),
  ),
  "POST /v1/test_helpers/issuing/cards/{card}/shipping/return": vendorErrors(
    redact(ISSUING_CARD, ["number", "cvc", "data.number", "data.cvc"]),
  ),
  "POST /v1/test_helpers/issuing/cards/{card}/shipping/ship": vendorErrors(
    redact(ISSUING_CARD, ["number", "cvc", "data.number", "data.cvc"]),
  ),
  "POST /v1/test_helpers/issuing/cards/{card}/shipping/submit": vendorErrors(
    redact(ISSUING_CARD, ["number", "cvc", "data.number", "data.cvc"]),
  ),
  "GET /v1/webhook_endpoints": redact(WEBHOOK, ["secret", "data.secret", "origin:url", "origin:data.url"]),
  "POST /v1/webhook_endpoints": redact(WEBHOOK, ["secret", "data.secret", "origin:url", "origin:data.url"]),
  "GET /v1/webhook_endpoints/{webhook_endpoint}": redact(WEBHOOK, [
    "secret",
    "data.secret",
    "origin:url",
    "origin:data.url",
  ]),
  "POST /v1/webhook_endpoints/{webhook_endpoint}": redact(WEBHOOK, [
    "secret",
    "data.secret",
    "origin:url",
    "origin:data.url",
  ]),
  "DELETE /v1/webhook_endpoints/{webhook_endpoint}": vendorErrors(safe(DELETED)),
  "POST /v2/billing/meter_event_session": refuse(METER_SESSION),
  "GET /v2/commerce/product_catalog/imports": redact(PRESIGNED, [
    "origin:status_details.awaiting_upload.upload_url.url",
    "origin:status_details.succeeded_with_errors.error_file.download_url.url",
    "origin:data.status_details.awaiting_upload.upload_url.url",
    "origin:data.status_details.succeeded_with_errors.error_file.download_url.url",
  ]),
  "POST /v2/commerce/product_catalog/imports": redact(PRESIGNED, [
    "origin:status_details.awaiting_upload.upload_url.url",
    "origin:status_details.succeeded_with_errors.error_file.download_url.url",
    "origin:data.status_details.awaiting_upload.upload_url.url",
    "origin:data.status_details.succeeded_with_errors.error_file.download_url.url",
  ]),
  "GET /v2/commerce/product_catalog/imports/{id}": redact(PRESIGNED, [
    "origin:status_details.awaiting_upload.upload_url.url",
    "origin:status_details.succeeded_with_errors.error_file.download_url.url",
    "origin:data.status_details.awaiting_upload.upload_url.url",
    "origin:data.status_details.succeeded_with_errors.error_file.download_url.url",
  ]),
  "GET /v2/core/event_destinations": redact(EVENT_DESTINATION, [
    "webhook_endpoint.signing_secret",
    "data.webhook_endpoint.signing_secret",
    "origin:webhook_endpoint.url",
    "origin:data.webhook_endpoint.url",
  ]),
  "POST /v2/core/event_destinations": redact(EVENT_DESTINATION, [
    "webhook_endpoint.signing_secret",
    "data.webhook_endpoint.signing_secret",
    "origin:webhook_endpoint.url",
    "origin:data.webhook_endpoint.url",
  ]),
  "GET /v2/core/event_destinations/{id}": redact(EVENT_DESTINATION, [
    "webhook_endpoint.signing_secret",
    "data.webhook_endpoint.signing_secret",
    "origin:webhook_endpoint.url",
    "origin:data.webhook_endpoint.url",
  ]),
  "POST /v2/core/event_destinations/{id}": redact(EVENT_DESTINATION, [
    "webhook_endpoint.signing_secret",
    "data.webhook_endpoint.signing_secret",
    "origin:webhook_endpoint.url",
    "origin:data.webhook_endpoint.url",
  ]),
  "POST /v2/core/event_destinations/{id}/disable": redact(EVENT_DESTINATION, [
    "webhook_endpoint.signing_secret",
    "data.webhook_endpoint.signing_secret",
    "origin:webhook_endpoint.url",
    "origin:data.webhook_endpoint.url",
  ]),
  "POST /v2/core/event_destinations/{id}/enable": redact(EVENT_DESTINATION, [
    "webhook_endpoint.signing_secret",
    "data.webhook_endpoint.signing_secret",
    "origin:webhook_endpoint.url",
    "origin:data.webhook_endpoint.url",
  ]),
  ...Object.fromEntries(
    [
      "GET /v1/account",
      "GET /v1/accounts",
      "POST /v1/accounts",
      "GET /v1/accounts/{account}",
      "POST /v1/accounts/{account}",
      "POST /v1/accounts/{account}/bank_accounts",
      "GET /v1/accounts/{account}/bank_accounts/{id}",
      "POST /v1/accounts/{account}/bank_accounts/{id}",
      "GET /v1/accounts/{account}/external_accounts",
      "POST /v1/accounts/{account}/external_accounts",
      "GET /v1/accounts/{account}/external_accounts/{id}",
      "POST /v1/accounts/{account}/external_accounts/{id}",
      "POST /v1/accounts/{account}/reject",
      "POST /v1/accounts/{account}/unreject",
      "POST /v2/core/account_tokens",
      "GET /v2/core/account_tokens/{id}",
      "GET /v2/core/accounts",
      "POST /v2/core/accounts",
      "POST /v2/core/accounts/{account_id}/person_tokens",
      "GET /v2/core/accounts/{account_id}/person_tokens/{id}",
      "GET /v2/core/accounts/{account_id}/persons",
      "POST /v2/core/accounts/{account_id}/persons",
      "GET /v2/core/accounts/{account_id}/persons/{id}",
      "POST /v2/core/accounts/{account_id}/persons/{id}",
      "GET /v2/core/accounts/{id}",
      "POST /v2/core/accounts/{id}",
      "POST /v2/core/accounts/{id}/close",
    ].map((key) => [key, vendorErrors(safe(ACCOUNTS))]),
  ),
  ...Object.fromEntries(
    [
      "GET /v1/checkout/sessions/{session}/line_items",
      "GET /v1/customers",
      "POST /v1/customers",
      "GET /v1/customers/search",
      "GET /v1/customers/{customer}",
      "POST /v1/customers/{customer}",
      "GET /v1/customers/{customer}/payment_methods",
      "GET /v1/customers/{customer}/payment_methods/{payment_method}",
      "GET /v1/customers/{customer}/subscriptions",
      "POST /v1/customers/{customer}/subscriptions",
      "GET /v1/customers/{customer}/subscriptions/{subscription_exposed_id}",
      "POST /v1/customers/{customer}/subscriptions/{subscription_exposed_id}",
      "DELETE /v1/customers/{customer}/subscriptions/{subscription_exposed_id}",
      "GET /v1/payment_links",
      "POST /v1/payment_links",
      "GET /v1/payment_links/{payment_link}",
      "POST /v1/payment_links/{payment_link}",
      "GET /v1/payment_links/{payment_link}/line_items",
      "GET /v1/prices",
      "POST /v1/prices",
      "GET /v1/prices/search",
      "GET /v1/prices/{price}",
      "POST /v1/prices/{price}",
      "GET /v1/quotes",
      "POST /v1/quotes",
      "GET /v1/quotes/{quote}",
      "POST /v1/quotes/{quote}",
      "POST /v1/quotes/{quote}/accept",
      "POST /v1/quotes/{quote}/cancel",
      "GET /v1/quotes/{quote}/computed_upfront_line_items",
      "POST /v1/quotes/{quote}/finalize",
      "GET /v1/quotes/{quote}/line_items",
      "GET /v1/shipping_rates/{shipping_rate_token}",
      "POST /v1/shipping_rates/{shipping_rate_token}",
      "GET /v1/subscription_items",
      "POST /v1/subscription_items",
      "GET /v1/subscription_items/{item}",
      "POST /v1/subscription_items/{item}",
      "GET /v1/subscriptions",
      "POST /v1/subscriptions",
      "GET /v1/subscriptions/search",
      "GET /v1/subscriptions/{subscription_exposed_id}",
      "POST /v1/subscriptions/{subscription_exposed_id}",
      "DELETE /v1/subscriptions/{subscription_exposed_id}",
      "POST /v1/subscriptions/{subscription}/migrate",
      "POST /v1/subscriptions/{subscription}/pause",
      "POST /v1/subscriptions/{subscription}/resume",
    ].map((key) => [key, vendorErrors(safe(BILLING))]),
  ),
  ...Object.fromEntries(
    [
      "POST /v1/customers/{customer}/bank_accounts",
      "POST /v1/customers/{customer}/bank_accounts/{id}",
      "DELETE /v1/customers/{customer}/bank_accounts/{id}",
      "POST /v1/customers/{customer}/cards",
      "POST /v1/customers/{customer}/cards/{id}",
      "DELETE /v1/customers/{customer}/cards/{id}",
      "GET /v1/customers/{customer}/sources",
      "POST /v1/customers/{customer}/sources",
      "GET /v1/customers/{customer}/sources/{id}",
      "POST /v1/customers/{customer}/sources/{id}",
      "DELETE /v1/customers/{customer}/sources/{id}",
    ].map((key) => [key, vendorErrors(redact(BILLING_SECRET, ["client_secret", "data.client_secret"]))]),
  ),
  ...Object.fromEntries(
    [
      "GET /v1/invoices",
      "POST /v1/invoices",
      "POST /v1/invoices/create_preview",
      "GET /v1/invoices/search",
      "GET /v1/invoices/{invoice}",
      "POST /v1/invoices/{invoice}",
      "POST /v1/invoices/{invoice}/add_lines",
      "POST /v1/invoices/{invoice}/attach_payment",
      "POST /v1/invoices/{invoice}/finalize",
      "POST /v1/invoices/{invoice}/mark_uncollectible",
      "POST /v1/invoices/{invoice}/pay",
      "POST /v1/invoices/{invoice}/remove_lines",
      "POST /v1/invoices/{invoice}/send",
      "POST /v1/invoices/{invoice}/update_lines",
      "POST /v1/invoices/{invoice}/void",
    ].map((key) => [key, vendorErrors(redact(BILLING_SECRET, ["confirmation_secret", "data.confirmation_secret"]))]),
  ),
  ...Object.fromEntries(
    [
      "GET /v1/issuing/authorizations",
      "GET /v1/issuing/authorizations/{authorization}",
      "POST /v1/issuing/authorizations/{authorization}",
      "GET /v1/issuing/cardholders",
      "POST /v1/issuing/cardholders",
      "GET /v1/issuing/cardholders/{cardholder}",
      "POST /v1/issuing/cardholders/{cardholder}",
      "GET /v1/issuing/disputes",
      "POST /v1/issuing/disputes",
      "GET /v1/issuing/disputes/{dispute}",
      "POST /v1/issuing/disputes/{dispute}",
      "POST /v1/issuing/disputes/{dispute}/submit",
      "POST /v1/issuing/personalization_designs",
      "GET /v1/issuing/personalization_designs/{personalization_design}",
      "POST /v1/issuing/personalization_designs/{personalization_design}",
      "GET /v1/issuing/tokens",
      "GET /v1/issuing/tokens/{token}",
      "POST /v1/issuing/tokens/{token}",
      "GET /v1/issuing/transactions",
      "GET /v1/issuing/transactions/{transaction}",
      "POST /v1/issuing/transactions/{transaction}",
      "POST /v1/test_helpers/issuing/authorizations",
      "POST /v1/test_helpers/issuing/authorizations/{authorization}/capture",
      "POST /v1/test_helpers/issuing/authorizations/{authorization}/expire",
      "POST /v1/test_helpers/issuing/authorizations/{authorization}/finalize_amount",
      "POST /v1/test_helpers/issuing/authorizations/{authorization}/fraud_challenges/respond",
      "POST /v1/test_helpers/issuing/authorizations/{authorization}/increment",
      "POST /v1/test_helpers/issuing/authorizations/{authorization}/reverse",
      "POST /v1/test_helpers/issuing/personalization_designs/{personalization_design}/activate",
      "POST /v1/test_helpers/issuing/personalization_designs/{personalization_design}/deactivate",
      "POST /v1/test_helpers/issuing/personalization_designs/{personalization_design}/reject",
      "POST /v1/test_helpers/issuing/transactions/create_force_capture",
      "POST /v1/test_helpers/issuing/transactions/create_unlinked_refund",
      "POST /v1/test_helpers/issuing/transactions/{transaction}/refund",
    ].map((key) => [key, vendorErrors(safe(ISSUING, ISSUING_REFERENCES))]),
  ),
  ...Object.fromEntries(
    [
      "POST /v1/test_helpers/treasury/inbound_transfers/{id}/fail",
      "POST /v1/test_helpers/treasury/inbound_transfers/{id}/return",
      "POST /v1/test_helpers/treasury/inbound_transfers/{id}/succeed",
      "POST /v1/test_helpers/treasury/outbound_payments/{id}",
      "POST /v1/test_helpers/treasury/outbound_payments/{id}/fail",
      "POST /v1/test_helpers/treasury/outbound_payments/{id}/post",
      "POST /v1/test_helpers/treasury/outbound_payments/{id}/return",
      "POST /v1/test_helpers/treasury/outbound_transfers/{outbound_transfer}",
      "POST /v1/test_helpers/treasury/outbound_transfers/{outbound_transfer}/fail",
      "POST /v1/test_helpers/treasury/outbound_transfers/{outbound_transfer}/post",
      "POST /v1/test_helpers/treasury/outbound_transfers/{outbound_transfer}/return",
      "POST /v1/test_helpers/treasury/received_credits",
      "POST /v1/test_helpers/treasury/received_debits",
      "GET /v1/topups",
      "POST /v1/topups",
      "GET /v1/topups/{topup}",
      "POST /v1/topups/{topup}",
      "POST /v1/topups/{topup}/cancel",
      "GET /v1/transfers",
      "POST /v1/transfers",
      "GET /v1/transfers/{id}/reversals",
      "POST /v1/transfers/{id}/reversals",
      "GET /v1/transfers/{transfer}",
      "POST /v1/transfers/{transfer}",
      "GET /v1/transfers/{transfer}/reversals/{id}",
      "POST /v1/transfers/{transfer}/reversals/{id}",
      "GET /v1/treasury/financial_accounts",
      "POST /v1/treasury/financial_accounts",
      "GET /v1/treasury/financial_accounts/{financial_account}",
      "POST /v1/treasury/financial_accounts/{financial_account}",
      "POST /v1/treasury/financial_accounts/{financial_account}/close",
      "GET /v1/treasury/inbound_transfers",
      "POST /v1/treasury/inbound_transfers",
      "GET /v1/treasury/inbound_transfers/{id}",
      "POST /v1/treasury/inbound_transfers/{inbound_transfer}/cancel",
      "GET /v1/treasury/outbound_payments",
      "POST /v1/treasury/outbound_payments",
      "GET /v1/treasury/outbound_payments/{id}",
      "POST /v1/treasury/outbound_payments/{id}/cancel",
      "GET /v1/treasury/outbound_transfers",
      "POST /v1/treasury/outbound_transfers",
      "GET /v1/treasury/outbound_transfers/{outbound_transfer}",
      "POST /v1/treasury/outbound_transfers/{outbound_transfer}/cancel",
      "GET /v1/treasury/received_credits",
      "GET /v1/treasury/received_credits/{id}",
      "GET /v1/treasury/received_debits",
      "GET /v1/treasury/received_debits/{id}",
      "GET /v1/treasury/transaction_entries",
      "GET /v1/treasury/transaction_entries/{id}",
      "GET /v1/treasury/transactions",
      "GET /v1/treasury/transactions/{id}",
    ].map((key) => [key, vendorErrors(safe(MONEY))]),
  ),
  ...Object.fromEntries(
    [
      "GET /v1/charges",
      "POST /v1/charges",
      "GET /v1/charges/search",
      "GET /v1/charges/{charge}",
      "POST /v1/charges/{charge}",
      "POST /v1/charges/{charge}/capture",
      "GET /v1/charges/{charge}/dispute",
      "POST /v1/charges/{charge}/dispute",
      "POST /v1/charges/{charge}/dispute/close",
      "POST /v1/charges/{charge}/refund",
      "GET /v1/confirmation_tokens/{confirmation_token}",
      "GET /v1/disputes",
      "GET /v1/disputes/{dispute}",
      "POST /v1/disputes/{dispute}",
      "POST /v1/disputes/{dispute}/close",
      "POST /v1/external_accounts/{id}",
      "GET /v1/payment_attempt_records",
      "GET /v1/payment_attempt_records/{id}",
      "GET /v1/payment_methods",
      "POST /v1/payment_methods",
      "GET /v1/payment_methods/{payment_method}",
      "POST /v1/payment_methods/{payment_method}",
      "POST /v1/payment_methods/{payment_method}/attach",
      "POST /v1/payment_methods/{payment_method}/detach",
      "GET /v1/payment_records",
      "POST /v1/payment_records/report_payment",
      "GET /v1/payment_records/{id}",
      "POST /v1/payment_records/{id}/report_payment_attempt",
      "POST /v1/payment_records/{id}/report_payment_attempt_canceled",
      "POST /v1/payment_records/{id}/report_payment_attempt_failed",
      "POST /v1/payment_records/{id}/report_payment_attempt_guaranteed",
      "POST /v1/payment_records/{id}/report_payment_attempt_informational",
      "POST /v1/payment_records/{id}/report_refund",
      "GET /v1/setup_attempts",
      "GET /v1/sources/{source}/mandate_notifications/{mandate_notification}",
      "POST /v1/test_helpers/confirmation_tokens",
      "GET /v1/three_d_secure/authentications",
      "POST /v1/three_d_secure/authentications",
      "GET /v1/three_d_secure/authentications/{authentication}",
      "POST /v1/three_d_secure/authentications/{authentication}/cancel",
      "POST /v1/three_d_secure/authentications/{authentication}/submit",
      "POST /v1/tokens",
      "GET /v1/tokens/{token}",
    ].map((key) => [key, vendorErrors(safe(PAYMENTS))]),
  ),
  ...Object.fromEntries(
    [
      "GET /v1/payment_intents",
      "POST /v1/payment_intents",
      "GET /v1/payment_intents/search",
      "GET /v1/payment_intents/{intent}",
      "POST /v1/payment_intents/{intent}",
      "POST /v1/payment_intents/{intent}/apply_customer_balance",
      "POST /v1/payment_intents/{intent}/cancel",
      "POST /v1/payment_intents/{intent}/capture",
      "POST /v1/payment_intents/{intent}/confirm",
      "POST /v1/payment_intents/{intent}/increment_authorization",
      "POST /v1/payment_intents/{intent}/verify_microdeposits",
      "GET /v1/setup_intents",
      "POST /v1/setup_intents",
      "GET /v1/setup_intents/{intent}",
      "POST /v1/setup_intents/{intent}",
      "POST /v1/setup_intents/{intent}/cancel",
      "POST /v1/setup_intents/{intent}/confirm",
      "POST /v1/setup_intents/{intent}/verify_microdeposits",
      "POST /v1/sources",
      "GET /v1/sources/{source}",
      "POST /v1/sources/{source}",
      "POST /v1/sources/{source}/verify",
    ].map((key) => [key, vendorErrors(redact(PAYMENTS_SECRET, ["client_secret", "data.client_secret"]))]),
  ),
  ...Object.fromEntries(["POST /v1/sigma/saved_queries/{id}"].map((key) => [key, vendorErrors(safe(QUERY))])),
  ...Object.fromEntries(
    [
      "GET /v1/terminal/readers",
      "POST /v1/terminal/readers",
      "GET /v1/terminal/readers/{reader}",
      "POST /v1/terminal/readers/{reader}",
      "POST /v1/terminal/readers/{reader}/cancel_action",
      "POST /v1/terminal/readers/{reader}/collect_inputs",
      "POST /v1/terminal/readers/{reader}/collect_payment_method",
      "POST /v1/terminal/readers/{reader}/confirm_payment_intent",
      "POST /v1/terminal/readers/{reader}/process_payment_intent",
      "POST /v1/terminal/readers/{reader}/process_setup_intent",
      "POST /v1/terminal/readers/{reader}/refund_payment",
      "POST /v1/terminal/readers/{reader}/set_reader_display",
      "POST /v1/test_helpers/terminal/readers/{reader}/present_payment_method",
      "POST /v1/test_helpers/terminal/readers/{reader}/succeed_input_collection",
      "POST /v1/test_helpers/terminal/readers/{reader}/timeout_input_collection",
    ].map((key) => [key, vendorErrors(safe(TERMINAL, TERMINAL_SIGNATURE))]),
  ),
  ...Object.fromEntries(
    [
      "GET /v1/financial_connections/transactions",
      "GET /v1/financial_connections/transactions/{transaction}",
      "GET /v1/identity/verification_reports",
      "GET /v1/identity/verification_reports/{report}",
    ].map((key) => [key, vendorErrors(safe(VERIFICATION))]),
  ),
};

const CLIENT_SECRET =
  "A publishable-side secret: with the account's publishable key it confirms, completes, or reads its object from a browser. The agent works server-side and never needs one.";
const METADATA = "Payment, Issuing, or account metadata the detector flags by vocabulary; no credential.";

/** Field names reviewed once for Stripe's shared object graph. */
const FIELDS: ValueSafetyTable["fields"] = {
  client_secret: { verdict: "redact", reason: CLIENT_SECRET },
  confirmation_secret: { verdict: "redact", reason: "Carries the invoice PaymentIntent's client secret." },
  client_token: { verdict: "redact", reason: "A payment method's client-side session token (Klarna)." },
  secret: {
    verdict: "redact",
    reason:
      "Ephemeral key, Terminal connection token, and webhook endpoint secrets: each authenticates to Stripe or signs its events.",
  },
  signing_secret: { verdict: "redact", reason: "An event destination's webhook signing secret." },
  auth_code: { verdict: "redact", reason: "An OAuth authorization code exchangeable for tokens." },
  authentication_token: { verdict: "redact", reason: "A meter event stream authentication token." },
  password: { verdict: "redact", reason: "A Terminal Wi-Fi password." },
  private_key_file_password: { verdict: "redact", reason: "A Terminal Wi-Fi private key password." },
  cvc: { verdict: "redact", reason: "An Issuing card's CVC." },
  ...Object.fromEntries(
    (
      [
        ["request_incremental_authorization_support", "A payment-method option flag."],
        ["request_incremental_authorization", "A payment-method option."],
        ["request_extended_authorization", "A payment-method option."],
        ["incremental_authorization_supported", "Whether a payment supports incremental authorization; a flag."],
        ["incremental_authorization", "Incremental authorization status."],
        ["extended_authorization", "Extended authorization status."],
        ["tokenization_method", "How a card number was tokenized (apple_pay, google_pay)."],
        ["authorization_code", "The issuer's approval code on a charge or Issuing authorization; it grants nothing."],
        ["authorization_response_code", "An EMV issuer response code."],
        ["authorization_method", "How Issuing card details were provided."],
        ["issuing_authorization", "An Issuing authorization id."],
        ["no_valid_authorization", "Issuing dispute evidence."],
        ["network_token", "Whether a network token was used; metadata, not the token."],
        ["token_currency", "A crypto payment's token currency."],
        ["token_risk_score", "A network token risk score."],
        ["used", "Whether a token was used; a flag."],
        ["cvc_token", "A CVC recollection token id, usable only with the account's secret key."],
        ["bank_account_token", "A bank account token object, usable only with the account's secret key."],
        ["evidence_customer_signature", "Card-present signature evidence metadata."],
        ["customer_signature", "A dispute evidence File id."],
        ["require_signature", "Whether card delivery requires a signature; a flag."],
        ["company_authorization", "Document File ids."],
        ["front_back", "Verification document File ids."],
        ["front", "A verification document File id."],
        ["back", "A verification document File id."],
        ["inquiry", "A requirement's inquiry reference id."],
        ["resource", "A requirement's resource reference id."],
        ["person", "A Person id."],
        ["verification_flow", "A verification flow id."],
        ["require_verification", "Whether one-time-password verification is required; a flag."],
        ["setup_intent", "An embedded SetupIntent; its client secret is redacted by name."],
        ["preferred_locales", "A cardholder's languages."],
        ["hosted_payment_method_save", "An invoice setting."],
        ["password_provided", "Whether a website password was provided; a flag."],
        [
          "financial_addresses",
          "Treasury receiving details (routing and account numbers for credits), not credentials.",
        ],
        ["flow", "A Treasury flow id."],
        ["transaction_refresh", "A Financial Connections refresh id."],
        ["client_ip", "The IP address that created a token."],
        ["accept_header", "A browser's Accept header recorded for 3D Secure."],
        ["header", "A quote PDF header text."],
        ["private_key_file", "A File id for a Terminal Wi-Fi key."],
        ["redirect_to_url", "A payer-facing authentication redirect; credential query parameters are sanitized."],
        ["alipay_handle_redirect", "A payer-facing Alipay redirect; credential query parameters are sanitized."],
        ["redirect", "A Source's payer-facing redirect; credential query parameters are sanitized."],
        ["deleted", "Whether an object was deleted; a flag."],
        ["location", "A Terminal location id."],
        ["device_fingerprint", "A hashed device id."],
        ["wallet_provider", "A digital wallet name."],
        ["network", "A card network name."],
        ["last4", "The last four digits."],
        ["card", "An Issuing card or token's card id or object; full numbers come back only as refused expansions."],
        ["id", "An identifier."],
        ["name", "A name."],
        ["type", "A type."],
        ["status", "A status."],
        ["created", "A timestamp."],
      ] as const
    ).map(([name, reason]) => [name, { verdict: "keep" as const, reason: reason || METADATA }]),
  ),
};

export const STRIPE_VALUE_SAFETY: ValueSafetyTable = { title: "Stripe", operations: OPERATIONS, fields: FIELDS };
