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

## Planning Center

`planningCenter()` connects one organization's reviewed product APIs.

```ts
import { planningCenter } from "@zackbart/connecta/providers/planning-center";

const crm = planningCenter("crm", {
  purpose: "Staff follow-up, groups and service planning",
  excludeApps: ["giving"],
});
```

**Credential.** Create a Personal Access Token in Planning Center's API
applications dashboard as a user whose product permissions match this
connection's purpose. Enter its Application ID and Secret in the operator UI.
The credential test reads `/people/v2/me` with the organization included.
A missing or malformed pair is refused before transport. Personal auth ownership
is available with `authScope: "personal"`; agents use shared credentials.

**Options and boundaries.** `readOnly: true` omits and refuses writes.
`defaultPageSize` sets the named lists' default limit (25 normally, at most 100).
`userAgent` identifies the deployment and a contact; a nonempty single line is
required. `baseUrl` is an HTTPS proxy override, or HTTP on loopback for tests.
The connector supplies each product's reviewed `X-PCO-API-Version`; tool calls
cannot override it.

`excludeApps` removes product endpoints and named tools. People cannot be
excluded because its identities join other products and its me endpoint tests
the token. While any product is excluded, People lists/results/rules/conditions
are also refused by path or include: a saved list can query another product.
Webhook event/delivery payloads and changes to existing subscriptions are
refused because their ids do not name a product. A new subscription must name
a reachable product's event. Paths must be literal while exclusions apply:
no traversal, ambiguous separators, whitespace or encoded delimiters. Checks
run before credentials and again on the exact URL to fetch.

Exclusion controls live API access. It cannot identify information staff or
automations copied into reachable notes, workflows, forms or custom fields.
For a hard product boundary, use a PAT belonging to a user with No Access in
that product. No tool argument or nominal `sensitiveFields` option returns
stored credentials. Signing secrets, organization secrets, private calendar
codes, private file destinations and opaque webhook payload/header fields
stay withheld in named and hatch replies, including included resources.

**Vendor prerequisites.** The organization must subscribe to each product it
uses, and the PAT's user needs that product's permissions. Permissions are
per user and product; organization administrator status does not grant every
product. File uploads use a separate host this connector does not reach.

**Limits.** Planning Center meters 100 requests per 20 seconds per user,
shared with every integration using that user's tokens. The default per-runtime
admission budget is 100 calls per 20 seconds, concurrency five; `callAdmission`
can narrow or split it when connections share a user. Isolates and other
integrations share no local counter, so this is an approximation. `get_plan`
issues three bounded reads. A response is capped at 8 MiB; named lists request
at most 100 rows. Search answers have at most eight hits and 16 KiB of tool
JSON; details have 32 KiB with explicit continuation for larger contracts.
Named lists use signed cursors over the vendor offset; paged hatch reads return
`page.nextCursor` for the `offset` query parameter. Keep the other query and
field arguments unchanged when continuing a hatch read.

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
