// Reviewed frozen Gmail v1 inventory: 79 indexed keys, eleven executable reads.
import { OperationIndex } from "../../_shared/rest/operation-index.js";
import type { HatchDeclaration } from "../../../http/hatch.js";
import { googlePageToken } from "../../../http/hatch-paging.js";
import { openapi } from "../openapi.generated.js";
export const index = new OperationIndex(openapi, { vendor: "gmail", title: "Gmail", pathMatching: "uri-template" });
export const verdicts = {
  "GET /drafts": "read",
  "POST /drafts": "refuse",
  "POST /drafts/send": "refuse",
  "DELETE /drafts/{id}": "refuse",
  "GET /drafts/{id}": "read",
  "PUT /drafts/{id}": "refuse",
  "GET /history": "read",
  "GET /labels": "read",
  "POST /labels": "refuse",
  "DELETE /labels/{id}": "refuse",
  "GET /labels/{id}": "read",
  "PATCH /labels/{id}": "refuse",
  "PUT /labels/{id}": "refuse",
  "GET /messages": "read",
  "POST /messages": "refuse",
  "POST /messages/batchDelete": "refuse",
  "POST /messages/batchModify": "refuse",
  "POST /messages/import": "refuse",
  "POST /messages/send": "refuse",
  "DELETE /messages/{id}": "refuse",
  "GET /messages/{id}": "read",
  "POST /messages/{id}/modify": "refuse",
  "POST /messages/{id}/trash": "refuse",
  "POST /messages/{id}/untrash": "refuse",
  "GET /messages/{messageId}/attachments/{id}": "read",
  "GET /profile": "read",
  "GET /settings/autoForwarding": "refuse",
  "PUT /settings/autoForwarding": "refuse",
  "GET /settings/cse/identities": "refuse",
  "POST /settings/cse/identities": "refuse",
  "DELETE /settings/cse/identities/{cseEmailAddress}": "refuse",
  "GET /settings/cse/identities/{cseEmailAddress}": "refuse",
  "PATCH /settings/cse/identities/{emailAddress}": "refuse",
  "GET /settings/cse/keypairs": "refuse",
  "POST /settings/cse/keypairs": "refuse",
  "GET /settings/cse/keypairs/{keyPairId}": "refuse",
  "POST /settings/cse/keypairs/{keyPairId}:disable": "refuse",
  "POST /settings/cse/keypairs/{keyPairId}:enable": "refuse",
  "POST /settings/cse/keypairs/{keyPairId}:obliterate": "refuse",
  "GET /settings/delegates": "refuse",
  "POST /settings/delegates": "refuse",
  "DELETE /settings/delegates/{delegateEmail}": "refuse",
  "GET /settings/delegates/{delegateEmail}": "refuse",
  "GET /settings/filters": "refuse",
  "POST /settings/filters": "refuse",
  "DELETE /settings/filters/{id}": "refuse",
  "GET /settings/filters/{id}": "refuse",
  "GET /settings/forwardingAddresses": "refuse",
  "POST /settings/forwardingAddresses": "refuse",
  "DELETE /settings/forwardingAddresses/{forwardingEmail}": "refuse",
  "GET /settings/forwardingAddresses/{forwardingEmail}": "refuse",
  "GET /settings/imap": "refuse",
  "PUT /settings/imap": "refuse",
  "GET /settings/language": "refuse",
  "PUT /settings/language": "refuse",
  "GET /settings/pop": "refuse",
  "PUT /settings/pop": "refuse",
  "GET /settings/sendAs": "refuse",
  "POST /settings/sendAs": "refuse",
  "DELETE /settings/sendAs/{sendAsEmail}": "refuse",
  "GET /settings/sendAs/{sendAsEmail}": "refuse",
  "PATCH /settings/sendAs/{sendAsEmail}": "refuse",
  "PUT /settings/sendAs/{sendAsEmail}": "refuse",
  "GET /settings/sendAs/{sendAsEmail}/smimeInfo": "refuse",
  "POST /settings/sendAs/{sendAsEmail}/smimeInfo": "refuse",
  "DELETE /settings/sendAs/{sendAsEmail}/smimeInfo/{id}": "refuse",
  "GET /settings/sendAs/{sendAsEmail}/smimeInfo/{id}": "refuse",
  "POST /settings/sendAs/{sendAsEmail}/smimeInfo/{id}/setDefault": "refuse",
  "POST /settings/sendAs/{sendAsEmail}/verify": "refuse",
  "GET /settings/vacation": "refuse",
  "PUT /settings/vacation": "refuse",
  "POST /stop": "refuse",
  "GET /threads": "read",
  "DELETE /threads/{id}": "refuse",
  "GET /threads/{id}": "read",
  "POST /threads/{id}/modify": "refuse",
  "POST /threads/{id}/trash": "refuse",
  "POST /threads/{id}/untrash": "refuse",
  "POST /watch": "refuse",
} satisfies HatchDeclaration["verdicts"];
export const named = {
  "GET /threads": "search_threads",
  "GET /threads/{id}": "get_thread",
  "GET /messages/{id}": "get_message",
  "GET /messages/{messageId}/attachments/{id}": "get_attachment",
  "GET /labels": "list_labels",
  "GET /drafts": "list_drafts",
  "GET /drafts/{id}": "get_draft",
  "POST /drafts": "create_draft",
  "PUT /drafts/{id}": "update_draft",
} as const;
export const pages = {
  "GET /threads": googlePageToken,
  "GET /messages": googlePageToken,
  "GET /drafts": googlePageToken,
  "GET /history": googlePageToken,
} as const;

export const refusalReasons: Readonly<Record<string, string>> = {
  "POST /drafts": "Draft writes are available only through create_draft, which builds guarded reply MIME.",
  "POST /drafts/send":
    "Sending is never available; use create_draft or update_draft to save a draft for review in Gmail.",
  "DELETE /drafts/{id}":
    "This operation is outside the reviewed read allowlist; use create_draft or update_draft for draft writes. Sending is never available.",
  "PUT /drafts/{id}":
    "Draft writes are available only through update_draft, which preserves headers and refuses attachments.",
  "POST /labels":
    "This operation is outside the reviewed read allowlist; use create_draft or update_draft for draft writes. Sending is never available.",
  "DELETE /labels/{id}":
    "This operation is outside the reviewed read allowlist; use create_draft or update_draft for draft writes. Sending is never available.",
  "PATCH /labels/{id}":
    "This operation is outside the reviewed read allowlist; use create_draft or update_draft for draft writes. Sending is never available.",
  "PUT /labels/{id}":
    "This operation is outside the reviewed read allowlist; use create_draft or update_draft for draft writes. Sending is never available.",
  "POST /messages":
    "This operation is outside the reviewed read allowlist; use create_draft or update_draft for draft writes. Sending is never available.",
  "POST /messages/batchDelete":
    "This operation is outside the reviewed read allowlist; use create_draft or update_draft for draft writes. Sending is never available.",
  "POST /messages/batchModify":
    "This operation is outside the reviewed read allowlist; use create_draft or update_draft for draft writes. Sending is never available.",
  "POST /messages/import":
    "This operation is outside the reviewed read allowlist; use create_draft or update_draft for draft writes. Sending is never available.",
  "POST /messages/send":
    "Sending is never available; use create_draft or update_draft to save a draft for review in Gmail.",
  "DELETE /messages/{id}":
    "This operation is outside the reviewed read allowlist; use create_draft or update_draft for draft writes. Sending is never available.",
  "POST /messages/{id}/modify":
    "This operation is outside the reviewed read allowlist; use create_draft or update_draft for draft writes. Sending is never available.",
  "POST /messages/{id}/trash":
    "This operation is outside the reviewed read allowlist; use create_draft or update_draft for draft writes. Sending is never available.",
  "POST /messages/{id}/untrash":
    "This operation is outside the reviewed read allowlist; use create_draft or update_draft for draft writes. Sending is never available.",
  "GET /settings/autoForwarding":
    "Mailbox settings, forwarding, delegation, CSE and S/MIME are outside this draft-only connection; use create_draft or update_draft for drafts.",
  "PUT /settings/autoForwarding":
    "Mailbox settings, forwarding, delegation, CSE and S/MIME are outside this draft-only connection; use create_draft or update_draft for drafts.",
  "GET /settings/cse/identities":
    "Mailbox settings, forwarding, delegation, CSE and S/MIME are outside this draft-only connection; use create_draft or update_draft for drafts.",
  "POST /settings/cse/identities":
    "Mailbox settings, forwarding, delegation, CSE and S/MIME are outside this draft-only connection; use create_draft or update_draft for drafts.",
  "DELETE /settings/cse/identities/{cseEmailAddress}":
    "Mailbox settings, forwarding, delegation, CSE and S/MIME are outside this draft-only connection; use create_draft or update_draft for drafts.",
  "GET /settings/cse/identities/{cseEmailAddress}":
    "Mailbox settings, forwarding, delegation, CSE and S/MIME are outside this draft-only connection; use create_draft or update_draft for drafts.",
  "PATCH /settings/cse/identities/{emailAddress}":
    "Mailbox settings, forwarding, delegation, CSE and S/MIME are outside this draft-only connection; use create_draft or update_draft for drafts.",
  "GET /settings/cse/keypairs":
    "Mailbox settings, forwarding, delegation, CSE and S/MIME are outside this draft-only connection; use create_draft or update_draft for drafts.",
  "POST /settings/cse/keypairs":
    "Mailbox settings, forwarding, delegation, CSE and S/MIME are outside this draft-only connection; use create_draft or update_draft for drafts.",
  "GET /settings/cse/keypairs/{keyPairId}":
    "Mailbox settings, forwarding, delegation, CSE and S/MIME are outside this draft-only connection; use create_draft or update_draft for drafts.",
  "POST /settings/cse/keypairs/{keyPairId}:disable":
    "Mailbox settings, forwarding, delegation, CSE and S/MIME are outside this draft-only connection; use create_draft or update_draft for drafts.",
  "POST /settings/cse/keypairs/{keyPairId}:enable":
    "Mailbox settings, forwarding, delegation, CSE and S/MIME are outside this draft-only connection; use create_draft or update_draft for drafts.",
  "POST /settings/cse/keypairs/{keyPairId}:obliterate":
    "Mailbox settings, forwarding, delegation, CSE and S/MIME are outside this draft-only connection; use create_draft or update_draft for drafts.",
  "GET /settings/delegates":
    "Mailbox settings, forwarding, delegation, CSE and S/MIME are outside this draft-only connection; use create_draft or update_draft for drafts.",
  "POST /settings/delegates":
    "Mailbox settings, forwarding, delegation, CSE and S/MIME are outside this draft-only connection; use create_draft or update_draft for drafts.",
  "DELETE /settings/delegates/{delegateEmail}":
    "Mailbox settings, forwarding, delegation, CSE and S/MIME are outside this draft-only connection; use create_draft or update_draft for drafts.",
  "GET /settings/delegates/{delegateEmail}":
    "Mailbox settings, forwarding, delegation, CSE and S/MIME are outside this draft-only connection; use create_draft or update_draft for drafts.",
  "GET /settings/filters":
    "Mailbox settings, forwarding, delegation, CSE and S/MIME are outside this draft-only connection; use create_draft or update_draft for drafts.",
  "POST /settings/filters":
    "Mailbox settings, forwarding, delegation, CSE and S/MIME are outside this draft-only connection; use create_draft or update_draft for drafts.",
  "DELETE /settings/filters/{id}":
    "Mailbox settings, forwarding, delegation, CSE and S/MIME are outside this draft-only connection; use create_draft or update_draft for drafts.",
  "GET /settings/filters/{id}":
    "Mailbox settings, forwarding, delegation, CSE and S/MIME are outside this draft-only connection; use create_draft or update_draft for drafts.",
  "GET /settings/forwardingAddresses":
    "Mailbox settings, forwarding, delegation, CSE and S/MIME are outside this draft-only connection; use create_draft or update_draft for drafts.",
  "POST /settings/forwardingAddresses":
    "Mailbox settings, forwarding, delegation, CSE and S/MIME are outside this draft-only connection; use create_draft or update_draft for drafts.",
  "DELETE /settings/forwardingAddresses/{forwardingEmail}":
    "Mailbox settings, forwarding, delegation, CSE and S/MIME are outside this draft-only connection; use create_draft or update_draft for drafts.",
  "GET /settings/forwardingAddresses/{forwardingEmail}":
    "Mailbox settings, forwarding, delegation, CSE and S/MIME are outside this draft-only connection; use create_draft or update_draft for drafts.",
  "GET /settings/imap":
    "Mailbox settings, forwarding, delegation, CSE and S/MIME are outside this draft-only connection; use create_draft or update_draft for drafts.",
  "PUT /settings/imap":
    "Mailbox settings, forwarding, delegation, CSE and S/MIME are outside this draft-only connection; use create_draft or update_draft for drafts.",
  "GET /settings/language":
    "Mailbox settings, forwarding, delegation, CSE and S/MIME are outside this draft-only connection; use create_draft or update_draft for drafts.",
  "PUT /settings/language":
    "Mailbox settings, forwarding, delegation, CSE and S/MIME are outside this draft-only connection; use create_draft or update_draft for drafts.",
  "GET /settings/pop":
    "Mailbox settings, forwarding, delegation, CSE and S/MIME are outside this draft-only connection; use create_draft or update_draft for drafts.",
  "PUT /settings/pop":
    "Mailbox settings, forwarding, delegation, CSE and S/MIME are outside this draft-only connection; use create_draft or update_draft for drafts.",
  "GET /settings/sendAs":
    "Sending is never available; use create_draft or update_draft to save a draft for review in Gmail.",
  "POST /settings/sendAs":
    "Sending is never available; use create_draft or update_draft to save a draft for review in Gmail.",
  "DELETE /settings/sendAs/{sendAsEmail}":
    "Sending is never available; use create_draft or update_draft to save a draft for review in Gmail.",
  "GET /settings/sendAs/{sendAsEmail}":
    "Sending is never available; use create_draft or update_draft to save a draft for review in Gmail.",
  "PATCH /settings/sendAs/{sendAsEmail}":
    "Sending is never available; use create_draft or update_draft to save a draft for review in Gmail.",
  "PUT /settings/sendAs/{sendAsEmail}":
    "Sending is never available; use create_draft or update_draft to save a draft for review in Gmail.",
  "GET /settings/sendAs/{sendAsEmail}/smimeInfo":
    "Sending is never available; use create_draft or update_draft to save a draft for review in Gmail.",
  "POST /settings/sendAs/{sendAsEmail}/smimeInfo":
    "Sending is never available; use create_draft or update_draft to save a draft for review in Gmail.",
  "DELETE /settings/sendAs/{sendAsEmail}/smimeInfo/{id}":
    "Sending is never available; use create_draft or update_draft to save a draft for review in Gmail.",
  "GET /settings/sendAs/{sendAsEmail}/smimeInfo/{id}":
    "Sending is never available; use create_draft or update_draft to save a draft for review in Gmail.",
  "POST /settings/sendAs/{sendAsEmail}/smimeInfo/{id}/setDefault":
    "Sending is never available; use create_draft or update_draft to save a draft for review in Gmail.",
  "POST /settings/sendAs/{sendAsEmail}/verify":
    "Sending is never available; use create_draft or update_draft to save a draft for review in Gmail.",
  "GET /settings/vacation":
    "Mailbox settings, forwarding, delegation, CSE and S/MIME are outside this draft-only connection; use create_draft or update_draft for drafts.",
  "PUT /settings/vacation":
    "Mailbox settings, forwarding, delegation, CSE and S/MIME are outside this draft-only connection; use create_draft or update_draft for drafts.",
  "POST /stop":
    "This operation is outside the reviewed read allowlist; use create_draft or update_draft for draft writes. Sending is never available.",
  "DELETE /threads/{id}":
    "This operation is outside the reviewed read allowlist; use create_draft or update_draft for draft writes. Sending is never available.",
  "POST /threads/{id}/modify":
    "This operation is outside the reviewed read allowlist; use create_draft or update_draft for draft writes. Sending is never available.",
  "POST /threads/{id}/trash":
    "This operation is outside the reviewed read allowlist; use create_draft or update_draft for draft writes. Sending is never available.",
  "POST /threads/{id}/untrash":
    "This operation is outside the reviewed read allowlist; use create_draft or update_draft for draft writes. Sending is never available.",
  "POST /watch":
    "This operation is outside the reviewed read allowlist; use create_draft or update_draft for draft writes. Sending is never available.",
};
