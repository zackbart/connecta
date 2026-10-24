// Gmail MIME headers and continuation tokens are user data and paging metadata.
// Sending/settings/credential operations stay refused before authentication.
import { safe, refuse, vendorErrors, type ValueSafetyTable } from "../_shared/rest/value-safety.js";
export const TABLE = {
  title: "Gmail",

  operations: {
    "GET /drafts": vendorErrors(
      safe("Mail headers are RFC message headers; page tokens are metadata, never credentials.", [
        "drafts[].message.payload.headers",
        "nextPageToken",
      ]),
    ),
    "POST /drafts": vendorErrors(
      safe("Mail headers are RFC message headers; page tokens are metadata, never credentials.", [
        "message.payload.headers",
      ]),
    ),
    "POST /drafts/send": refuse(
      "Sending is never available; use create_draft or update_draft to save a draft for review in Gmail.",
    ),
    "GET /drafts/{id}": vendorErrors(
      safe("Mail headers are RFC message headers; page tokens are metadata, never credentials.", [
        "message.payload.headers",
      ]),
    ),
    "PUT /drafts/{id}": vendorErrors(
      safe("Mail headers are RFC message headers; page tokens are metadata, never credentials.", [
        "message.payload.headers",
      ]),
    ),
    "GET /history": vendorErrors(
      safe("Mail headers are RFC message headers; page tokens are metadata, never credentials.", [
        "history[].labelsAdded[].message.payload.headers",
        "history[].labelsRemoved[].message.payload.headers",
        "history[].messagesAdded[].message.payload.headers",
        "history[].messagesDeleted[].message.payload.headers",
        "history[].messages[].payload.headers",
        "nextPageToken",
      ]),
    ),
    "GET /messages": vendorErrors(
      safe("Mail headers are RFC message headers; page tokens are metadata, never credentials.", [
        "messages[].payload.headers",
        "nextPageToken",
      ]),
    ),
    "POST /messages": refuse(
      "This operation is outside the reviewed read allowlist; use create_draft or update_draft for draft writes. Sending is never available.",
    ),
    "POST /messages/import": refuse(
      "This operation is outside the reviewed read allowlist; use create_draft or update_draft for draft writes. Sending is never available.",
    ),
    "POST /messages/send": refuse(
      "Sending is never available; use create_draft or update_draft to save a draft for review in Gmail.",
    ),
    "GET /messages/{id}": vendorErrors(
      safe("Mail headers are RFC message headers; page tokens are metadata, never credentials.", ["payload.headers"]),
    ),
    "POST /messages/{id}/modify": refuse(
      "This operation is outside the reviewed read allowlist; use create_draft or update_draft for draft writes. Sending is never available.",
    ),
    "POST /messages/{id}/trash": refuse(
      "This operation is outside the reviewed read allowlist; use create_draft or update_draft for draft writes. Sending is never available.",
    ),
    "POST /messages/{id}/untrash": refuse(
      "This operation is outside the reviewed read allowlist; use create_draft or update_draft for draft writes. Sending is never available.",
    ),
    "GET /settings/cse/identities": refuse(
      "Mailbox settings, forwarding, delegation, CSE and S/MIME are outside this draft-only connection; use create_draft or update_draft for drafts.",
    ),
    "GET /settings/cse/keypairs": refuse(
      "Mailbox settings, forwarding, delegation, CSE and S/MIME are outside this draft-only connection; use create_draft or update_draft for drafts.",
    ),
    "POST /settings/cse/keypairs": refuse(
      "Mailbox settings, forwarding, delegation, CSE and S/MIME are outside this draft-only connection; use create_draft or update_draft for drafts.",
    ),
    "GET /settings/cse/keypairs/{keyPairId}": refuse(
      "Mailbox settings, forwarding, delegation, CSE and S/MIME are outside this draft-only connection; use create_draft or update_draft for drafts.",
    ),
    "POST /settings/cse/keypairs/{keyPairId}:disable": refuse(
      "Mailbox settings, forwarding, delegation, CSE and S/MIME are outside this draft-only connection; use create_draft or update_draft for drafts.",
    ),
    "POST /settings/cse/keypairs/{keyPairId}:enable": refuse(
      "Mailbox settings, forwarding, delegation, CSE and S/MIME are outside this draft-only connection; use create_draft or update_draft for drafts.",
    ),
    "GET /settings/sendAs": refuse(
      "Sending is never available; use create_draft or update_draft to save a draft for review in Gmail.",
    ),
    "POST /settings/sendAs": refuse(
      "Sending is never available; use create_draft or update_draft to save a draft for review in Gmail.",
    ),
    "GET /settings/sendAs/{sendAsEmail}": refuse(
      "Sending is never available; use create_draft or update_draft to save a draft for review in Gmail.",
    ),
    "PUT /settings/sendAs/{sendAsEmail}": refuse(
      "Sending is never available; use create_draft or update_draft to save a draft for review in Gmail.",
    ),
    "PATCH /settings/sendAs/{sendAsEmail}": refuse(
      "Sending is never available; use create_draft or update_draft to save a draft for review in Gmail.",
    ),
    "GET /settings/sendAs/{sendAsEmail}/smimeInfo": refuse(
      "Sending is never available; use create_draft or update_draft to save a draft for review in Gmail.",
    ),
    "POST /settings/sendAs/{sendAsEmail}/smimeInfo": refuse(
      "Sending is never available; use create_draft or update_draft to save a draft for review in Gmail.",
    ),
    "GET /settings/sendAs/{sendAsEmail}/smimeInfo/{id}": refuse(
      "Sending is never available; use create_draft or update_draft to save a draft for review in Gmail.",
    ),
    "GET /threads": vendorErrors(
      safe("Mail headers are RFC message headers; page tokens are metadata, never credentials.", [
        "nextPageToken",
        "threads[].messages[].payload.headers",
      ]),
    ),
    "GET /threads/{id}": vendorErrors(
      safe("Mail headers are RFC message headers; page tokens are metadata, never credentials.", [
        "messages[].payload.headers",
      ]),
    ),
    "POST /threads/{id}/modify": refuse(
      "This operation is outside the reviewed read allowlist; use create_draft or update_draft for draft writes. Sending is never available.",
    ),
    "POST /threads/{id}/trash": refuse(
      "This operation is outside the reviewed read allowlist; use create_draft or update_draft for draft writes. Sending is never available.",
    ),
    "POST /threads/{id}/untrash": refuse(
      "This operation is outside the reviewed read allowlist; use create_draft or update_draft for draft writes. Sending is never available.",
    ),
  },
} satisfies ValueSafetyTable;
