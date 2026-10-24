# Maintained provider setup

Each section below sets up one maintained provider: a construction example,
its credential, the options that change behavior or data boundaries, what the
vendor must enable first, and its limits. [Change the connector
roster](./integrating.md#add-or-remove-a-connector) covers the general
procedure and the providers not listed here. Agent guidance for each
provider ships with its connection's usage guide, not here.

## Stripe

`stripe()` connects one Stripe account in one mode through the pinned REST API.

```ts
import { stripe } from "@zackbart/connecta/providers/stripe";

const billing = stripe("billing", {
  purpose: "Payment investigations and reconciliation",
  auth: { type: "apiKey" },
  mode: "sandbox",
  readOnly: true,
});
```

**Credential.** Enter one secret (`sk_test_…`/`sk_live_…`) or restricted
(`rk_test_…`/`rk_live_…`) key in this connection in the operator UI. Prefer a
restricted key with only the required permissions. The key prefix must match
the declared mode; publishable and organization keys are refused. The Test
action reads the account. If account-read permission is absent, the test can
still establish that the key was accepted. Stored keys never reach agents.

**Options.** `mode` is required: `"sandbox"` or `"production"`.
`connectedAccount: "acct_example"` binds every call to that Connect account
using Stripe-Account on v1 and Stripe-Context on v2. `readOnly: true` omits
writes and refuses their calls on every endpoint. `authScope: "personal"`
partitions stored credentials by admitted owner instead of sharing a grant.
`maxResultBytes` narrows this connector's inline result budget. There is no
separate optional sensitive-field set: reviewed secret withholding applies to
every result, and `fields` only reduces the remaining data. No tool argument
widens that boundary.

**Vendor prerequisites.** The key must have permission for each API operation
the workflow needs. Hosted MCP is a separate generic connection; follow
[the hosted Stripe migration](./hosted-mcp-migration.md#stripe).

**Limits.** The index is pinned to Stripe-Version `2026-09-30.endive`.
Responses are bounded to 8 MiB and request reads to 60 seconds. Default
admission is 100 calls/second and 8 concurrent calls in production, or
25 calls/second and 4 concurrent calls in sandbox; Stripe can apply stricter
endpoint limits. Stripe v1 lists normally default to 10 and cap at 100;
the hatch keeps the pinned operation's vendor query parameters. Files can be
read as quote PDFs from the confined files origin; multipart uploads and
the meter-event stream are refused. POST writes take an optional
`idempotencyKey` (up to 255 characters), generating and returning one when
omitted; DELETE and the invoice-preview read send no key.

**Paging example.** A first read can set a raw record-id anchor in
`query.starting_after` or `query.ending_before`. To continue, pass the signed
`page.nextCursor` as the top-level `cursor`, keeping the path, filters and
`fields` unchanged. Omit both raw anchors on continuation. Do not combine
directions. Search and v2 lists also continue through `cursor`; their raw
vendor page tokens are not accepted there.
If a v2 next-page URL adds omitted parameters, the fetched data remains
available with `page.hasMore: true` but no `nextCursor`. It is incomplete;
repeat with explicit parameters or narrow the request to continue safely.

```ts
const first = await connecta.call("billing.stripe_api_read", {
  path: "/v1/charges",
  query: { customer: "cus_example", starting_after: "ch_example", limit: 20 },
  fields: ["data.id", "data.amount"],
});
if (first.data.page?.hasMore) {
  const next = await connecta.call("billing.stripe_api_read", {
    path: "/v1/charges",
    query: { customer: "cus_example", limit: 20 },
    fields: ["data.id", "data.amount"],
    cursor: first.data.page.nextCursor,
  });
}
```

## Breeze ChMS

`breeze()` connects one church's Breeze account through its API.

```ts
import { breeze } from "@zackbart/connecta/providers/breeze";

const church = breeze("church", {
  purpose: "Attendance and giving reports",
  subdomain: "church",
});
```

**Credential.** Enter the church's API key from **Extensions → API** on the
connection in the operator UI. The Test action reads the account summary and
checks its reported subdomain. The key has no scopes: it reaches the whole
account, giving included. It is sent only to the configured church hostname.

**Options.** `subdomain` is one hostname label before `.breezechms.com`, never
a URL. `readOnly: true` omits and refuses writes on every endpoint, including
writes that Breeze sends as GET requests. `defaultPageSize` sets paged-list
sizes from 1 to 1,000 (default 100). `list_events` separately defaults to 100
and caps at 1,000 without a continuation. `authScope` selects shared or
personal credential ownership. `callAdmission` sets a per-runtime budget;
none is declared by default because Breeze publishes no rate limit.

There is no `sensitiveFields` option: profile detail maps contain church-specific
field ids, and this provider declares no configurable sensitive set. Select
only needed fields and reduce personal records in code. Calendar feed addresses
and embed keys are always removed from every result.

**Vendor prerequisites.** An administrator must enable/access Extensions → API
and supply the account-wide key. Giving, funds and pledges use archival routes
that are no longer in Breeze's public reference; verify the church still
supports them before depending on those workflows.

**Limits.** Requests stay below the church's `/api` path. Responses are bounded
to 8 MiB and standard hatch successes must be JSON. People page by offset;
other paged named lists window a bounded vendor response locally. Events and
account logs have vendor caps; narrow date ranges when a reply fills its limit.

## Overflow

`overflow()` connects one nonprofit's Overflow v3 API, with an explicit
production or staging environment.

```ts
import { overflow } from "@zackbart/connecta/providers/overflow";

const giving = overflow("giving", {
  purpose: "Giving reports and donor care for the nonprofit",
  environment: "staging",
});
```

**Authentication.** An operator saves the environment's `clientId` and `apiKey`
on this connection. They are sent as `x-client-id` and `x-api-key`; neither
identifies which environment it belongs to. Staging and production credentials
are separate. The credential test reads one location with the candidate pair;
`/health` is not an authenticated credential test.

**Options.** `environment` is required, with no default. `defaultPageSize`
controls numbered named lists (default 25, maximum 100). `readOnly` refuses
all writes. `authScope` selects shared or personal credential ownership.
`instructions` appends nonprofit conventions. `baseUrl` is an optional proxy
or test origin; Connecta appends `/api/v3`. `maxResultBytes` limits inline
results, and `callAdmission` replaces the default policy.

Named reads retain lean projections; `get_donor` is the full-contact lookup.
There is no configurable sensitive-field set. The indexed hatch returns other
nonsecret vendor fields and `fields` only narrows them. Webhook signing secrets
are always removed, including bare, wrapped and list responses.

**Prerequisites.** Obtain API credentials from Overflow for the intended
nonprofit and environment. A donor-account-owned profile cannot be edited
through this API even when the credentials can read it. Resolve donor,
payment-method, campaign and location ids before authorizing money writes.

**Limits.** Overflow documents 120 requests per minute per API client. The
default admission policy approximates it per runtime with a rolling 60-second
budget, concurrency four and a bounded queue. Other integrations and runtimes
share the vendor allowance without sharing this local counter. The connection
reads at most 4 MiB per response. Named lists use opaque cursors; keep the same
limit when continuing a numbered list. A vendor-stated exact count appears as
`page.total`; no count is synthesized when it is absent. Payment methods are
windowed locally from one bounded response. The webhook-log hatch accepts at
most 50 rows and returns its native continuation inside a signed cursor.

## Tithe.ly

`tithely()` connects one Tithe.ly giving account through its v1 REST API.

```ts
import { tithely } from "@zackbart/connecta/providers/tithely";

const giving = tithely("giving", {
  purpose: "Weekly giving reports for the finance team",
  environment: "live",
});
```

**Credential.** Each connection has one operator-managed key pair: the public
key (`pub_…`, sent as the HTTP Basic user name) and the private key (`pri_…`,
the password). Enter both on the connection in the operator UI; the Test action
reads one organization to prove the pair. A missing, swapped, or malformed pair
is refused before any request leaves. Keys never reach agents.

**Options.**

- `environment` is required: `"live"` (tithe.ly) or `"test"`
  (tithelydev.com). Keys are issued per environment and nothing in a key says
  which, so a key pair used against the other environment fails every call
  with `auth_required`. Connecta does not guess.
- `sensitiveFields` defaults to `"drop"`, which removes an organization's
  payout `bank` (bank name and account last four) and `legal` contact (name
  and date of birth), by field name at any depth, from every result:
  named reads, `tithely_api_read` and `tithely_api_write` replies. `"return"`
  lets the hatch return them; the named reads never include them. The names
  are exported as `TITHELY_SENSITIVE_FIELDS`. No tool argument changes this.
- `readOnly: true` serves only reads on every endpoint, so refunds, charges,
  recurring gifts, payment methods, and accounts cannot change.
- `defaultPageSize` sets the list tools' default page, 1 to 99 (default 25).
- `baseUrl` replaces the environment's endpoint for a proxy or test double;
  it must be https, or http on loopback.
- `callAdmission` sets a per-runtime call budget. Tithe.ly publishes no rate
  limit, so none is declared by default; set one if the account has a limit
  you know.

**Vendor prerequisites.** Tithe.ly issues API keys on request: email
support@tithe.ly with the church or organization and what you are building,
and Tithe.ly sends a link to generate the key pair. Live and test are separate
accounts with separate key pairs.

**Limits.** Only API v1 is reachable; Tithe.ly's undocumented v2 is not. Card
and bank tokens for one-time charges and new payment methods come only from
Tithely.js in a donor's browser. A response is read up to 4 MiB.

## Church Community Builder

```ts
import { ccb } from "@zackbart/connecta/providers/ccb";

const crm = ccb("crm", {
  purpose: "Household and group coordination",
  environment: "production",
  mode: "system",
  clientId: env.CCB_CLIENT_ID,
  clientSecret: env.CCB_CLIENT_SECRET,
});
```

Obtain a v2 OAuth client from Pushpay and register the deployment's exact
`<publicUrl>/oauth/callback/crm` redirect URI and required scopes. Production
and sandbox clients use different hosts and credentials. `environment` and
`mode` are required. System Auth stores one shared church grant authorized by
an administrator. Identity Auth stores personal grants with each person's
permissions and requires prior System Auth for the same client. Start consent
from the connector's operator connection page; catalog and status reads do
not start consent. The connector manages token rotation.

`access: "read"` is the default. `access: "read-write"` requests the maintained
write scope set; alternatively specify a nonempty exact `scopes` list.
`access` and `scopes` are exclusive. Read-only configured scopes omit the
write hatch and never dispatch a write. `readOnly: true` additionally enforces
read-only access on every endpoint. Optional `subdomain` pre-fills consent.

`sensitiveFields: "drop"` is the default. `"return"` permits the documented
sensitive fields through the hatches; named projections stay narrow. OAuth
credentials, private file download destinations, payment-session links and
private calendar feeds remain withheld. No tool argument changes this boundary.

Named lists take `limit` equal to 25, 50, 75 or 100; the vendor default is 25.
`defaultPerPage` optionally chooses another allowed deployment default. Return
`page.nextCursor` unchanged as `cursor` and keep the same effective limit.
Named `page.total` is present only when CCB states an exact `X-Total` count. Indexed reads retain vendor
`query.per_page` plus a top-level signed `cursor`; use operation details for
filters and JSON request bodies. Advanced POST searches are reads.

The default admission rule is a per-runtime, per-endpoint rolling window of
60 calls per minute. It does not coordinate other runtimes sharing this OAuth
client or emulate the vendor's no-burst exceptions. Individual gets allow one
call per second, individual advanced searches one per five seconds, and
category schedule lists one per two seconds. Override `callAdmission` to match
shared usage, and respect the vendor's rate-limit wait. Replies are bounded
at 8 MiB. The legacy per-church v1 XML API is outside this provider's scope.
