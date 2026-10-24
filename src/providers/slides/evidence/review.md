# Google Slides step 2 contract review

Contributor evidence for the archived official Slides v1 Discovery revision 20261019. The exact source SHA-256 is
`ed0b6619e9f776a4c9c4094a303dbaaa47a79e90ceada26ae0c7c2986ee30fea`.
The primary pin records the deterministic `google-discovery-v1` conversion;
the generated index names both source and normalized-document digests.

All five source methods remain searchable. Four generic JSON routes are
admitted by literal key: presentations.get, pages.get, presentations.create
and presentations.batchUpdate. presentations.get's single required path
parameter is `presentationsId`, reconciled from Discovery's flatPath; the
other presentation operations use `presentationId`. Every index uses
`pathMatching: "uri-template"`, and the named client validates its declared
template against the same index before authentication/dispatch.

The generic thumbnail operation is explicitly refused. Its `contentUrl` is a
capability that opens as the requester for about 30 minutes. Only the existing
named `get_slide_thumbnail` workflow may return it. The same source contract
states that `Image.contentUrl`, `SheetsChart.contentUrl`, and
`StretchedPictureFill.contentUrl` carry this capability. Structural responses
withhold `contentUrl` throughout the recursive presentation/page graph;
field selection cannot restore it. Ordinary user-authored `Link.url`,
`Image.sourceUrl`, and the permission-dependent `Video.url` remain data.
No credential, resource/access key or minted service token is returned by the
remaining five-method response schemas. Split rich-text lanes are checked
before style objects can separate fragments of a sent credential.

The complete archived Request schema has 49 kinds. The named batch and hatch
retain exactly the existing reviewed set, with one kind per request and a
1–100 request bound. The hatch requires a nonempty
`writeControl.requiredRevisionId`, independently of schema compaction. The
existing five comment request kinds are retained from the shipped surface;
public comment documentation's preview wording does not authorize another
method or kind. No comment capability was newly admitted. Successful deck and
comment mutations save separately: the hatch preserves every vendor reply
and id, reports a missing comment state as
`COMMENT_UPDATE_STATE_UNSPECIFIED`, and adds reconciliation advice unless all
requested comments are confirmed saved. Named workflows retain their bounded
id-preserving projections and the same separate-save handling.

Google structured revision preconditions remain conflicts. HTTP 404 cannot
prove absence, and revision ids are not replay keys. No
`authBeforeExecution` claim or new sensitive-field option is introduced.
Standard mode activates H5's incomplete-body wording. H9 cold/warm timings
are local characterization only; no deadline changes or SLA are implied.

## Named surface retention

All 15 existing tools stay. Deck/page reading preserves reading order,
groups, placeholders and cross-tool text/notes continuation; layout/comment
lists preserve joins and anchors; thumbnail retrieval is a reviewed exception;
creation/replacement helpers preserve workflow semantics; six comment writes
preserve thread/post identity and independent save outcomes. The batch wrapper
stays until BEFORE evidence and a later orchestrator ruling authorize any
retirement. Paid evals are scheduled separately; no result is claimed here.
