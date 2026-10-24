# Maintained provider setup

Each section below sets up one maintained provider: a construction example,
its credential, the options that change behavior or data boundaries, what the
vendor must enable first, and its limits. [Change the connector
roster](./integrating.md#add-or-remove-a-connector) covers the general
procedure and the providers not listed here. Agent guidance for each
provider ships with its connection's usage guide, not here.

Standard API operation search accepts resource nouns, actions and conversational
phrasing. A leading create/add/update/edit/delete/remove/cancel/stop with an
object prefers reviewed writes and keeps later read words as nouns, as in
`update list` or `update subscription status`. Otherwise, read words anywhere
prefer reviewed reads, including after refund/charge/issue/process. Action
queries then prefer the requested verb or a synonym in an operation's summary or id.
A single resource noun ranks its root collection before nested routes.
Partial lexical matches are included even when other operations match every
term. For action/read queries, an operation must cover every content noun in
its text, or match a noun in its path or operation id while covering at least
half the nouns. Field-only matches need half-noun coverage across the text and
declared field names. This allows modifiers before the resource without
admitting verb-only matches for unrelated nouns. Verb-less noun phrases keep
their broader rule: any noun in the path/id, or every noun in the text.
Queries containing only conversational filler return no matches. Search order
is deterministic; multi-word noun phrases retain lexical relevance, and
authored tools break otherwise equal collection ties.
For example, search a configured `crm` connection's API index for `person`,
then follow `page.nextCursor` to reach operations beyond the leading profile
results. Responses contain at most eight compact hits within 16 KiB; fetch
operation details separately and keep the same query when continuing.

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

## GitHub

```ts
import { github } from "@zackbart/connecta/providers/github";

const source = github("source", {
  purpose: "Repository issue triage and release work",
  app: { appId: env.GITHUB_APP_ID },
  scopes: [{ org: "alice", access: "read-write" }],
});
```

Create a GitHub App with repository Metadata permission and install it on each
configured owner. Omit privateKey to populate the connector's encrypted privateKey
vault field, or supply app.privateKey from an environment secret. No per-user
OAuth is supported. Installation tokens remain in bounded memory and refresh
before expiry; key rotation partitions caches by key fingerprint.

Each scope names an organization or an exact owner/repository and explicit
read or read-write access. Exact repository grants can narrow their organization
grant. Org grants require an organization installation with All repositories,
including future repositories. Exact grants can use selected-repository installs.
A grant binds repository IDs for the provider instance; reconfigure after reviewing
a replacement repository or installation. Set readOnly:true for deployment-wide
write refusal. Only deployment code can grant workflows:"write", and only on a
read-write scope. A merge requires this explicit grant because GitHub's head-SHA
guard does not bind a concurrent base retarget.

Enable only vendor permissions needed by the workflows: Metadata read for
repository lookup; Issues read for issues/comments/labels; Pull requests read
for PRs/reviews/review comments/changed files/PR commits; Contents read for
repository commits/comparisons/contents/releases; Actions read for workflows,
runs and jobs. Release writes require Contents write. The guarded merge retains
Contents, Pull requests and Workflows write. Code search retains Contents read
and GitHub's own search restrictions. Each operation token is narrowed to its
reviewed permission and repository IDs; an org grant does not permit org admin.

The four github_api tools cover a pinned operation index with a bounded reviewed
repository read and release-write allowlist. All other operations are refused.
Use search_scoped for account data search and merge_pull_request for merges; the
corresponding raw routes are refused. Native tools present these same operations
and enforcement. Each named list defaults to 30 items, maximum 100. Search
continuation visits one partition page per call, at most twenty partitions and
ten vendor pages per partition; incomplete_results preserves capped/incomplete
searches. Cursors bind the configured grants, arguments, limit and deployment storage.
Keep the same limit with a cursor. Omission uses 30 and is accepted for a cursor
issued with limit 30; other limits must be repeated. Mismatches name the expected limit.

The transport reads at most 4 MiB per response. Inline UTF-8 file text and patch
values are redacted before a 32,768-character cut, with dot paths in truncated.
File contents retain base64 encoding; the character bound applies after decoding.
Use `/repos/alice/widget/contents/src/index.ts` for a nested file and
`/repos/alice/widget/contents` for the root directory. Contents paths must be
canonical relative paths, without dot/empty segments, backslashes or encoded
traversal. Encode branch-name slashes as `%2F` in `commits/{ref}` and
`compare/{basehead}`. Owner-prefixed object refs and cross-repository compares are
refused before authentication. PR-list head filters require `login:branch`, for
example `head:"alice:feature/x"`; they filter the selected repository's PRs.
Bare head branches are refused because GitHub silently ignores them. The base
filter stays a branch name. Configured App private keys are withheld from echoed content.
Identifiers remain beside cut patches. Raw diffs, binary files, log downloads,
archives, uploads and secret/admin operations are unavailable. Download URLs and
credentials remain withheld. fields narrows safe output and does not reduce the
bytes the vendor sends. Directory listings and search also have vendor caps;
missing content/patches do not establish completeness.

## Cloudflare

`cloudflare()` connects the reviewed v4 API with an operator-managed credential.

```ts
import { cloudflare } from "@zackbart/connecta/providers/cloudflare";

const edge = cloudflare("edge", {
  purpose: "Domain DNS, Workers and storage administration",
  auth: { type: "apiToken" },
  pin: { accountIds: ["0123456789abcdef0123456789abcdef"] },
});
```

**Credential.** Prefer a scoped user or account API token with only the required
permissions and resources. Enter it in the operator UI. Verification first tests
a user token; with `accountId`, it can test an account-owned token too. A legacy
`auth: { type: "globalApiKey" }` uses the key owner's email and API key fields;
it requires `pin` unless `unpinned: true` explicitly accepts the whole estate.
R2 accepts API tokens only. `authScope: "personal"` partitions human credentials;
agents use the shared credential.

**Options and boundaries.** `pin.accountIds` includes zones owned by those
accounts; `pin.zoneIds` admits those zones directly. Every call checks its named
account/zone ids, and scoped lists filter their results. Unscoped operations
are refused except reviewed public and identity/list routes. `accountId` and
`zoneId` fill existing path placeholders and do not impose a boundary; use `pin`
for that. Account pins may spend an extra zone-ownership read. `readOnly: true`
omits and refuses writes. No argument or sensitive-data option returns secrets;
credential values and private destinations remain unavailable. `baseUrl` is an
HTTPS proxy override (HTTP is allowed on loopback for tests).

**Vendor prerequisites.** Grant the token the required DNS, Workers, KV, R2 or
Analytics permissions for the pinned resources. Connector pins narrow the token;
they grant no additional Cloudflare permission. Global API Keys cannot change
user settings or memberships through this connector.

**Limits.** Cloudflare's global limit is 1,200 requests per five minutes per
user across the dashboard and all tokens. Connecta approximates that window
per runtime and defaults to six simultaneous requests (`maxConcurrency`). Zone
ownership checks are capped at three per call and 60 per five minutes per
connection. Responses are bounded to 8 MiB and calls to 60 seconds. Named
account/zone lists default to 20 rows, accept `limit` from 5 to 50, and return
signed `cursor` continuations. Hatch limits retain each operation's pinned
bounds; put its signed `page.nextCursor` into the parameter named by `page.param`
and `page.in`. Keep the other arguments unchanged. Discovery is bounded to eight
hits/16 KiB per search and 32 KiB per details page, with explicit continuation.

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
Advanced-search filters can still test
dropped sensitive fields, so matching rows can reveal their values by inference.
Where that matters, omit `read:advanced_searches` from the exact configured
OAuth scopes.

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

## Google Drive

Import `drive` from `@zackbart/connecta/providers/drive`. Enable Google Drive API
in a Google Cloud project, create a service account with domain-wide delegation,
and retain its JSON private key in a deployment secret. As a Workspace super
admin, authorize the service account's numeric client id for exactly
`https://www.googleapis.com/auth/drive`. Delegation changes can take 24 hours.
No Google Cloud IAM role grants access to a person's Drive.

```ts
drive("files", {
  purpose: "Team files and shared drives",
  serviceAccount: env.GOOGLE_SERVICE_ACCOUNT_JSON,
  subject: (identity) => accounts[identity.principal?.id ?? ""],
});
```

The subject mapping is deployment code. An agent uses its pool owner's mapped
identity; an ownerless pool has no delegated account unless `subject` is a fixed
Workspace address. Anonymous requests cannot invoke a subject function. The
scope reaches everything that user can open, including shared drives. The
provider's reviewed surface confines the available actions. Options are the
shared Workspace `purpose`, `instructions`, `serviceAccount`, `subject` and
optional `baseUrl`; there is no caller-selected account or sensitive-data mode.

The 17 named workflows remain available. `drive_api_search` and
`drive_api_details` discover the frozen 64-method inventory; `drive_api_read`
and destructive `drive_api_write` execute only 13 reviewed JSON metadata methods.
Refusals explain unreviewed methods. All grants use `share_file`, including
`anyone` and domain grants. There is no hatch media upload/download, watch,
permanent deletion or ownership transfer. Named content tools keep their bounded
export/download and the separately confined upload connection.

Named lists return `{ items, page }`; terminal pages omit `nextCursor`.
Continuation is bound to the connection, caller and arguments. A local byte cap
can end a page early, and a changed source page fails `conflict`. Named page
limits default to 25 and allow 1–100 rows; whole-result budgets default to 192 KiB
and allow 64 KiB–4 MiB. Large direct results use Connecta's result pager; keep
the default for programs. Named uploads allow one million text characters or
one MiB of decoded binary; content reads may return a whole-withheld binary
when credential scanning changes any byte. Size reports use `truncated` paths.

Hatch paging keeps Google's query parameters inside `query`. Omit `pageToken`
on the first request; pass the signed `page.nextCursor` as top-level `cursor`
thereafter. An empty vendor page may continue. `query.fields` is Google's wire
mask; Connecta's `fields` narrows safe returned JSON and preserves paging.
`incompleteSearch` describes incomplete corpus search, never an exact total.

```js
const { data: result } = await connecta.call("files.drive_api_read", {
  path: "/files/file_123/revisions",
  query: { pageSize: 20 },
  fields: ["revisions.id", "revisions.modifiedTime"],
});
const revisions = result.data.revisions;
const cursor = result.page?.nextCursor;
```

The outer `data` is Connecta delivery; the hatch's `result.data` is the Google
body and `result.page` carries continuation. Resource keys, decryption JWTs and
private download destinations remain withheld on named and hatch responses.
A 404 does not prove absence. Auxiliary lookup failures send no move; an actual
write failure can have an unknown outcome and requires a read before repetition.
