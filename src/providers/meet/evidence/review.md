# Meet surface review

Contributor evidence for #1397. No real Workspace data calls or
service-account mints were used. The official Discovery snapshot is revision
20261109, archived verbatim under SHA-256
`e9dbdd6710a8e4499775b173213fb30a59a8e7465edb7461a167ed51503e49cc`.
The source revision alone is mutable; the bytes and digest are the pin.
The google-discovery-v1 conversion is derived in memory from the original.

## Resource-name paths

Meet's Discovery methods use reserved resource names (`v2/{+name}`,
`v2/{+parent}/participants`) whose `flatPath` spells the segments
(`v2/conferenceRecords/{conferenceRecordsId}/participants/{participantsId}`).
The shared normalizer splits such a name into one path parameter per flatPath
segment, typed as a plain string: the name's own pattern describes the whole
name, never one segment. A reserved variable whose flat text is a single
variable (Slides `presentations/{+presentationId}`) keeps the previous rename
and schema, so other products' conversions are unchanged. Hatch paths
therefore address `/conferenceRecords/c1/participants/p1`, and the
`uri-template` index binds each segment.

## Admission

All 24 methods are indexed and admitted with explicit verdicts. Reads are
`read`. `spaces.create` and `spaces.members.create` are additive `write`s.
`spaces.patch`, `spaces.endActiveConference`, `spaces.members.patch`,
`spaces.members.batchUpdate` and `spaces.members.delete` are `destructive`.
None is refused: each acts only on spaces the user owns or this app created,
which Google enforces per scope. Named tools cover 18 methods; space members
are hatch-only. Hatch `pageSize` is bounded to 1–500 (members' documented
maximum; Google coerces larger sizes per method), and a members batch to
1–500 updates, Google's documented maximum.

## Scopes

`meetings.space.created` and `meetings.space.readonly` are sensitive,
`meetings.space.settings` non-sensitive
(https://developers.google.com/workspace/meet/api/guides/authenticate-authorize).
The Discovery scope lists, recorded in `drift.json`, show `created` accepted by
every method, `readonly` by every read, and `settings` by `spaces.get` and
`spaces.patch` only. The page describes `created` as limited to spaces the app
created, `readonly` as every space the user can access, and `settings` as the
user's own spaces' settings, which is why all three are requested: reading
conferences in Calendar-created spaces needs `readonly`, and changing their
settings needs `settings`. The endpoint check's scope findings fire if a
touched method stops accepting every requested scope.

## Gated capabilities

The REST reference pages for spaces, members and smart notes carried no
Developer Preview banner when reviewed (2026-11-13); a manual drift check
re-confirms this. The meeting-space configuration guide states that only the
organizer sets auto artifacts, that moderation restrictions apply only while
moderation is on, and that artifact settings need `meetings.space.settings`.
Artifacts exist only where the organizer's Workspace edition, admin policy and
(for smart notes) Gemini allow; the docs say so instead of claiming them.

## Value safety

Candidates flag `meetingUri`, `meetingCode`, `config.entryPointAccess`,
`gatewaySipAccess[].sipAccessCode` and every list's `nextPageToken`. Join
details are meeting information an organizer shares with invitees and Calendar
already shows; they admit one person to one meeting under the space's access
type and never an account, so they are kept. `phoneAccess[].pin` is the same
class and is not flagged. `entryPointAccess` is an enum. Drive and Docs
destinations are file ids and ordinary browser links opened with the reader's
own access; no response carries a vendor-minted signed URL. No embedded-URL
review paths are needed; global signing-name defense still covers free text and
error bodies.

`nextPageToken` is continuation metadata. Named lists refuse a malformed token
or one that echoes a value the request sent, and carry it in a signed,
connection/owner/argument-bound cursor encoded for the agent.

## Errors and writes

Standard Google errors keep reviewed reason facts, numeric Retry-After and an
ambiguous 404. Meet has no revision guard, so no conflict source is declared.
No idempotency key or auth-before-execution assertion is claimed. A dispatched
write is attempted once; an uncertain `create_space` says that Meet cannot
list spaces, so the user is asked before another link is made.

## OAuth mode

OAuth mode and allowed accounts are the shared Google kit's
(`../forms/evidence/review.md` records the reviewed Google web-server and
OpenID Connect contracts); Meet requests exactly its three scopes.
