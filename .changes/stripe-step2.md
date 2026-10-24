---
type: changed
breaking: true
---

Standardize Stripe's six-tool API surface for 0.35. Tool names stay the same.
Replace `select` with `fields` on `stripe_api_read` and `stripe_api_write`;
both named reads also accept `fields`. Invalid roots fail before dispatch.
Replace `page.next` with `page.nextCursor` and pass it as the top-level
`cursor`, retaining the original path, filters and selected fields. Raw
`query.starting_after`/`query.ending_before` record-id anchors remain supported
on a first request without cursor; a cursor with a raw anchor or both directions
is refused. Raw vendor continuation tokens cannot be used as cursor. Search
defaults to 6 hits and caps at 8 instead of 10/50; it and large details results
have explicit continuation, bounded discovery and `truncated` paths. Search
drops `tag`, omits `tool` for refused operations, and adds `named`/`matched`.
HTTP 409 now fails as `conflict`; oversized 424 replies preserve dependency
failure and unknown-write semantics, and failed body reads receive truthful
wording. Writes refuse whole withheld placeholders and links before dispatch.
The guide uses generated conventions. See the Stripe section of
`documentation/provider-migration-0.35.md` for the complete mapping.
The guide identifies the configured account and its confirmation read. V2
pages retain fetched data without a continuation when the next URL adds
omitted parameters; a signed cursor in a raw record anchor is refused with
guidance to use `cursor`.
