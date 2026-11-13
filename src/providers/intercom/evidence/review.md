# Intercom REST API review (contributor)

## Pin and conversion

Intercom publishes its OpenAPI description only as YAML, in
[intercom/Intercom-OpenAPI](https://github.com/intercom/Intercom-OpenAPI).
`openapi.json` pins `descriptions/2.18/api.intercom.io.yaml` at commit
`3603253f86c25395e2d70a59d28a879c94836a15` (2026-11-13) by the SHA-256 of the
YAML bytes, so the pin is `vendored: true`. 2.18 is the current version: the
[changelog](https://developers.intercom.com/docs/references/changelog) heads
"Changelog (2.18)".

`openapi.document.json` is the reviewed JSON conversion: the YAML parsed with
`yaml` 2.9 (no alias limit), every `example` and `examples` key removed except
where a schema's `properties` names such a field (none in 2.18), and the
result serialized with two-space indentation and a trailing newline. Examples
are illustrative only and carry no contract; dropping them halves the
document (2.8 MB to 1.5 MB). Nothing else changes. To move the pin, fetch the
new YAML at a commit, repeat the same conversion, update `digest`, `revision`
and `url`, then run `providers:spec`, `providers:generate` and
`providers:check --record --provider intercom`.

The document has 277 operations. Three servers are listed; the index keeps
the first, and the provider's `region` option selects the host.

## Sources

- Regions: [REST APIs, Regional Hosting](https://developers.intercom.com/docs/build-an-integration/learn-more/rest-apis):
  US `https://api.intercom.io/`, Europe `https://api.eu.intercom.io`,
  Australia `https://api.au.intercom.io`. `api.intercom.io` "will attempt to
  route" other regions; the provider never relies on that.
- Authentication: [Authentication](https://developers.intercom.com/docs/build-an-integration/learn-more/authentication):
  `Authorization: Bearer <access_token>`. "An Access Token is issued to the
  teammate who installed the app on the workspace, or who last regenerated the
  token. Its access to conversations is limited by that teammate's
  conversation access, in addition to the app's scopes."
- Version header: [Update your API version](https://developers.intercom.com/docs/build-an-integration/learn-more/rest-apis/update-your-api-version):
  "the header version in the API request will override the version selected in
  the app." The pinned document's `intercom_version` parameter says an omitted
  header uses the app's version, or 1.0. The provider sends `Intercom-Version`
  equal to the pinned `info.version`.
- Errors and limits: [HTTP responses](https://developers.intercom.com/docs/references/rest-api/errors/http-responses),
  [error codes](https://developers.intercom.com/docs/references/rest-api/errors/error-codes)
  and [rate limiting](https://developers.intercom.com/docs/references/rest-api/errors/rate-limiting).
  A missing `Accept` can answer 406, so the provider sends
  `Accept: application/json`.

## Acting teammate

Every conversation write Intercom documents takes a required `admin_id`:

- [Reply to a conversation](https://developers.intercom.com/docs/references/rest-api/api.intercom.io/conversations/replyconversation)
  (`admin_reply_conversation_request`): `admin_id` "The id of the admin who is
  authoring the comment", required with `message_type` (`comment`, `note`,
  `quick_reply`) and `type: admin`. A plain comment reopens a closed
  conversation.
- [Manage a conversation](https://developers.intercom.com/docs/references/rest-api/api.intercom.io/conversations/manageconversation):
  close, snooze, open and assignment each require `admin_id`, "The id of the
  admin who is performing the action". Assignment's `assignee_id` "0" leaves
  the conversation unassigned; the close and open descriptions say `0`
  "clears both the teammate and the team assignee".
- [Add a tag to a conversation](https://developers.intercom.com/docs/references/rest-api/api.intercom.io/tags/attachtagtoconversation)
  requires `id` and `admin_id`;
  [remove a tag](https://developers.intercom.com/docs/references/rest-api/api.intercom.io/tags/detachtagfromconversation)
  is a DELETE whose JSON body requires `admin_id`.

The named tools take no `admin_id`; their closed input schemas refuse one as
`invalid_args`. Each fills `admin_id` from the deployment's `admin` option,
resolved before the write is reserved. The read hatch refuses any query or
body naming `admin_id`, and there is no write hatch. A mapping function sees
the admitted identity only, including `identity.agent` for declared agents,
and fails closed on no caller, an unauthenticated caller, `undefined`, or a
non-numeric answer.

## Classification

- Reply (`message_type: comment`) leaves the workspace: destructive.
- Close is destructive. It sends `skip_notifications: true`, which the pinned
  contract documents only as "Option to disable notifications when closing a
  conversation" (from 2.15). Intercom's help center says a teammate close
  signals the conversation-rating automation
  ([conversation ratings](https://www.intercom.com/help/en/articles/7872853-measure-customer-satisfaction-with-conversation-ratings))
  and fires Closed-state workflows that can ask the customer for a rating
  ([teammate changes state](https://www.intercom.com/help/en/articles/6904514-when-a-teammate-changes-the-state-of-a-conversation)).
  Neither page says the flag or an API close suppresses those, so no
  customer-message suppression can be promised. A manual check in
  `drift.json` records both sources.
- Note, open, snooze, assign, unassign, tag and untag change workspace state:
  writes. Open, assign and unassign also send `skip_notifications: true`, the
  only state changes besides close whose contract declares the flag; snooze
  has none. Assigning or unassigning a closed conversation reopens it
  (`skip_reopen` defaults to false), and the descriptions say so.
- Close sends no body. Assignment and close bodies, quick replies,
  attachments and `skip_reopen` are not exposed.
- Reviewed read-only POSTs: conversation, contact, company, ticket and call
  search, and `POST /companies/list`.

## Value safety

The detector flagged auth tokens, data connectors and the stream token
(refused), and on conversation-shaped responses `email_address_headers` (a
container name) and `otp_email_verification_failed.reason` (description
vocabulary). Those are kept: email header addresses are customer data and the
reason is event metadata.

Treatment follows Stripe's review: credential families are refused; bearer
links are redacted; customer data, including contact names, emails, phones
and locations, is returned. Redacted:

- `part_attachment.url` and `file_attribute.url` wherever an admitted
  operation's response schema reaches them (conversation parts and sources,
  side conversations, ticket parts and ticket attributes, ticket custom
  attributes in conversation lists). Intercom calls file attribute URLs
  temporary; attachment URLs download without authentication.
- Call `recording_url`, `transcription_url`, `fin_recording_url` and
  `fin_transcription_url`.

Embedded URL review, fail closed: every admitted read and every named write
applies the embedded-URL policy to its whole response (`{}` at the root), so
every string at any depth, including fields the schema leaves undeclared or
models as open maps, has credential-bearing link queries and fragments
withheld while ordinary links keep their bytes. The audit of the pinned
models' free-text and HTML string fields found 65 in `conversation` (title,
source subject and body, email subjects and history, part bodies, part
`translations.<locale>`, quick-reply text, rating remarks, scorecard notes
and reasoning, monitor explanations, company notes, and the open
`custom_attributes`, `event_details` and `sales_agent.collected_data` maps),
22 in `ticket` (the open `ticket_attributes` map, which holds
`_default_title_` and `_default_description_`, part bodies and translations,
type and state labels), 30 in `contact` (including the open
`custom_attributes` map), 153 in `article` (title, description, `body` and
`body_markdown` for each translated locale), 3 in `internal_article`, 2 in
`note` and 1 in `company_note`. Rather than enumerate them, the whole-response
rule covers each one and any field added later. The global signing-parameter
defense applies everywhere as well.

The policy withholds a link only when a query parameter name is a credential
as a whole token. Before #1408's round-2 fix, the shared matcher tested
`key`, `code` and `auth` as substrings (and `key` as a name suffix), so
`keyword`, `country_code`, `postcode`, `monkey` and `author` matched, and
whole-response scanning withheld ordinary customer links such as a contact's
`https://help.example/search?keyword=refund&country_code=US`. Words that
never occur in ordinary names (`token`, `secret`, `password`, `signature`,
`jwt`, `credential`, `authorization`, `bypass`) still match anywhere. `key`,
`code`, `auth` and `sig` match only as the whole name, after credential
qualifiers (`api_key`, `auth_code`, `x-api-key`) or compacted with them
(`apikey`). Opaque fragments without `name=value` pairs keep the previous
conservative substring rule. Vendor error prose stays withheld; codes
and statuses pass.

## Query encoding

The pinned document declares `style: form, explode: false` arrays on
`GET /conversations/{conversation_id}` (`include_part_types`,
`exclude_part_types`) and `GET /content/search` (`states`, `locales`,
`tag_ids`, `any_tag_ids`, `folder_ids`, `content_types`, `created_by_ids`,
`last_updated_by_ids`); these go out comma-joined, and an item containing a
comma is refused. `GET /events` declares `filter` as an exploded form object,
sent as its single field (`user_id=…`). Every other admitted array repeats
its key, the form default. The safety suite checks this table against the
pinned document.

## Conversation parts

Without `page`, a conversation read returns the 500 most recent parts, and
`conversation_parts.total_count` counts only the parts in the response. With
`page`, parts come oldest first, `per_page` up to 500, following
`conversation_parts.pages.next` (`next` is null on the last page; the
adapter falls back to `page < total_pages`). The read hatch admits
`query.page` on the first request and binds later pages to `page.nextCursor`.
An unpaged read that returns 500 parts carries a reviewed warning naming the
paging sequence.

## Gaps

- The admin mapping cannot prove the mapped admin may act on a given
  conversation; Intercom enforces that.
- Search bodies page through `pagination.starting_after` inside the body,
  which the hatch's paging adapters do not bind; agents pass Intercom's value
  back themselves.
- Intercom does not document authentication-before-execution for writes, so a
  write answered 401 stays an unknown outcome.
