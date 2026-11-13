# People surface review

Contributor evidence for #1396. No real Google account, contact, directory or
service-account mint was used. The official Discovery snapshot is revision
20261111, archived verbatim under SHA-256
`532f281096109fa10e94c6b79bc78811326bed61a43d0ccc1efec476e5b64caf`.
The source revision alone is mutable; the bytes and digest are the pin. The
google-discovery-v1 conversion is derived in memory from the original (People
joins the normalizer's product roots at `/v1`); its digest is stamped
separately in `openapi.generated.ts`. The complete source-id/normalized-key
mapping is in `x-google-discovery.mapping`. People is not added to the frozen
`test/fixtures/google-discovery/manifest.json` measurement, which records the
original six products.

## Operations and verdicts

All 24 source methods are indexed with no deprecations excluded and none
refused. Eighteen serve named tools and form the vendor declaration and the
drift endpoint rows. The other six are hatch-only:

- `contactGroups.batchGet`: a read.
- `people.batchCreateContacts`: an additive write.
- `people.batchUpdateContacts` and `people.batchDeleteContacts`: destructive.
- `people.updateContactPhoto` and `people.deleteContactPhoto`: destructive.

The hatch's write tool is destructive for every write regardless of verdict.
`updateContactPhoto` carries base64 `photoBytes` that Google decodes; the hatch
binding decodes them once and applies `refuseWithheldBase64` before the one
admitted send. Hatch `pageSize` is checked against Google's documented ranges:
1–1000 for connections, contact groups, other contacts and the directory list,
1–500 for directory search and 1–30 for both searches.

Every method accepts at least one requested scope, and the drift check's scope
rule keeps that true. `contacts` covers contacts and groups;
`contacts.other.readonly` covers other contacts (copying one needs both);
`directory.readonly` covers the directory; the five `user.*`/`userinfo` scopes
let `people/me` return the signed-in user's own emails, phones, addresses,
birthday, organizations and profile. `contacts.readonly`, `user.gender.read`
and `userinfo.email` are not requested: `contacts` supersedes the first, and
the provider does not need the other two.

## Searches

`people.searchContacts` and `otherContacts.search` document that a client
should send a warm-up request with an empty query before searching, because
the search cache can be stale. The named search tools send that request and
then the search, each as its own declared step. `otherContacts.search` accepts
only `emailAddresses`, `metadata`, `names` and `phoneNumbers` in its mask,
while `otherContacts.list` also accepts `photos`; each named tool refuses any
other field before the warm-up is sent. The second request is charged
to the call's admission budget before it is sent. Both cap `pageSize` at 30
and return no continuation; the named tools declare a terminal page. The
manual drift check covers this prose.

## Value safety and privacy

Contacts are personal data, so People declares a sensitive set:

- `addresses`, `ageRanges` and `birthdays`;
- `biographies` (notes) and `events`;
- `externalIds`, `genders` and `relations`;
- `userDefined`.

The deployment's `sensitiveFields` option controls it with the shared
`sensitiveFieldsOption`. The default `"drop"` removes those names at any depth
from every named and hatch result. Named reads also refuse to request them, so
a call never fetches what it would drop. `"return"` admits them. Names,
emails, phones, organizations, occupations, locations, memberships,
nicknames, URLs, IM and SIP handles, interests, skills and locales stay
ordinary requested data. Resolving a person needs those, and none is in a
special category.

`providers:spec` flagged `clientData[].value`, `userDefined[].value`,
`metadata.deleted`, `nextPageToken` and `nextSyncToken`:

- `clientData` is key/value storage other applications write through the
  People API, not user-authored text. Its values are permanently redacted on
  every Person and ContactGroup response.
- `userDefined[].value` is a user-typed custom field. It is kept by review,
  and the sensitive-field choice decides it.
- `deleted` is a sync boolean.
- Page and sync tokens are continuations usable only with the same grant.

`photos[].url` and `coverPhotos[].url` are Google-minted image destinations.
They are fetchable without the grant once known, so they are permanently
redacted wherever a Person appears: get, search, list, batch, create, update,
copy, photo replies and directory results. User-entered `urls`,
`calendarUrls` and IM handles are ordinary user references. No generic
credential URL-name rule is applied to them; global signing-name defense
still covers free text and error bodies. No credential, secret-value or binary
response is admitted. Every reviewed operation keeps Google's redacted error
text (`vendorErrors`), as the other Google products do. Google's errors echo
request fields, never stored secrets.

Named writes and hatch paths, query and body use the kit's withheld-value and
withheld-link admission before dispatch.

## Paging

Named lists take `limit` (default 25, at most 100, narrower than Google's 1000)
and a bound cursor. The cursor carries Google's `nextPageToken` and the page
size of the first call, because Google requires every parameter to match while
paging. A token that carries a value the request sent is refused rather than
placed in a cursor. A page that would exceed the shared 192 KiB result budget
fails and names what to narrow, instead of dropping rows Google's token would
skip. Text over 1,000 characters in a list, or 20,000 in `get_person`, is cut
with a marker and reported in `truncated`.

## Errors and outcomes

Standard Google errors keep reviewed reason facts and numeric Retry-After.
`notFound` is ambiguous: a profile the account cannot see and a missing one
both answer 404. `people.updateContact` requires `person.metadata.sources` to
name the CONTACT source (type, id and that source's etag) and treats the source
etag, not the person etag, as the revision. Contact reads therefore always ask
for `metadata` and project only that source as `contactSource: { id, etag }`,
keeping the rest of person metadata out unless `personFields` names it;
`update_contact` sends it back as the one CONTACT source. Group updates carry
the group etag. Google refuses a stale revision with FAILED_PRECONDITION.
Those requests, named and
hatch (including batch contact updates), set the shared `revisionGuarded` flag,
so the refusal is `conflict`, the one declared conflict source. Directory tools reword 400 and
403 to say that the directory exists only for Google Workspace accounts and
can be hidden by the domain. No auth-before-execution assertion or idempotency
key is claimed. Every write is sent once. After an uncertain answer,
`create_contact`, `create_contact_group` and `copy_other_contact` say where to
look before creating again.

## OAuth mode and allowed accounts

OAuth mode follows the shared Google web-server flow recorded for the other
products (#1375): consent at `https://accounts.google.com/o/oauth2/v2/auth`;
code exchange and refresh at `https://oauth2.googleapis.com/token` with body
client credentials; S256 PKCE; and exactly the nine scopes above. No
revocation endpoint is configured. `accounts` (#1381) adds `openid` and
`email` and checks the ID token's verified email or `hd` claim before storing
a grant. Classification, value safety, the sensitive-field choice and the
index are the same in both modes.
