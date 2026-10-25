# Maintained provider setup

Each section below sets up one maintained provider: a construction example,
its credential, the options that change behavior or data boundaries, what the
vendor must enable first, and its limits. [Change the connector
roster](./integrating.md#add-or-remove-a-connector) covers the general
procedure and the providers not listed here. Agent guidance for each
provider ships with its connection's usage guide, not here.

Standard API operation search accepts resource nouns, actions and conversational
phrasing. A leading create/add/update/edit/make/set/apply/change/rename/send/delete/remove/cancel/stop
with an object prefers reviewed writes and keeps later read words as nouns, as in
`update list` or `update subscription status`. Make, set, apply, change, edit and
rename use update synonyms. Otherwise, read words anywhere prefer reviewed reads,
including after refund/charge/issue/process. The requested verb or a synonym in
an operation's summary, id or path sorts next, followed by resource focus.
A refused operation with a matching verb shares the intent tier when it covers
more query nouns than any admitted operation matching that verb and intent.
Its summary explains the refusal and omits the read/write hatch pointer; an
available named alternative can still be shown.

Partial lexical matches are included even when other operations match every
term. Short function words and id-shaped tokens do not count toward noun
coverage. For action/read queries, an operation must cover every content noun in
its text, or match a noun in its path or operation id while covering at least
half the nouns. Field-only matches need half-noun coverage across the text and
declared field names. Verb-less noun phrases keep their broader rule: any noun
in the path/id, or every noun in the text. Framing-only queries return no matches.

A noun phrase first prefers fuller noun coverage and an exact summary phrase
prefix, then path depth with a one-segment preference for authored tools, exact
resource nouns and authored tools. A pointer to another hatch receives no
authored-tool preference. A namespace before a version segment does
not count as an exact resource noun in that tie. A single noun, or a leading
`list` with only one exact resource noun plus modifiers, prefers the root
collection before nested routes. Other `list` phrases prefer an authored tool
whose summary/id covers every noun. Lexical relevance and stable index order
resolve remaining ties; field-only matches follow all primary matches.
For example, search a configured `crm` connection's API index for `person`,
then follow `page.nextCursor` to reach operations beyond the leading profile
results. Responses contain at most eight compact hits within 16 KiB; fetch
operation details separately and keep the same query when continuing.

Maintained REST hatches validate path parameters against their pinned contracts
before dispatch. Integer ids use canonical ASCII decimal notation within the
safe-integer range and obey the operation's declared bounds; for example,
`/individuals/42` is valid for an unbounded integer id while `/individuals/01`
is refused.

Stripe, Cloudflare and Vercel accept non-JSON success bodies only for reviewed
operation/media pairs from their pins. Cloudflare also preserves three raw Worker
content downloads with any non-JSON media. R2/KV object downloads use the full
JSON value-safety boundary for application/json and +json replies; other stored
media return bounded bytes with sent-secret checks. An unexpected HTML or text answer to a
JSON write reports an unknown outcome after one send; check the target before
repeating the write. Documented PDFs, text exports and streaming formats retain
their reviewed handling.

Vercel project-environment partial replies withhold failure prose before `fields`
selection. Named upsert partial-write reports identify the sent key and reviewed
failure codes, with reconciliation guidance; safe created and failed entries are retained, and submitted env values are private
write-only inputs on both named tools and raw env writes. Shared-env POST, PATCH
and DELETE failure prose is withheld too.

Overflow refund initiation accepts an `application/json` string or a bounded
`text/plain` acknowledgement, a narrow NestJS compatibility exception. Empty 2xx
refund acknowledgements also succeed. Nonempty HTML, binary, other media and
JSON-object replies fail with an unknown outcome after one dispatch;
check whether the refund took effect before repeating it.

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

Named lists and paged hatch reads expose `page.total` only when Planning Center
supplies a nonnegative safe integer in `meta.total_count`. This is the vendor's
count for the requested collection and vendor filters, across all pages;
`meta.count` describes one vendor page. For example, a filtered collection can
report `page.total: 57` while this reply emits two items. Local filtering,
projection and size truncation can reduce the items shown without changing the
vendor total. Missing, malformed or oversized optional totals are omitted.
`page.hasMore` and signed continuation still follow `meta.next.offset`, never
the total, item count, offset or limit.

Excluded products' unavailable named tools are omitted from authored and
generated guide sections and from hatch search/details suggestions. For example,
excluding Services removes `list_plans` suggestions while retaining People
identity tools. The indexed vendor contract remains inspectable; exclusion
still refuses those operations before dispatch. Changing the credential owner
or original filters invalidates a continuation; totals add no new cursor scope.

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

## Vercel

```ts
import { vercel } from "@zackbart/connecta/providers/vercel";

vercel("hosting", {
  purpose: "Projects and deployments for the assistant",
  auth: { type: "token" },
  teamId: "team_example",
});
```

Add the access token from Vercel Account Settings → Tokens in the connection's
operator UI. Choose the account/team and expiry the deployment needs. It is
stored encrypted; it is sent only to api.vercel.com, or a configured baseUrl proxy.
`authScope: "personal"` selects per-owner credentials; the default is shared.
The legacy hosted selector is unsupported; connect hosted MCP with generic
`remoteMcp()` as described in [Hosted MCP migration](./hosted-mcp-migration.md).

Without `pin`, `teamId` is a routing default, not a tenant restriction. On operations accepting
team selectors, an explicit `teamId` or `slug` overrides it. `teamId: null` omits
the default for personal-account calls. All named tools, hatch calls and uploads
use the same routing. For example, a `hosting` call with
`query: { slug: "studio" }` targets that team; it is not forced into team_example.
Vercel token permissions enforce access. Set a suitably scoped token when access
must be restricted. Signed paging binds the resolved selectors, so reuse the
same team, path, filters and fields when passing `page.nextCursor` in
`query[page.param]`. Team path ids remain vendor identifiers, not a deployment pin.

Set `pin: { teamId: "team_example" }` to confine this connection to one Vercel
team independently of the token's permissions. If `teamId` is also configured,
it must match the pin. The pin requires a canonical `team_…` id, not a slug.
It applies to named tools, bounded logs, uploads and all hatch requests. Explicit
foreign ids, personal/null scope, duplicate/ambiguous selectors and encoded path
spellings are refused. A supplied `slug` is checked against the pinned team's
current id and slug; ordinary project, environment and flag slugs keep their
documented meaning. Token permissions can restrict access further.

Pinned calls make at most eight additional sequential ownership reads, charged
to the same call-admission budget before each request. No ownership result is
cached between calls or credential owners. Project and deployment references,
including every target in supported multi-project inputs, must prove ownership;
missing or malformed ownership refuses the affected request. For example, a
domain move to another project checks both projects before sending the write.
Unprovable global/account operations, organizations, cross-team grants and project
transfers are unavailable. The pinned `list_teams` returns one terminal item,
and the credential probe reads that team. No user/account read is an exception.
Pinned hatch search and details mark these unavailable operations as refused;
the usage guide's refusal count includes the configured team boundary.
Signed continuations bind the pin policy as well as the credential owner and
existing call scope; changing the pin or adding/removing it requires a new first
page. Writes still have one physical attempt after successful preflights.

`readOnly: true` refuses every write. `baseUrl` is only for an explicitly trusted
proxy or test double. Set `callAdmission` for downstream endpoint limits and
`maxResultBytes` for inline output sizing. Permanent credentials and environment
values cannot be returned; there is no option to widen this boundary. The token
must have the permissions and Vercel plan required by the selected endpoint.

Team lists default to 20 and allow 100 rows. Build logs default to 200 and allow
2,000 events; runtime logs default to 200 and allow 1,000 rows over 1–20 seconds.
Log prefixes stop at 1 MiB; each projected text field stops at 4,000 characters.
Uploads accept at most 8 MiB of explicit bytes. Regular response bodies stop at
8 MiB and calls at 60 seconds. JSON-only operations reject unexpected HTML/text
acknowledgements; check the target after an unknown write outcome before repeating.

A numeric hatch `query.until` can set the initial upper time boundary on timestamp
lists. Subsequent pages use signed `page.nextCursor` in that same parameter.
Named `list_teams` uses only its top-level `cursor` for continuation.

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

## Gmail

Gmail uses a service account with Workspace domain-wide delegation. Enable
Gmail API, create a service account with no IAM roles, and provide its JSON
key as a deployment secret. A Workspace super administrator grants the
service account's numeric client id exactly these scopes in Admin console →
Security → Access and data control → API controls → Domain-wide delegation:
`https://www.googleapis.com/auth/gmail.readonly` and
`https://www.googleapis.com/auth/gmail.compose`. Changes can take up to 24 hours.
If key creation is blocked, an organization policy administrator must review
`iam.disableServiceAccountKeyCreation` for that project.

```ts
import { gmail } from "@zackbart/connecta/providers/gmail";

gmail("mail", {
  purpose: "Read mail and prepare reply drafts",
  serviceAccount: env.GOOGLE_SERVICE_ACCOUNT_JSON,
  subject: (identity) => mailboxes[identity.principal?.id ?? ""],
});
```

Map admitted callers to Workspace addresses in deployment code. A fixed
`subject: "alice@example.com"` instead shares that mailbox with every caller.
Anonymous callers cannot use a subject function. No tool argument selects a
mailbox. Both modes retain ownerless-pool hiding and the endpoint's read-only
policy. `gmail.compose` technically permits sending; this provider admits no
send route. Drafts are written only through `create_draft` and `update_draft`.
Gmail is the documented three-hatch exception to the four-hatch default.

Named reads return projected records or `{ items, page }`; `fields` narrows a
record or each list item. Size cuts appear in `truncated`. The pinned index
contains 79 methods and admits eleven reads. Settings, forwarding,
delegation, CSE, S/MIME, watches, mailbox mutation and every send method are
refused. Full MIME JSON crosses the same decoded sent-secret safety boundary.
Use the named attachment tool for immutable part identity, charset rendering,
one-MiB download bounds and decoded-size validation.

A hatch read has three layers: the direct-call delivery contains the tool's
`{ status, data, page? }` result, whose `data` is Google's JSON. In a program:

```js
const { data: first } = await connecta.call("mail.gmail_api_read", {
  path: "/messages",
  query: { q: "is:unread from:alice@example.com", maxResults: 10 },
  fields: ["messages.id"],
});
return { messageIds: first.data.messages, continuation: first.page };
```

On continuation repeat the same arguments and add top-level
`cursor: first.page.nextCursor`. Use `query.maxResults` from 1 to 500. Omit raw `query.pageToken`, even if Google's
safe body includes it. The last page has no cursor. An empty page can still
continue, and `resultSizeEstimate` never establishes an exact total. Named
thread/content cursors are separate and reject changed earlier content.

## Google Docs

```ts
import { docs } from "@zackbart/connecta/providers/docs";

const documents = docs("documents", {
  purpose: "Team notes and drafts",
  serviceAccount: env.GOOGLE_SERVICE_ACCOUNT_JSON,
  subject: (identity) => accounts[identity.principal?.id ?? ""],
});
```

Enable Google Docs API in the service account's Google Cloud project. Create
a service account and JSON key; no project IAM role grants document access.
A Workspace super administrator must authorize its numeric client ID for
`https://www.googleapis.com/auth/documents` under Admin console → Security →
Access and data control → API controls → Manage Domain Wide Delegation.
Add this scope to the same entry as other Workspace products; changes can take
24 hours. Store the key as a deployment secret. If key creation is blocked,
an organization administrator must resolve the key-creation policy.

Configure inbound auth and map admitted identities to Workspace addresses.
Each call acts as that user and reaches documents shared with them in Drive.
An unmapped caller is refused. A fixed `subject: "alice@example.com"` instead
shares one Workspace account across callers. See [Workspace delegation](./auth.md#pool-owners-for-google-workspace).
`readOnly: true` omits and refuses all writes. Optional `instructions` append
connection-specific guidance; `baseUrl` is an operator-controlled API root.
There is no configurable sensitive-field set: document text is requested data.

Six named tools retain rendered reads and common edits. Four `docs_api_*`
hatches discover all three pinned methods and expose JSON reads and writes.
`docs_api_search` searches operations; use Drive to find document data.
Batch hatch writes require `writeControl.requiredRevisionId`, 1–100 requests,
and exactly one supported generally available request kind each. Preview
comment and suggestion writes are refused. All hatch writes are destructive.
The additive named create/append/insert catalog entries retain
`destructiveHint:false` and remain writes. Writes
are never replayed and take no idempotency key. A named create with text uses
two explicit steps: one create POST and at most one initial-text batch POST.

`get_document` supports `fields`, a shared text budget (20,000 characters by
default, at most 1,000,000), and 64 KiB pages of UTF-16 index rows. Keep the
same read arguments when passing its signed content cursor. Changed content
requires a fresh read. Docs has no vendor list pagination. `truncated` lists
size cuts; `notRendered` describes semantic omissions. Direct rendering
results can reach 4 MiB when `maxChars` is explicit; programs carry at most
256 KiB per result. Read one tab or reduce `maxChars` to fit.

For complete styles or named ranges, use a hatch read:

```ts
const reply = await connecta.call("documents.docs_api_read", {
  path: "/documents/doc_123",
  query: { includeTabsContent: true },
  fields: ["documentId", "revisionId", "tabs"],
});
// The guest delivery wraps the hatch value; vendor data is under data.data.
const document = reply.data.data;
```

With `includeTabsContent:true`, named ranges are in
`document.tabs[].documentTab.namedRanges`; select `tabs` as above to read them.
`fields` selects vendor-body paths. Hatch values are `{status,data}` inside
Connecta's [guest call delivery](./code-mode.md). Caller headers,
credential query arguments, alternate origins and media transport are refused.
A 404 cannot distinguish missing from inaccessible documents and reports
`connector_call_failed`; only reviewed revision-precondition facts report
`conflict`. Token and JSON response handling use the same safety boundary as
named tools.

Google Docs image `contentUri` values are temporary access capabilities and are
withheld in all responses. Authored links and image `sourceUri` remain available.

## Google Sheets

```ts
import { sheets } from "@zackbart/connecta/providers/sheets";

const workbook = sheets("workbook", {
  purpose: "Review tables and quarterly budgets",
  serviceAccount: env.GOOGLE_SERVICE_ACCOUNT_JSON,
  subject: (identity) => accounts[identity.principal?.id ?? ""],
});
```

**Authentication.** Enable Google Sheets API in a Google Cloud project. Create
a service account with domain-wide delegation and a JSON private key; no
project IAM role grants spreadsheet access. In the Workspace Admin console,
a super admin adds its numeric client id to API controls → Domain Wide
Delegation with `https://www.googleapis.com/auth/spreadsheets`. Add to an
existing client's scopes instead of replacing them. A grant can take up to
24 hours to propagate. Supply the key through the deployment's secret store;
there is no operator credential slot or per-user consent flow. If organization
policy disables key creation, a Workspace administrator must authorize it.

**Options and boundaries.** `subject` is a fixed Workspace address or a
function mapping admitted identities. Unmapped callers fail `auth_required`;
agent pools need an owner unless a fixed subject is configured. Configure
inbound authentication. `readOnly: true` omits and refuses writes, including
hatch mutations. `instructions` appends deployment guidance. `baseUrl` may
select a confined HTTPS proxy (HTTP loopback for tests). Cell values, notes,
formulas and metadata are requested content; no `sensitiveFields` switch is
provided. Sent credentials and private signed destinations remain withheld.

**Coverage and limits.** Thirteen tools include the nine named workflows and
four indexed hatches over all 17 pinned Sheets v4 methods. Seven are reviewed
reads, including three POST methods: spreadsheet/get values by data filter
and developer metadata search. Ten are writes. Generic batches accept 1–100
requests, exactly one reviewed kind each; preview comments and external
data-source kinds are refused. Values use at most 20 read/clear ranges,
100 batch write ranges, 10,000 rows per value block and 50,000 cells per write.
No new OAuth scopes, revision guarantee or automatic write replay is added.

`get_values` pages whole rows with `maxCells` (2,000 default, 10,000 maximum),
`maxBytes` (192 KiB default, 4 MiB maximum) and `maxCellChars` (5,000 default,
50,000 maximum). A row that cannot fit is refused before returning that page;
narrow the columns or adjust the budgets. Use large byte budgets only with
direct calls; reduce within code for its bounded result bridge. Sheets has no
vendor page token. Standard result `fields` selects dot paths after safety;
Google's `query.fields` and batch field masks are distinct vendor syntax.

For full metadata, read `workbook.sheets_api_read` with
`{ method: "GET", path: "/spreadsheets/workbook_123" }`. A direct call's
Connecta delivery contains the hatch result `{ status, data }`; in code,
`const { data: reply } = await connecta.call("workbook.sheets_api_read", args)`
and `reply.data.sheets` accesses the vendor sheets. Paths are relative to
`/v4`. Range colons can be literal or `%3A`; action suffixes such as `:append`
must be literal. Prefer `append_values` for pinned `INSERT_ROWS`; generic
append's explicit `OVERWRITE` can overwrite cells.

Named-read field selection keeps `truncated` metadata, and value reads keep
`page` for continuation. `get_values` cursors are signed and bind the connection
and read arguments through the shared deployment store. Mapped Workspace
subjects also bind the admitted caller. Restart an old unsigned continuation
after upgrading; changing mapped callers requires a new read.

## Google Forms

```ts
import { forms } from "@zackbart/connecta/providers/forms";

forms("forms", {
  purpose: "Registration forms and response summaries",
  serviceAccount: env.GOOGLE_SERVICE_ACCOUNT_JSON,
  subject: (identity) => accounts[identity.principal?.id ?? ""],
});
```

Enable the Google Forms API in a Google Cloud project. Create a service
account without project IAM roles, enable domain-wide delegation, and store
its JSON key as a deployment secret. A Workspace super administrator must
add the key's numeric `client_id` to Admin console → Security → Access and
data control → API controls → Manage Domain Wide Delegation, with exactly
`https://www.googleapis.com/auth/forms.body,https://www.googleapis.com/auth/forms.responses.readonly`.
A grant can take up to 24 hours to apply. If key creation is disabled by
`iam.disableServiceAccountKeyCreation`, an organization policy administrator
must permit it for the project.

Configure inbound authentication. `subject` may be one fixed Workspace
address or a function mapping the admitted identity to an address. Calls
without a mapped account fail `auth_required`; tool arguments cannot select
an account. A fixed subject gives every admitted caller that account's view.
Each logical call resolves its subject once, including form/answer joins.
A missing form and one the account cannot open are indistinguishable.

`readOnly: true` omits and refuses writes. There is no configurable sensitive
field set: answers, respondent email and quiz answer keys are requested data
on both named tools and the hatch. Vendor-minted temporary image URLs and
credentials remain permanently withheld. Listing forms, sharing and deleting
files require a separate Drive connection and scopes. Publish-settings
mutation and every watch operation remain refused even though discoverable.

Named responses default to 25 items, at most 100, and may end earlier for
size. Results target 240 KiB; vendor responses are bounded at 8 MiB.
`list_responses` and `get_response` each read both the form and its answers.
Batches allow 1–100 reviewed request objects and require a current revision
on the batch wrapper and hatch. Google supplies no idempotency key. Set
`callAdmission` for the deployment's shared quota; the connector does not
reserve a Workspace-wide quota.

## Google Slides

```ts
import { slides } from "@zackbart/connecta/providers/slides";

const decks = slides("decks", {
  purpose: "Team presentations",
  serviceAccount: env.GOOGLE_SERVICE_ACCOUNT_JSON,
  subject: (identity) => accounts[identity.principal?.id ?? ""],
});
```

**Authentication.** Enable the Google Slides API in a Google Cloud project.
Create a service account and JSON key; no project IAM role grants access to
users' decks. A Workspace super admin must add its numeric client ID under
Security → Access and data control → API controls → Manage Domain Wide
Delegation, with `https://www.googleapis.com/auth/presentations`. The grant
can take up to 24 hours to apply. If key creation is blocked by
`iam.disableServiceAccountKeyCreation`, an organization policy administrator
can allow it for that project. Store the key in a deployment secret.

Configure inbound authentication and a subject mapping for admitted callers.
A fixed `subject: "alice@example.com"` acts as one shared account; a function
maps the admitted identity to an account. An agent uses its pool owner unless
a fixed account is configured. Unmapped callers fail `auth_required` before
minting; no tool selects another subject. A deck's absence and lack of access
are indistinguishable. Delegation is resolved when a data call needs it.

**Options and boundaries.** `readOnly: true` omits and refuses every write.
`baseUrl` is an HTTPS proxy override, or HTTP on loopback for tests. There is
no configurable sensitive-field set; field selection only narrows replies.
The five-method frozen index includes four generic executable JSON routes.
Thumbnails mint temporary access links and are refused in the generic hatch;
`get_slide_thumbnail` remains the reviewed named workflow. Existing comment
methods and request kinds remain available without adding preview methods.
Slides cannot search, share, move or delete presentation files; use Drive for
those separately authorized workflows.

**Limits.** Named content windows default to 20 slides (maximum 100), 50 page
elements (maximum 500), 100 layout rows (maximum 500), and 50 comment threads
(maximum 500). Batches allow 1–100 reviewed requests and the generic batch
requires `writeControl.requiredRevisionId`. Revision ids are preconditions,
not idempotency keys. Deck and comment changes can save separately; uncertain
comment saves require reading both outcomes before another edit. Responses
are bounded at 16 MiB; named results use a smaller content budget and provide
continuation. Set `callAdmission` when the deployment needs a tighter budget.

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
Continuation is bound to the connection, caller and listing arguments; named
`fields` and `maxBytes` may change between pages. A local byte cap can end a page
early, and a changed source page fails `conflict`. Named page
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
