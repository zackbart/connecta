// Reviewed against Gmail Discovery revision 20261019. Mail content is requested
// data; only send-as SMTP passwords, S/MIME private material and CSE wrapped
// private keys are withheld.
import { ConnectorCallError } from "../../errors.js";
import type { SafetyOptions } from "../../http/safety.js";
import { redact, safe, valueSafety, vendorErrors, type ValueSafetyTable } from "../_shared/rest/value-safety.js";
import { index, verdicts } from "./lib/index.js";

const MAIL =
  "Mail headers are the requested message content, and page tokens are continuations bound to the delegated grant, not credentials.";
const mail = (...keep: string[]) => vendorErrors(safe(MAIL, keep));
const CSE_KEY =
  "kaclsData is the key access control list service's wrapped private key; the key pair's id, state, public certificate and KACLS endpoint remain.";
const SEND_AS =
  "smtpMsa.password is a write-only external SMTP credential Gmail documents as never returned; it is withheld if it ever is. The HTML signature is user content.";
const SMIME =
  "pkcs12 and encryptedKeyPassword carry the private key and its password, which Gmail accepts only on insert; pem is the public certificate chain.";

export const GMAIL_VALUE_SAFETY = {
  title: "Gmail",
  operations: {
    "GET /drafts": mail("drafts[].message.payload.headers", "nextPageToken"),
    "POST /drafts": mail("message.payload.headers"),
    "POST /drafts/send": mail("payload.headers"),
    "GET /drafts/{id}": mail("message.payload.headers"),
    "PUT /drafts/{id}": mail("message.payload.headers"),
    "GET /history": mail(
      "history[].labelsAdded[].message.payload.headers",
      "history[].labelsRemoved[].message.payload.headers",
      "history[].messagesAdded[].message.payload.headers",
      "history[].messagesDeleted[].message.payload.headers",
      "history[].messages[].payload.headers",
      "nextPageToken",
    ),
    "GET /messages": mail("messages[].payload.headers", "nextPageToken"),
    "POST /messages": mail("payload.headers"),
    "POST /messages/import": mail("payload.headers"),
    "POST /messages/send": mail("payload.headers"),
    "GET /messages/{id}": mail("payload.headers"),
    "POST /messages/{id}/modify": mail("payload.headers"),
    "POST /messages/{id}/trash": mail("payload.headers"),
    "POST /messages/{id}/untrash": mail("payload.headers"),
    "GET /threads": mail("nextPageToken", "threads[].messages[].payload.headers"),
    "GET /threads/{id}": mail("messages[].payload.headers"),
    "POST /threads/{id}/modify": mail("messages[].payload.headers"),
    "POST /threads/{id}/trash": mail("messages[].payload.headers"),
    "POST /threads/{id}/untrash": mail("messages[].payload.headers"),
    "GET /settings/cse/identities": vendorErrors(
      safe("CSE identities name key pairs by id; the page token is a continuation.", ["nextPageToken"]),
    ),
    "PATCH /settings/cse/identities/{emailAddress}": vendorErrors(
      safe("A CSE identity names its key pair by id; it carries no key material."),
    ),
    "POST /settings/cse/keypairs/{keyPairId}:obliterate": vendorErrors(
      safe("Obliteration answers with an empty body; the destroyed key pair is never returned."),
    ),
    "GET /settings/cse/keypairs": redact(
      CSE_KEY,
      ["cseKeyPairs[].privateKeyMetadata[].kaclsKeyMetadata.kaclsData"],
      [
        "cseKeyPairs[].privateKeyMetadata",
        "cseKeyPairs[].privateKeyMetadata[].hardwareKeyMetadata",
        "cseKeyPairs[].privateKeyMetadata[].kaclsKeyMetadata",
        "nextPageToken",
      ],
    ),
    ...Object.fromEntries(
      [
        "POST /settings/cse/keypairs",
        "GET /settings/cse/keypairs/{keyPairId}",
        "POST /settings/cse/keypairs/{keyPairId}:disable",
        "POST /settings/cse/keypairs/{keyPairId}:enable",
      ].map((key) => [
        key,
        redact(
          CSE_KEY,
          ["privateKeyMetadata[].kaclsKeyMetadata.kaclsData"],
          ["privateKeyMetadata", "privateKeyMetadata[].hardwareKeyMetadata", "privateKeyMetadata[].kaclsKeyMetadata"],
        ),
      ]),
    ),
    "GET /settings/sendAs": redact(SEND_AS, ["sendAs[].smtpMsa.password"], ["sendAs[].signature"]),
    ...Object.fromEntries(
      [
        "POST /settings/sendAs",
        "GET /settings/sendAs/{sendAsEmail}",
        "PUT /settings/sendAs/{sendAsEmail}",
        "PATCH /settings/sendAs/{sendAsEmail}",
      ].map((key) => [key, redact(SEND_AS, ["smtpMsa.password"], ["signature"])]),
    ),
    "GET /settings/sendAs/{sendAsEmail}/smimeInfo": redact(
      SMIME,
      ["smimeInfo[].encryptedKeyPassword", "smimeInfo[].pkcs12"],
      ["smimeInfo[].pem"],
    ),
    ...Object.fromEntries(
      ["POST /settings/sendAs/{sendAsEmail}/smimeInfo", "GET /settings/sendAs/{sendAsEmail}/smimeInfo/{id}"].map(
        (key) => [key, redact(SMIME, ["encryptedKeyPassword", "pkcs12"], ["pem"])],
      ),
    ),
  },
} as const satisfies ValueSafetyTable;

const values = valueSafety(GMAIL_VALUE_SAFETY, () => index);
/**
 * Mailbox data keeps its original objects: named MIME projections read the
 * encoded-field provenance the result hook attached to them, and headers,
 * bodies and links are the requested content. Settings, which can carry
 * credentials and key material, cross the reviewed table and its heuristic.
 */
const settings = (template: string) => template.startsWith("/settings/");

/** Every indexed route has a literal verdict; an unreviewed one is refused before send. */
export function gmailSafety(): SafetyOptions {
  return {
    reviewed: {
      resolve: (method, path) => {
        const { op } = index.resolve(method, path);
        const key = `${op.method} ${op.path}`;
        const verdict = (verdicts as Readonly<Record<string, string>>)[key];
        if (verdict === undefined || verdict === "refuse")
          throw new ConnectorCallError("invalid_args", "This Gmail operation has no reviewed verdict.");
        return { method: op.method, template: op.path };
      },
      redact: (data, op) => (settings(op.template) ? values.redact(data, op.method, op.template) : data),
      withholds: (op) => (settings(op.template) ? values.withholds(op.method, op.template) : () => false),
      withholdsErrors: (op) => {
        if (!settings(op.template)) return false;
        const found = index.ops.find((entry) => entry.method === op.method && entry.path === op.template);
        return found ? values.withholdsErrors(found) : true;
      },
    },
    sensitiveFields: { names: [], choice: "drop" },
  };
}
