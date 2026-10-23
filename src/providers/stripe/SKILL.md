---
{
  "name": "stripe",
  "instructionsHeading": "Account instructions",
  "content": "shared"
}
---

<!-- fragment: setup -->
## Use an API key

Import `stripe` from `@zackbart/connecta/providers/stripe` and set
`auth: { type: "apiKey" }` with `mode: "production"` or `"sandbox"`.
Prefer a restricted key with only the required permissions. Hosted MCP uses
`remoteMcp()` separately; see the installed hosted MCP migration guide.

<!-- endfragment -->


<!-- fragment: key -->


- This is Connecta's REST connector to `api.stripe.com`, holding one operator-managed key. It reaches exactly one account in one mode, so there is no account selection and no `stripe_context` or `livemode` argument.
- `stripe_api_search` finds API operations, not records: it searches the pinned API index and names the tool that calls each operation. `stripe_api_details` returns one operation's parameters with types, enums, and required names. Neither sends a request.
- `stripe_api_read` calls GET operations, plus `POST /v1/invoices/create_preview`, which only previews. `stripe_api_write` calls every other POST and every DELETE, from a customer edit to a subscription cancellation, with `method` and `path` stated; a read-only endpoint refuses it.
- Paths are concrete: substitute ids into the template search returned (`/v1/payment_intents/pi_123`). Pass `query` and `body` as JSON objects named as `stripe_api_details` lists them. Connecta form-encodes v1 bodies and query lists (`expand: ["latest_charge"]`), sends v2 bodies as JSON, and pins `Stripe-Version` to the index's API version. Send `null` or `""` to unset a field.
- Every call is checked against the pinned index before it is sent. An unknown path returns the nearest operations; an unknown or missing parameter returns `validation.issues` with the accepted names. Nothing reached Stripe, so fix the call from that answer.
- Results arrive as `{ status, data, page? }`. On a list, `page.next` is the cursor and `page.param` the query parameter to pass it as: `starting_after`, or `page` for search and v2 lists. Lists belong inside `execute_code`; pass `select` (dot paths such as `data.id` and `data.status`) to keep only the fields the question needs, which also keeps customer names, emails, and addresses out of the transcript.
- `get_stripe_account_info` confirms the account, mode, and connected account; `get_balance_summary` returns available and pending balances. Use them when they answer the question.
- Find records with list and search operations through `stripe_api_read` (`GET /v1/customers/search`, `GET /v1/charges` with `customer`) and carry the returned `id` into the write.
- `stripe_api_write` sends an `Idempotency-Key` on every POST. Pass `idempotencyKey` for anything you might retry, or reuse the generated one the result returns. An ambiguous failure carries it in its message or as `uncertainCall.recovery.idempotencyKey`. Reuse it only with the exact original arguments and within Stripe's retention (v1 keys may be pruned after 24 hours); after that, look the object up before retrying. A retry with a fresh key is a second charge, not a second attempt.
- Refused by design: operations that hand out a credential (ephemeral keys, Terminal connection tokens, account links (v1 and v2), Terminal onboarding links, Express login links, account sessions, customer sessions, billing portal sessions, file link creation, Financial Connections session creation, and the meter event session), Stripe Apps secret payloads (`expand` of `payload`), Issuing card `number` and `cvc` expansion on any Issuing path, multipart uploads such as `POST /v1/files` (use the Dashboard), and the meter event stream (send single events with `POST /v2/billing/meter_events`). Each refusal names its reason. Quote PDFs arrive from `files.stripe.com` as base64.
- Secrets read as `"[redacted]"` in every result, expansions included: client secrets (PaymentIntents, SetupIntents, Checkout and Identity sessions, Sources, Financial Connections, invoice confirmation secrets), webhook and event destination signing secrets, Apps secret payloads, app-install authorization codes, Terminal Wi-Fi passwords, forwarded request header values, and Issuing card numbers and CVCs. Webhook and event destination URLs, file link URLs (in an expanded File, a list, or an event too), and pre-signed import URLs keep only their scheme and host. Identity verification `url`s come back whole. A Checkout Session's `url` comes back whole only for a guest payment session (`mode: "payment"`, no `customer` or `customer_account`, no customer creation, no saved payment method options); any other session returns only its scheme and host, because its page can show, reuse, or remove a customer's saved payment methods. Create those from your own server code, or send a payment link or the invoice's hosted page instead. These rules follow each object wherever it appears, expansions and events included. A `[redacted]` field is never the real value; do not send it back.
- Failures of credential-bearing operations (webhook endpoints, Apps secrets, Terminal configurations, forwarding) carry Stripe's type, code, decline code, and param, not its message. Payment, billing, and account failures keep Stripe's message.
- The hosted OAuth connection's natural-language Sigma, metrics, documentation search, implementation planner, and feedback tools do not exist with a key.
- Embedded URL safety uses reviewed paths plus global signing parameters. Generic credential-named query parameters (`code`, `key`, `token`, `sig`, etc.) and credential-looking fragments withhold the destination's entire query/fragment only in charge `failure_message` and `outcome.seller_message` wherever charge objects appear, including event partial copies and vendor error text. Ordinary `code`/`key` links can therefore be false positives in these diagnostics. Descriptions, metadata, price nicknames, invoice footers and notes keep those ordinary URL parameters byte for byte. Literal AWS SigV4/Google V4 `X-Amz-*`/`X-Goog-*` Signature, Credential and Security-Token values are withheld in every decoded string before projection. A withheld value is not the original: do not write it back. All writes, including named writes and supported raw/base64/multipart uploads, reject URL destinations whose own query/fragment contains the exact `[redacted]` placeholder, plain or encoded, with `invalid_args` before dispatch. Admission iteratively checks every JSON key and value within the host's accepted request size, without separate depth or node-count ceilings; cyclic direct arguments are refused. A marker outside the destination remains ordinary text. Split strings, encoded host/signing names, bare hosts without `//`, and opaque bearer paths remain outside this scan.
<!-- endfragment -->

<!-- fragment: shared -->
- Lists are cursor-paginated: `limit` defaults to 10 and caps at 100, `starting_after` and `ending_before` take an object id and are mutually exclusive, and `has_more` says whether to continue. Page inside `execute_code`.
- Search filters on a documented per-resource field set, not on arbitrary attributes. Charges search takes `amount`, `created`, `currency`, `customer`, `status`, `refunded`, `disputed`, `metadata`, `billing_details.address.postal_code`, and `payment_method_details.<source>.*` card fields — there is no `payment_intent` field. When the field you want is not searchable, retrieve the parent object and follow its reference (the PaymentIntent's `latest_charge`) instead of retrying the search with another spelling.
- The account → `stripe_api_search` → `stripe_api_details` → `stripe_api_read` sequence is one program, not four turns: resolve the method once, then call that method as many times as the investigation needs in the same run.
- Decline outcomes live on the charge — `outcome`, `failure_code`, `failure_message` — reached from the PaymentIntent's `latest_charge`, so "why did this payment fail" is a PaymentIntent read followed by one charge read.
- Resolve ids before acting; never guess one. Stripe ids are typed prefixes — `cus_` customer, `sub_` subscription, `ch_` charge, `pi_` payment intent, `in_` invoice, `acct_` account — and a plausible-looking id belongs to a different object or to nobody.
- Amounts are integers in the currency's minor unit: `1099` is 10.99 USD, and zero-decimal currencies like JPY take `10` for 10 JPY. Never send a decimal.
- Treat every create, update, delete, refund, and report run as a write. For guest calls, classification, and routing, fetch `skills({ name: "usage" })`.
<!-- endfragment -->


<!-- fragment: key_limits -->
- Stripe answers a rate limit with `429` and a `Stripe-Rate-Limited-Reason` header; back off on that rather than retrying immediately. Stripe documents an account ceiling of <!-- endfragment -->

<!-- fragment: key_tail -->
, and any single endpoint is capped at 25 per second regardless of mode, so paging one list is the real constraint. A `429` with code `lock_timeout` is a lock conflict on one object, not a rate limit: Stripe did not process the request, so it fails as `conflict` and may be retried after the other request finishes.
- An `auth_required` failure means the key is missing, revoked, or for the other mode: an operator must replace it in this connection in the operator UI, and `authorize_connector` returns that handoff. A restricted key without a permission fails as `provider_permission_denied` naming it; ask for the permission rather than retrying. A rejected argument comes back in Stripe's own words — read it rather than replacing the key.
<!-- endfragment -->
