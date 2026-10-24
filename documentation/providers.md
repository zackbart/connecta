# Maintained provider setup

Each section below sets up one maintained provider: a construction example,
its credential, the options that change behavior or data boundaries, what the
vendor must enable first, and its limits. [Change the connector
roster](./integrating.md#add-or-remove-a-connector) covers the general
procedure and the providers not listed here. Agent guidance for each
provider ships with its connection's usage guide, not here.

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
