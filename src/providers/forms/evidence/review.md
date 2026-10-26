# Forms surface review

Contributor evidence for #703 / 0011 step 2. No real Workspace data calls or
service-account mints were used. The official Discovery snapshot is revision
20261022, archived verbatim under SHA-256
`2e867ccaa2a404efaffc20705102b90510d1be5cb47ca23795a776cfa0548869`.
The source revision alone is mutable; the bytes and digest are the pin.
The google-discovery-v1 conversion is derived in memory from the original;
its digest is stamped separately in `openapi.generated.ts`. The complete
source-id/normalized-key mapping is in `x-google-discovery.mapping`.

All ten source methods are indexed with no deprecations excluded. The literal
execution table admits five: forms.get/create/batchUpdate and responses.get/list.
The vendor declaration and named dispatch manifest contain exactly those five.
Publish-settings mutation and watches.create/list/delete/renew are refused
before authentication. No new scope is requested. The response scope remains
read-only. Refusal reasons and natural edit vocabulary live in each summary's
first sentence (at most 120 characters), which is retained by the compiler.
Natural-query assertions cover option/choice edits, form renames, publishing
and watches against the generated index.

Privacy has no new configuration switch: response answers, respondent email,
question labels and quiz correct answers are the requested user data. A person
may type a secret in free text; that residual is outside stored-value safety.
Named projections and hatch data share the same connection safety, before
selection, paging, text cuts or extraction. Joined form/answer reads retain the
same logical-call subject and explicit `form`/`answers` steps, including when
served as a write.

The only vendor-minted access destination in the admitted response graphs is
Image.contentUri, documented as a download URI valid for a limited time. All
six schema locations in Form, and their `form` expansion in batch replies,
are permanently redacted. The same paths guard creates. A response's dynamic
question-id map is not an Image and is not redacted by this field name.
Ordinary Image.sourceUri, responderUri, linkedSheetId, uploaded file ids,
video youtubeUri and quiz feedback links are user references. No credential,
secret-value or binary endpoint is admitted. Free-text strings retain ordinary
user links; global signing-name URL defense is enabled. No generic URL-token
parameter rule is applied to user-authored text. Named writes and hatch
paths/query/body use the kit's withheld-value/link admission before dispatch.
There is no base64 or upload transport in this product.

`nextPageToken` is continuation metadata, never authorization. It survives the
safety pass and wire field masks until paging is computed, then a signed,
connection/owner/delegated-caller/call-bound cursor carries it. Hatch pageSize
is locally restricted to integers from 1 to 5000; the pin documents 5000 as
the default response count, and omission retains that vendor default.
Empty pages with a token
continue, malformed/withheld tokens fail closed, and terminal cursors are
omitted. Named response pages retain their local response-id fingerprint and
anchor; form content retains revision, item index and grid-row position.
Old private cursors intentionally fail after upgrade. Selected fields can
change between named pages; hatch selection is bound to the full call.
Named field selection preserves cut paths and omitted question ids outside
the selected data, so a partial response still explains how to recover it.

Standard Google errors keep reviewed reason facts, numeric Retry-After,
ambiguous 404 and revision-guarded ABORTED/FAILED_PRECONDITION conflicts.
H5 incomplete-read wording is enabled. No auth-before-execution assertion or
idempotency key is claimed. A dispatched write is attempted once. H1's core
fix is already in the base (#1008); no other provider's golden changes belong
here. H9 cold/warm Node 22 timing is characterization only, without deadline
changes. Existing named tools are retained by the approved plan. Paired fake
evals and post-review verification are recorded in
`eval/baselines/notes-google-forms-step2.md`; no retirement is proposed.
