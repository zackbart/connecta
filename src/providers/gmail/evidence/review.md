# Gmail frozen contract review

Contributor evidence for #703; not an operator procedure.

Archived official Discovery revision 20261019 is pinned by exact SHA-256 bf66f903acb058f8380b96697dcc08c778a3929182f7ec07f246b77f51cf2d97. The normalized document is reproduced offline with google-discovery-v1. All 79 methods remain indexed; the literal admission table permits exactly eleven reads. Named create_draft/update_draft alone write. Sending, mailbox mutation, watches, settings, delegation, CSE and S/MIME remain refused. Gmail is the approved decision 0014 exception: three hatches and no gmail_api_write.

The value-safety candidates that remain executable are mail headers and pagination tokens, not vendor credentials. Refused settings include SMTP credentials, verification and private material. Mail body text and ordinary user links remain data. Base64url MIME and raw-message fields cross the existing decoded sent-secret boundary; attachment size validation retains original encoded-field provenance.

H8 refuses malformed, redacted, non-ASCII or control-containing copied Message-ID/References tokens before a draft POST/PUT. Auxiliary reply/existing-draft GET ownership from H1 is retained.

## Frozen source mapping

| Discovery method                                 | Normalized operation                                          | Hatch verdict |
| ------------------------------------------------ | ------------------------------------------------------------- | ------------- |
| gmail.users.drafts.list                          | GET /drafts                                                   | read          |
| gmail.users.drafts.create                        | POST /drafts                                                  | refuse        |
| gmail.users.drafts.send                          | POST /drafts/send                                             | refuse        |
| gmail.users.drafts.delete                        | DELETE /drafts/{id}                                           | refuse        |
| gmail.users.drafts.get                           | GET /drafts/{id}                                              | read          |
| gmail.users.drafts.update                        | PUT /drafts/{id}                                              | refuse        |
| gmail.users.history.list                         | GET /history                                                  | read          |
| gmail.users.labels.list                          | GET /labels                                                   | read          |
| gmail.users.labels.create                        | POST /labels                                                  | refuse        |
| gmail.users.labels.delete                        | DELETE /labels/{id}                                           | refuse        |
| gmail.users.labels.get                           | GET /labels/{id}                                              | read          |
| gmail.users.labels.patch                         | PATCH /labels/{id}                                            | refuse        |
| gmail.users.labels.update                        | PUT /labels/{id}                                              | refuse        |
| gmail.users.messages.list                        | GET /messages                                                 | read          |
| gmail.users.messages.insert                      | POST /messages                                                | refuse        |
| gmail.users.messages.batchDelete                 | POST /messages/batchDelete                                    | refuse        |
| gmail.users.messages.batchModify                 | POST /messages/batchModify                                    | refuse        |
| gmail.users.messages.import                      | POST /messages/import                                         | refuse        |
| gmail.users.messages.send                        | POST /messages/send                                           | refuse        |
| gmail.users.messages.delete                      | DELETE /messages/{id}                                         | refuse        |
| gmail.users.messages.get                         | GET /messages/{id}                                            | read          |
| gmail.users.messages.modify                      | POST /messages/{id}/modify                                    | refuse        |
| gmail.users.messages.trash                       | POST /messages/{id}/trash                                     | refuse        |
| gmail.users.messages.untrash                     | POST /messages/{id}/untrash                                   | refuse        |
| gmail.users.messages.attachments.get             | GET /messages/{messageId}/attachments/{id}                    | read          |
| gmail.users.getProfile                           | GET /profile                                                  | read          |
| gmail.users.settings.getAutoForwarding           | GET /settings/autoForwarding                                  | refuse        |
| gmail.users.settings.updateAutoForwarding        | PUT /settings/autoForwarding                                  | refuse        |
| gmail.users.settings.cse.identities.list         | GET /settings/cse/identities                                  | refuse        |
| gmail.users.settings.cse.identities.create       | POST /settings/cse/identities                                 | refuse        |
| gmail.users.settings.cse.identities.delete       | DELETE /settings/cse/identities/{cseEmailAddress}             | refuse        |
| gmail.users.settings.cse.identities.get          | GET /settings/cse/identities/{cseEmailAddress}                | refuse        |
| gmail.users.settings.cse.identities.patch        | PATCH /settings/cse/identities/{emailAddress}                 | refuse        |
| gmail.users.settings.cse.keypairs.list           | GET /settings/cse/keypairs                                    | refuse        |
| gmail.users.settings.cse.keypairs.create         | POST /settings/cse/keypairs                                   | refuse        |
| gmail.users.settings.cse.keypairs.get            | GET /settings/cse/keypairs/{keyPairId}                        | refuse        |
| gmail.users.settings.cse.keypairs.disable        | POST /settings/cse/keypairs/{keyPairId}:disable               | refuse        |
| gmail.users.settings.cse.keypairs.enable         | POST /settings/cse/keypairs/{keyPairId}:enable                | refuse        |
| gmail.users.settings.cse.keypairs.obliterate     | POST /settings/cse/keypairs/{keyPairId}:obliterate            | refuse        |
| gmail.users.settings.delegates.list              | GET /settings/delegates                                       | refuse        |
| gmail.users.settings.delegates.create            | POST /settings/delegates                                      | refuse        |
| gmail.users.settings.delegates.delete            | DELETE /settings/delegates/{delegateEmail}                    | refuse        |
| gmail.users.settings.delegates.get               | GET /settings/delegates/{delegateEmail}                       | refuse        |
| gmail.users.settings.filters.list                | GET /settings/filters                                         | refuse        |
| gmail.users.settings.filters.create              | POST /settings/filters                                        | refuse        |
| gmail.users.settings.filters.delete              | DELETE /settings/filters/{id}                                 | refuse        |
| gmail.users.settings.filters.get                 | GET /settings/filters/{id}                                    | refuse        |
| gmail.users.settings.forwardingAddresses.list    | GET /settings/forwardingAddresses                             | refuse        |
| gmail.users.settings.forwardingAddresses.create  | POST /settings/forwardingAddresses                            | refuse        |
| gmail.users.settings.forwardingAddresses.delete  | DELETE /settings/forwardingAddresses/{forwardingEmail}        | refuse        |
| gmail.users.settings.forwardingAddresses.get     | GET /settings/forwardingAddresses/{forwardingEmail}           | refuse        |
| gmail.users.settings.getImap                     | GET /settings/imap                                            | refuse        |
| gmail.users.settings.updateImap                  | PUT /settings/imap                                            | refuse        |
| gmail.users.settings.getLanguage                 | GET /settings/language                                        | refuse        |
| gmail.users.settings.updateLanguage              | PUT /settings/language                                        | refuse        |
| gmail.users.settings.getPop                      | GET /settings/pop                                             | refuse        |
| gmail.users.settings.updatePop                   | PUT /settings/pop                                             | refuse        |
| gmail.users.settings.sendAs.list                 | GET /settings/sendAs                                          | refuse        |
| gmail.users.settings.sendAs.create               | POST /settings/sendAs                                         | refuse        |
| gmail.users.settings.sendAs.delete               | DELETE /settings/sendAs/{sendAsEmail}                         | refuse        |
| gmail.users.settings.sendAs.get                  | GET /settings/sendAs/{sendAsEmail}                            | refuse        |
| gmail.users.settings.sendAs.patch                | PATCH /settings/sendAs/{sendAsEmail}                          | refuse        |
| gmail.users.settings.sendAs.update               | PUT /settings/sendAs/{sendAsEmail}                            | refuse        |
| gmail.users.settings.sendAs.smimeInfo.list       | GET /settings/sendAs/{sendAsEmail}/smimeInfo                  | refuse        |
| gmail.users.settings.sendAs.smimeInfo.insert     | POST /settings/sendAs/{sendAsEmail}/smimeInfo                 | refuse        |
| gmail.users.settings.sendAs.smimeInfo.delete     | DELETE /settings/sendAs/{sendAsEmail}/smimeInfo/{id}          | refuse        |
| gmail.users.settings.sendAs.smimeInfo.get        | GET /settings/sendAs/{sendAsEmail}/smimeInfo/{id}             | refuse        |
| gmail.users.settings.sendAs.smimeInfo.setDefault | POST /settings/sendAs/{sendAsEmail}/smimeInfo/{id}/setDefault | refuse        |
| gmail.users.settings.sendAs.verify               | POST /settings/sendAs/{sendAsEmail}/verify                    | refuse        |
| gmail.users.settings.getVacation                 | GET /settings/vacation                                        | refuse        |
| gmail.users.settings.updateVacation              | PUT /settings/vacation                                        | refuse        |
| gmail.users.stop                                 | POST /stop                                                    | refuse        |
| gmail.users.threads.list                         | GET /threads                                                  | read          |
| gmail.users.threads.delete                       | DELETE /threads/{id}                                          | refuse        |
| gmail.users.threads.get                          | GET /threads/{id}                                             | read          |
| gmail.users.threads.modify                       | POST /threads/{id}/modify                                     | refuse        |
| gmail.users.threads.trash                        | POST /threads/{id}/trash                                      | refuse        |
| gmail.users.threads.untrash                      | POST /threads/{id}/untrash                                    | refuse        |
| gmail.users.watch                                | POST /watch                                                   | refuse        |

## Curated surface and golden accounting

The nine retained named tools keep their MIME, join, attachment identity and guarded-draft workflows: `search_threads`, `get_thread`, `get_message`, `get_attachment`, `list_labels`, `list_drafts`, `get_draft`, `create_draft`, `update_draft`. The three added hatches are `gmail_api_search`, `gmail_api_details`, `gmail_api_read`. No named tool is retired and no generic writer exists. Execution inventory is eleven reviewed GET keys plus the two named draft writes; complete indexed inventory is 79 keys.

Golden deltas are confined to Gmail relative to the merged main branch:

- Names: add three read-side hatches; replace the old raw-message fixture with a full-MIME hatch fixture.
- Schemas: real Effect declarations replace the legacy catalog bridge; remove `get_message.raw`, add named `fields` and label `limit`, expose standard sparse projections and optional terminal cursors.
- Envelopes: named lists return `items/page`, the hatch returns `status/data/page?`, size cuts use top-level `truncated`, and private cursors become signed. Named search no longer returns a vendor estimate as a separate envelope field.
- Errors: activate standard Google meanings/fallbacks and incomplete-body wording while preserving reason vocabulary, numeric Retry-After and call-owned write settlement. Thread/label cursor conflicts remain declared local conflicts.
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
