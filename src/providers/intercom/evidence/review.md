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
- Note, close, open, snooze, assign, unassign, tag and untag change workspace
  state only: writes.
- Close sends no body, so it messages no one. Assignment and close bodies,
  quick replies, attachments and `skip_notifications` are not exposed.
- Reviewed read-only POSTs: conversation, contact, company, ticket and call
  search, and `POST /companies/list`.

Every other operation is a hatch refusal. Refused read families: auth tokens
(Fin data connector credentials), data connectors (outbound headers and
authentication bypasses), the conversation stream token, content and
reporting exports and downloads, the IP allowlist, teammate activity logs, Fin
and Fin Voice runtime endpoints, and call recordings (a redirect to media).
The single non-JSON success in the document, the reporting download, is
refused.

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

Embedded URL review: conversation source and part bodies, source subjects in
lists, side conversation part bodies, ticket part bodies and note bodies get
the generic credential-name and global signing-parameter defense, so a signed
download link embedded in HTML (for example `?expires=…&signature=…`) is
withheld. Contact and company `custom_attributes` are untyped maps; a file
attribute there is not reachable by a reviewed path and relies on the
runtime credential-name heuristic. Vendor error prose stays withheld; codes
and statuses pass.

## Gaps

- The admin mapping cannot prove the mapped admin may act on a given
  conversation; Intercom enforces that.
- Search bodies page through `pagination.starting_after` inside the body,
  which the hatch's paging adapters do not bind; agents pass Intercom's value
  back themselves.
- Intercom does not document authentication-before-execution for writes, so a
  write answered 401 stays an unknown outcome.
