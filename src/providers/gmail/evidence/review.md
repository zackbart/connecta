# Gmail frozen contract review

Contributor evidence for #703; not an operator procedure.

Archived official Discovery revision 20261019 is pinned by exact SHA-256 bf66f903acb058f8380b96697dcc08c778a3929182f7ec07f246b77f51cf2d97. The normalized document is reproduced offline with google-discovery-v1. All 79 methods are indexed and, since #1398, every one has a literal read, write or destructive verdict: GETs read; writes only add drafts, labels or inserted messages, or restore from trash; everything that sends, overwrites, relabels, trashes or deletes, or changes delivery, forwarding, filtering, notification, identity or security settings is destructive. That includes filter creation (a filter can trash, forward or relabel future mail), `watch` (it starts or replaces the mailbox push channel to a Pub/Sub topic), message import (Gmail classifies it as SMTP delivery), CSE identity and key-pair creation and S/MIME insertion. `provider.test.ts` asserts the complete reviewed table. Gmail now has the standard four hatches. No method is refused: each works through the confined JSON transport at its non-upload path, so none met the "cannot work through this transport" bar.

Scopes are `https://mail.google.com/` (the only Gmail scope admitting `messages.delete`, `threads.delete` and `batchDelete`), `gmail.settings.basic` and `gmail.settings.sharing`. The pinned Discovery document lists at least one of the three on every method; settings writes such as `updateImap`, `filters.create`, `delegates.create` and `forwardingAddresses.create` accept only a settings scope.

Value safety: mail data (headers, bodies, raw messages and page tokens) is the requested content and keeps its original objects, so named projections still read the result hook's encoded-field provenance; those candidates are reviewed `safe` with their header and token paths kept. Settings responses cross the reviewed table and its heuristic: `smtpMsa.password` (documented write-only, withheld if ever returned), S/MIME `pkcs12` and `encryptedKeyPassword`, and CSE `kaclsKeyMetadata.kaclsData` (the KACLS-wrapped private key) are redacted; send-as `signature` (HTML user content), S/MIME `pem` (public certificate chain) and CSE key metadata ids and URIs are kept. Settings operations whose request accepts a credential (send-as with an SMTP password) withhold vendor error text. Base64url MIME and raw-message fields cross the existing decoded sent-secret boundary; attachment size validation retains original encoded-field provenance.

Hatch writes that carry `raw` (messages send/insert/import at the top level, drafts create/update/send under `message`) are decoded once, bounded by the field's own length, then admitted by a strict MIME allowlist that accepts only structures it reads exactly as a mail client would, and refused before dispatch when any decoded header, part or attached `message/rfc822`/`message/global` entity carries a withheld link. Accepted: identity, base64 and quoted-printable transfer encodings (strict alphabets; a stray `=` is refused); US-ASCII, UTF-8, ISO-8859-n and windows-125n charsets, decoded with `TextDecoder` in fatal mode for the declared charset (undeclared text as UTF-8); RFC 2047 encoded words in those charsets, scanned both as written and with whitespace between adjacent words removed per [RFC 2047 section 6.2](https://www.rfc-editor.org/rfc/rfc2047.html#section-6.2); Content-Type, Content-Transfer-Encoding and Content-Disposition values of tokens and quoted strings only; delimiter lines that are exactly `--boundary` or `--boundary--` plus transport padding. Refused: comments, repeated or RFC 2231 extended parameters and stray characters in those headers; repeated headers; stateful and multibyte charsets (ISO-2022-_, Shift_JIS, EUC-_, GB*, Big5, UTF-16/32, UTF-7) and every other charset; invalid text in a declared charset; lines that begin with a boundary but are not exact delimiters; header lines that are not RFC 5322 fields (a field name is every byte before the first colon, less trailing whitespace); bare carriage returns; more than 8 levels, 256 parts, 4,096 encoded words or 16 MiB of decoded content. Parsing scans each line once without backtracking regexes, so admission stays linear in the message size. Named sends, drafts and forward notes run their composed MIME through the same inspection, so an ASCII subject that spells out encoded words is read as clients read it.

H8 refuses malformed, redacted, non-ASCII or control-containing copied Message-ID/References tokens before a draft or send POST/PUT. Auxiliary reply/existing-draft GET ownership from H1 is retained.

## Frozen source mapping

| Discovery method                                 | Normalized operation                                          | Hatch verdict |
| ------------------------------------------------ | ------------------------------------------------------------- | ------------- |
| gmail.users.drafts.list                          | GET /drafts                                                   | read          |
| gmail.users.drafts.create                        | POST /drafts                                                  | write         |
| gmail.users.drafts.send                          | POST /drafts/send                                             | destructive   |
| gmail.users.drafts.delete                        | DELETE /drafts/{id}                                           | destructive   |
| gmail.users.drafts.get                           | GET /drafts/{id}                                              | read          |
| gmail.users.drafts.update                        | PUT /drafts/{id}                                              | destructive   |
| gmail.users.history.list                         | GET /history                                                  | read          |
| gmail.users.labels.list                          | GET /labels                                                   | read          |
| gmail.users.labels.create                        | POST /labels                                                  | write         |
| gmail.users.labels.delete                        | DELETE /labels/{id}                                           | destructive   |
| gmail.users.labels.get                           | GET /labels/{id}                                              | read          |
| gmail.users.labels.patch                         | PATCH /labels/{id}                                            | destructive   |
| gmail.users.labels.update                        | PUT /labels/{id}                                              | destructive   |
| gmail.users.messages.list                        | GET /messages                                                 | read          |
| gmail.users.messages.insert                      | POST /messages                                                | write         |
| gmail.users.messages.batchDelete                 | POST /messages/batchDelete                                    | destructive   |
| gmail.users.messages.batchModify                 | POST /messages/batchModify                                    | destructive   |
| gmail.users.messages.import                      | POST /messages/import                                         | write         |
| gmail.users.messages.send                        | POST /messages/send                                           | destructive   |
| gmail.users.messages.delete                      | DELETE /messages/{id}                                         | destructive   |
| gmail.users.messages.get                         | GET /messages/{id}                                            | read          |
| gmail.users.messages.modify                      | POST /messages/{id}/modify                                    | destructive   |
| gmail.users.messages.trash                       | POST /messages/{id}/trash                                     | destructive   |
| gmail.users.messages.untrash                     | POST /messages/{id}/untrash                                   | write         |
| gmail.users.messages.attachments.get             | GET /messages/{messageId}/attachments/{id}                    | read          |
| gmail.users.getProfile                           | GET /profile                                                  | read          |
| gmail.users.settings.getAutoForwarding           | GET /settings/autoForwarding                                  | read          |
| gmail.users.settings.updateAutoForwarding        | PUT /settings/autoForwarding                                  | destructive   |
| gmail.users.settings.cse.identities.list         | GET /settings/cse/identities                                  | read          |
| gmail.users.settings.cse.identities.create       | POST /settings/cse/identities                                 | write         |
| gmail.users.settings.cse.identities.delete       | DELETE /settings/cse/identities/{cseEmailAddress}             | destructive   |
| gmail.users.settings.cse.identities.get          | GET /settings/cse/identities/{cseEmailAddress}                | read          |
| gmail.users.settings.cse.identities.patch        | PATCH /settings/cse/identities/{emailAddress}                 | destructive   |
| gmail.users.settings.cse.keypairs.list           | GET /settings/cse/keypairs                                    | read          |
| gmail.users.settings.cse.keypairs.create         | POST /settings/cse/keypairs                                   | write         |
| gmail.users.settings.cse.keypairs.get            | GET /settings/cse/keypairs/{keyPairId}                        | read          |
| gmail.users.settings.cse.keypairs.disable        | POST /settings/cse/keypairs/{keyPairId}:disable               | destructive   |
| gmail.users.settings.cse.keypairs.enable         | POST /settings/cse/keypairs/{keyPairId}:enable                | destructive   |
| gmail.users.settings.cse.keypairs.obliterate     | POST /settings/cse/keypairs/{keyPairId}:obliterate            | destructive   |
| gmail.users.settings.delegates.list              | GET /settings/delegates                                       | read          |
| gmail.users.settings.delegates.create            | POST /settings/delegates                                      | destructive   |
| gmail.users.settings.delegates.delete            | DELETE /settings/delegates/{delegateEmail}                    | destructive   |
| gmail.users.settings.delegates.get               | GET /settings/delegates/{delegateEmail}                       | read          |
| gmail.users.settings.filters.list                | GET /settings/filters                                         | read          |
| gmail.users.settings.filters.create              | POST /settings/filters                                        | write         |
| gmail.users.settings.filters.delete              | DELETE /settings/filters/{id}                                 | destructive   |
| gmail.users.settings.filters.get                 | GET /settings/filters/{id}                                    | read          |
| gmail.users.settings.forwardingAddresses.list    | GET /settings/forwardingAddresses                             | read          |
| gmail.users.settings.forwardingAddresses.create  | POST /settings/forwardingAddresses                            | destructive   |
| gmail.users.settings.forwardingAddresses.delete  | DELETE /settings/forwardingAddresses/{forwardingEmail}        | destructive   |
| gmail.users.settings.forwardingAddresses.get     | GET /settings/forwardingAddresses/{forwardingEmail}           | read          |
| gmail.users.settings.getImap                     | GET /settings/imap                                            | read          |
| gmail.users.settings.updateImap                  | PUT /settings/imap                                            | destructive   |
| gmail.users.settings.getLanguage                 | GET /settings/language                                        | read          |
| gmail.users.settings.updateLanguage              | PUT /settings/language                                        | destructive   |
| gmail.users.settings.getPop                      | GET /settings/pop                                             | read          |
| gmail.users.settings.updatePop                   | PUT /settings/pop                                             | destructive   |
| gmail.users.settings.sendAs.list                 | GET /settings/sendAs                                          | read          |
| gmail.users.settings.sendAs.create               | POST /settings/sendAs                                         | destructive   |
| gmail.users.settings.sendAs.delete               | DELETE /settings/sendAs/{sendAsEmail}                         | destructive   |
| gmail.users.settings.sendAs.get                  | GET /settings/sendAs/{sendAsEmail}                            | read          |
| gmail.users.settings.sendAs.patch                | PATCH /settings/sendAs/{sendAsEmail}                          | destructive   |
| gmail.users.settings.sendAs.update               | PUT /settings/sendAs/{sendAsEmail}                            | destructive   |
| gmail.users.settings.sendAs.smimeInfo.list       | GET /settings/sendAs/{sendAsEmail}/smimeInfo                  | read          |
| gmail.users.settings.sendAs.smimeInfo.insert     | POST /settings/sendAs/{sendAsEmail}/smimeInfo                 | write         |
| gmail.users.settings.sendAs.smimeInfo.delete     | DELETE /settings/sendAs/{sendAsEmail}/smimeInfo/{id}          | destructive   |
| gmail.users.settings.sendAs.smimeInfo.get        | GET /settings/sendAs/{sendAsEmail}/smimeInfo/{id}             | read          |
| gmail.users.settings.sendAs.smimeInfo.setDefault | POST /settings/sendAs/{sendAsEmail}/smimeInfo/{id}/setDefault | destructive   |
| gmail.users.settings.sendAs.verify               | POST /settings/sendAs/{sendAsEmail}/verify                    | destructive   |
| gmail.users.settings.getVacation                 | GET /settings/vacation                                        | read          |
| gmail.users.settings.updateVacation              | PUT /settings/vacation                                        | destructive   |
| gmail.users.stop                                 | POST /stop                                                    | destructive   |
| gmail.users.threads.list                         | GET /threads                                                  | read          |
| gmail.users.threads.delete                       | DELETE /threads/{id}                                          | destructive   |
| gmail.users.threads.get                          | GET /threads/{id}                                             | read          |
| gmail.users.threads.modify                       | POST /threads/{id}/modify                                     | destructive   |
| gmail.users.threads.trash                        | POST /threads/{id}/trash                                      | destructive   |
| gmail.users.threads.untrash                      | POST /threads/{id}/untrash                                    | write         |
| gmail.users.watch                                | POST /watch                                                   | write         |

## Full read-write (#1398)

The owner chose full read-write as the default, accepting the breaking scope change. Twenty-two named tools join the nine: `send_message` (new or threaded reply), `forward_message`, `send_draft`, `delete_draft`, `update_message_labels`, `update_thread_labels`, `batch_update_message_labels`, `trash_message`, `restore_message`, `trash_thread`, `restore_thread`, `delete_message`, `delete_thread`, `batch_delete_messages`, `create_label`, `update_label`, `delete_label`, `list_filters`, `create_filter`, `delete_filter`, `get_vacation` and `update_vacation`.

- Replies reuse the guarded threading of reply drafts: the answered message's `threadId`, `In-Reply-To` set to its Message-ID, `References` its chain plus that id (newest twenty), and a `Re:` subject, following [RFC 5322 section 3.6.4](https://www.rfc-editor.org/rfc/rfc5322.html#section-3.6.4). Gmail threads a sent message by `threadId`, matching references and subject ([Gmail threading](https://developers.google.com/workspace/gmail/api/guides/threads)).
- Forwards attach the original's `format=raw` bytes as a `message/rfc822` entity, unchanged except that `Bcc` and `Resent-Bcc` fields (with their folded continuations) are removed from its header block, because blind copies are private to the original sender; the field name is every byte before the first colon less trailing whitespace, compared case-insensitively, as RFC 5322's obsolete syntax allows, and a header block that breaks a line with a bare carriage return is refused rather than stripped ambiguously; embedded with a 7bit or 8bit identity encoding as [RFC 2046 section 5.2.1](https://www.rfc-editor.org/rfc/rfc2046.html#section-5.2.1) requires, in its thread with `Fwd:` threading. An original over 3 MiB (Gmail's `sizeEstimate`, then actual bytes) is refused before the raw read or send, because the whole message travels base64url inside one JSON request; an original the sent-secret boundary changed is refused rather than forwarded altered.
- Sends, forwards, draft sends, permanent deletes, relabels, trash, label updates and deletes, filters and vacation changes are destructive; draft and label creation and restores are additive writes. Descriptions say sends cannot be recalled and permanent deletes skip the trash. No sender can be chosen: Gmail sets `From` to the mailbox, and a draft update keeps the draft's own sender.
- `update_vacation` reads the current settings and keeps unstated fields, because `settings.updateVacation` replaces the whole resource; times are ISO 8601 at the edge and epoch milliseconds on the wire.
- Batch modify and delete accept up to 1,000 de-duplicated ids, Gmail's documented limit, and return counts because Gmail answers with an empty body.

Outcome journeys in `eval:outcomes` send one threaded reply and archive one message through the published Node deployment, grading the fake mailbox and the physical write ledger; the same grades fail before either write and after a repeat, and refused routes (a destructive tool through the read route, a send through the read hatch, a raw message carrying a withheld link, a send without recipients) record no write.

## Curated surface and golden accounting

At #703, before full read-write, the nine retained named tools kept their MIME, join, attachment identity and guarded-draft workflows: `search_threads`, `get_thread`, `get_message`, `get_attachment`, `list_labels`, `list_drafts`, `get_draft`, `create_draft`, `update_draft`. The three added hatches were `gmail_api_search`, `gmail_api_details`, `gmail_api_read`. No named tool was retired and no generic writer existed. Execution inventory was eleven reviewed GET keys plus the two named draft writes; complete indexed inventory was 79 keys.

Golden deltas are confined to Gmail relative to the merged main branch:

- Names: add three read-side hatches; replace the old raw-message fixture with a full-MIME hatch fixture.
- Schemas: real Effect declarations replace the legacy catalog bridge; remove `get_message.raw`, add named `fields` and preserve thread pages; labels retain a single bounded unpaged read, expose standard sparse projections and optional terminal cursors.
- Envelopes: named lists return `items/page`, the hatch returns `status/data/page?`, size cuts use top-level `truncated`, and private cursors become signed. Named search no longer returns a vendor estimate as a separate envelope field.
- Errors: activate standard Google meanings/fallbacks and incomplete-body wording while preserving reason vocabulary, numeric Retry-After and call-owned write settlement. Thread cursor conflicts remain declared local conflicts.
- Guide: the shared renderer supplies deployment context and Conventions; Gmail's domain guide states the three-hatch exception and guarded draft recovery.

H8 rejects damaged copied threading values before POST/PUT and preserves valid ASCII token bytes. Existing auxiliary ownership on reply and existing-draft GETs remains unchanged. Full MIME, history and raw-message encoded lanes retain decoded sent-secret safety and attachment-size provenance; data beyond the reviewed MIME nesting is refused. No scope, deadline or privacy-widening option is added.

The provider suite folds 26 cases into 24 without dropping assertions; the failure sweep adds two remote hatch cases and folds both offline hatch checks into its inventory case. Net collected test delta is zero. Seven deterministic Gmail reference tasks, both supported tool presentations and recovery variants pass without paid trials. Paid BEFORE/AFTER evaluation waits for the orchestrator's separate authorization.

## Measurements

Node 22.23.3, esbuild 0.28.1, gzip level 9, on `bigserv`. Like-for-like main baseline `aeae16f7` versus this implementation snapshot (before this evidence paragraph): Gmail standalone 358,072 → 378,275 B gzip (+20,203 B); all six Google exports 417,585 → 438,069 B (+20,484 B). The all-six synthetic deployment retaining every candidate index is 523,712 B gzip. The existing root, Worker, UI and example caps pass; no cap is raised. Frozen evidence JSON is outside runtime imports.

After the pre-eval merge and follow-up, like-for-like factory-export bundles against main `ff3f7c3b` measure Gmail 358,123 → 378,519 B gzip (+20,396 B) and all six Google exports 417,651 → 438,436 B (+20,785 B), using the same Node/esbuild/Worker conditions and gzip level. This supersedes the earlier snapshot for the updated branch; no cap changes.

H9 source-loader characterization was one noisy cold/warm run under concurrent fleet work, not an SLA or a deadline change. On Node 22.23.3, before `008251a8` versus the implementation: import 4,195/3,615 ms; factory 74/132 ms; call-to-first-send cold 225/133 ms and warm 14/11 ms; total named read cold 295/188 ms and warm 24/22 ms. AFTER first indexed search was 220 ms. Heap deltas across construction, search and reads were approximately 10.0/9.2 MB; these samples do not establish a regression or improvement.

## Shared prerequisites and pre-eval follow-up

Main `ff3f7c3b` was merged, including #1011's checker fixes and #1013's delegated-caller continuation binding. Named cursors now use that shared binding directly; the temporary Gmail-local caller partition is removed. Cross-caller and cross-pool-owner regressions use the real scoped registry context that supplies the shared binding, for both named reads and generic hatch reads. Fixed-subject behavior remains the shared core contract.

All eleven admitted read summaries put action vocabulary in their first sentence. Every refused operation's first sentence starts with `Refused:`, states the refused action and points to `create_draft`/`update_draft` within the compiler's 120-character limit. Natural-query rows cover thread/message search, thread messages, labels, drafts, full MIME metadata, attachments, profile, history and both sending operations. The frozen Discovery bytes and admission table are unchanged.

All seven named reads preserve top-level `truncated` after `fields` selection. Record selection runs locally over real Effect declarations, with sparse record/page schemas, and rejects unknown roots before dispatch. List selection still narrows items and retains the envelope and size report. The existing provider case proves all seven reads retain cuts even when fields omit the cut value; no test case is added.

The Gmail G4 reference adapter now calls only the AFTER `gmail_api_read` full-MIME surface. This is a reference-only eval change: prompts, fakes, outcome graders and other products' reference adapters are untouched. Current task/harness hashes and selftest evidence are recorded in `eval/baselines/notes-google-gmail-step2.md`. No paid trials have been run.

## Updated verification

With `VITEST_MAX_WORKERS=2` on Node 22.23.3: 83 standard/convention checks passed, including both former #1011 failures; the 667-test Gmail/delegation/failure-sweep/write-provenance/write-evidence/sent-secret boundary run passed; all 85 Node golden and harness tests passed with `CONNECTA_GOLDENS_DETERMINISM=1`; workerd passed 100 tests with 184 expected Node-only skips across provider goldens, source probes, kit, hatch and delegation suites. All seven Gmail selftests passed in both presentations and grading modes, with committed network/body recovery. The shared empty-collection control passed without a Forms control patch.

`check:static` and `check:build` passed, including declarations and existing bundle caps. On Node 24, the Eve check and packed runtime/emitted-type smoke passed. The public read-only Gmail drift check found no indexed or touched-endpoint drift; its standing manual attachment-identity review remains covered above. Gmail's exact Discovery digest is unchanged, all non-Gmail goldens are byte-identical to main, test delta remains zero, and no shared source or checker is changed in this branch. The eval change is confined to Gmail's reference adapter and its preparation notes. No full check or paid trial was run.

## Round-1 corrections

Thread pages survive field selection, and the domain guide explicitly describes their continuation and search thread identities. Native message examples use an id placeholder. Label reads return one bounded terminal list, with omissions in `truncated`, rather than re-downloading artificial pages. The runtime safety resolver now lives in `safety.ts`; the unused parallel TABLE is removed, and provider assertions exercise every indexed runtime admission. Copied threading accepts RFC 5322 comments, adjacent ids, quoted/local-domain forms and obsolete phrases while retaining the H8 ASCII, control and withheld-token boundary. The grammar follows [RFC 5322 sections 3.6.4 and 4.5.4](https://www.rfc-editor.org/rfc/rfc5322.html#section-3.6.4).

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

## Allowed accounts (#1381)

An OAuth-mode connection may set `accounts`, which restricts the Google account
a consent may bind. It adds `openid` and `email` to the product's scopes and
`prompt=select_account consent` to consent, and nothing else. At the callback,
before the grant is stored, the account comes from the ID token in Google's
token response, validated as
https://developers.google.com/identity/openid-connect/openid-connect#validatinganidtoken
describes: an RS256 signature by a key from `https://www.googleapis.com/oauth2/v3/certs`,
issuer `https://accounts.google.com` or `accounts.google.com`, the client id as
`aud`, and a current lifetime. Only a verified `email` matches an address rule.
Only `hd` matches a domain rule, because a consumer account may carry a verified
address at any domain. A refused account stores nothing and revokes nothing.
