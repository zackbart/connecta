# Docs step 2 review (contributor reference)

The exact official Discovery snapshot is revision 20261019, SHA-256
9f7c1120a3156c723bc1fc0b65332d00a22ae30dc516af131dbbb6b82b42e780.
Its 3 method ids map in the normalized document's x-connecta-discovery mapping:
docs.documents.get → GET /documents/{documentId}; docs.documents.create →
POST /documents; docs.documents.batchUpdate → POST /documents/{documentId}:batchUpdate.
All three methods are indexed and admitted by a literal verdict table. There
are no omitted/deprecated methods. The 53-member Request schema is discoverable;
execution retains the 45 existing generally available kinds. Preview comments
and suggestions remain refused. Google owns nested request semantics; the
compact admission checker is bounded, with a complete request graph in details.

The hatch independently enforces one supported kind per request, 1–100
requests and a nonempty writeControl.requiredRevisionId. Revision facts mark
only validated guarded batches. Named simple edits retain optional revisions;
named create declares separate create and initialText write steps. All hatches
use googleHatchBinding; the same uri-template index is passed to standard
GoogleClient. No additional scope, transport or authorization preflight.

Value-safety candidates named headers, marginHeader and createHeader are
content/formatting data, not HTTP credentials. Preserve them. Document text,
people mentions/email, ordinary links and sourceUri are requested authored
data; there is no configurable sensitive set. Discovery ImageProperties.contentUri
explicitly grants anyone holding the URI the requester's image access for a
default 30-minute lifetime. Permanently withhold that field under imageProperties
in all replies (including suggested objects and nested tabs), retaining authored
sourceUri. This does not affect existing named rendering. Sent secrets are
redacted before rendering/cutting and before hatch selection. No raw-byte hook.

Standard errors retain reviewed Google reason vocabulary and Retry-After
facts. Ambiguous 404 means connector_call_failed, not proven absence. Only
reviewed revision-precondition reasons imply conflict. Writes carry no
idempotency key and retain conservative outcomes and partial-create ids.
H5 activates standard incomplete-body wording. H9 measurements are recorded in
the phase-one handoff. H1 is already main; no other product's held items change.

Content continuation uses the shared authenticated store-backed codec. It
binds tool/arguments, connection/owner, full canonical safe document digest
(including revision) and row ordinal. There is no vendor pageToken protocol.
Size cuts report truncated paths; semantic notRendered and unusable-id dropped
remain separate. All six named tools are retained under the approved plan.

All three existing endpoint contract digests are unchanged; recording advances
only their Discovery revision from 20261005 to the approved 20261019 snapshot.
The archived raw bytes remain the immutable source, independently of live drift.

The compact summaries keep every eval write's action words in their first
sentence, within 120 characters: create, append/insert, and format bold text
or named ranges. Natural-query rows check those actions after compilation.
All three indexed methods are admitted, so no method needs a `Refused:`
summary; preview request members remain explicitly refused by the batch guard.
Named read field selection retains top-level `truncated`, even when the
selection omits the shortened data. A complete read does not invent that marker.

## OAuth mode (#1375)

Besides domain-wide delegation, a connection may select OAuth mode with
`{ oauth: { clientId, clientSecret }, authScope }`. The grant follows Google's
web-server authorization-code flow
(https://developers.google.com/identity/protocols/oauth2/web-server): consent at
`https://accounts.google.com/o/oauth2/v2/auth`, code exchange and refresh at
`https://oauth2.googleapis.com/token` with the client credentials in the request
body, S256 PKCE, and exactly the product's delegation scopes. The access token
is sent only to the product's API origin. No revocation endpoint is configured:
Google's revocation ends every grant the person gave the Google Cloud project,
including its other OAuth clients, so revoking one connector's token would also
end other connectors' and other clients' grants. A read
answered 401 renews once and replays once; a write answered 401 is never resent
and keeps the downstream authorization handoff. Google's granular consent lets
a person decline a requested scope; the resulting `insufficientPermissions`
refusal tells them to reconnect and allow every requested permission. Tool
classification, value safety, confinement and the operation index are the same
in both modes; only the token source and error advice differ.
