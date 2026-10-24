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
