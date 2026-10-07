---
type: added
---

**Google Workspace domain-wide delegation, shared by every Workspace
provider.** `serviceAccount` is `{ clientEmail, privateKey, clientId? }` or
the downloaded JSON key's text, from deployment secrets rather than the vault,
because one key serves every Workspace connector; anything but a complete,
exactly-encoded PKCS#8 RSA key of at least 2048 bits throws at construction,
and no key ever appears in
a message. `subject` is a function from the authenticated
`AuthenticatedIdentity` to a Workspace address — sync or async, for a
directory lookup, with the call's abort signal — or one fixed address for
shared or scheduled use. The function is never called for an open
deployment's anonymous requests or a call no request admitted; those, and an
`undefined` answer, fail `auth_required` before any request leaves.
Arguments, headers, and programs cannot choose the subject. The RS256
JWT-bearer assertion is signed with Web Crypto, so it runs unchanged on Node
and Workers with no new dependency. Access tokens are cached in memory only —
never in storage — per service account, key, subject, and scope set,
replaced a minute before expiry, and bounded at 512. Concurrent callers share
one mint through plain outcomes and a deadline, never another request's
signal, so a cancelled owner sends a waiting caller in another Worker request
to mint for itself. A 401 forgets only the token it rejected and replays the
request once, so a streamed request body is refused up front. A write that
names the revision it was made against passes `{ revisionGuarded: true }`,
and a stale revision — FAILED_PRECONDITION or ABORTED on HTTP 400 or 409 —
then arrives as `conflict` with fixed words to re-read and retry, unless
Google names a more specific reason — a disabled API, a quota, a missing
scope, or a precise permission refusal — which always decides first; otherwise
a refused precondition is reported neutrally in Google's own words. A
product can read Google's reason codes for any mapped failure — sanitized
tokens only, never its prose — and `exportSizeLimitExceeded`,
`domainPolicy`, and `insufficientFilePermissions`/`forbidden` refusals
name themselves precisely. A download or export can pass `{ maxBytes }` to
read only a prefix: the body is streamed, the rest is cancelled unread, and
the result says whether it was `truncated`, with its HTTP status and
`Content-Range`, so an empty file's 416 arrives as an empty result. A write
is never told to retry when it may have landed: one Google accepted whose
reply broke off or overflowed, one answered with a redirect, one sent with
no answer at all, and one Google answered with any 5xx — whatever reason it
named — fail as non-retryable with words saying to re-read its target first,
the verdict core's `write_outcome_unknown` gives an exempt program write.
Only a 429, or a 4xx naming a quota, is a rate limit for a write. A read
stays retryable, as does a write the provider marks `{ idempotent: true }`.
An error status is a refusal even when its body cannot be read. A product
can ask how far any failed request got: before sending, awaiting a
response, reading an accepted reply, redirected, a server error on a write,
or refused. Google's
refusals map to what fixes them: `unauthorized_client`
names the client ID and the exact scopes to authorize, `invalid_grant` names an
unknown or suspended user, a deleted key, or clock skew, and a disabled API or
a missing scope says so.
