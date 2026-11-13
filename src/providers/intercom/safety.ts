import { redact, refuse, safe, type ValueSafetyTable, type ValueSafetyVerdict } from "../_shared/rest/value-safety.js";
import { openapi } from "./openapi.generated.js";

const REFUSED: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /^\/auth_tokens(?:\/|$)/,
    "Auth tokens are the credentials Fin data connectors send to outside APIs; they are managed in Intercom, not through this connection.",
  ],
  [
    /^\/data_connectors(?:\/|$)/,
    "Data connectors hold outbound request headers, authentication bypasses and request URLs for outside APIs.",
  ],
  [/^\/conversations\/stream\/token$/, "It mints or revokes a bearer token for the conversation event stream."],
  [
    /^\/(?:export|download)\//,
    "Bulk data and reporting exports, their download links and workflow exports are run from Intercom, not an agent.",
  ],
  [/^\/ip_allowlist$/, "The workspace IP allowlist is security configuration, outside this connection's scope."],
  [
    /^\/admins\/activity_logs(?:\/search)?$/,
    "Teammate audit logs record sign-ins and IP addresses; they are outside this connection's support scope.",
  ],
  [/^\/fin(?:_voice)?\//, "Fin agent runtime operations start, answer or collect AI agent sessions."],
  [/^\/calls\/\{call_id\}\/recording$/, "It redirects to the call recording media, a bearer download."],
];

const READ_POSTS = new Set([
  "POST /conversations/search",
  "POST /contacts/search",
  "POST /companies/search",
  "POST /companies/list",
  "POST /tickets/search",
  "POST /calls/search",
]);

export const NAMED_WRITES = {
  reply: "POST /conversations/{conversation_id}/reply",
  manage: "POST /conversations/{conversation_id}/parts",
  tag: "POST /conversations/{conversation_id}/tags",
  untag: "DELETE /conversations/{conversation_id}/tags/{tag_id}",
} as const;

const WRITES = new Set<string>(Object.values(NAMED_WRITES));

function refusal(method: string, path: string): string | undefined {
  const family = REFUSED.find(([pattern]) => pattern.test(path));
  if (family) return family[1];
  if (method !== "GET" && !READ_POSTS.has(`${method} ${path}`) && !WRITES.has(`${method} ${path}`))
    return "Writes are available only through the named conversation tools; this connection has no raw write access.";
  return undefined;
}

export const READS = new Set(
  openapi.ops
    .filter(([method, path]) => !refusal(method, path) && (method === "GET" || READ_POSTS.has(`${method} ${path}`)))
    .map(([method, path]) => `${method} ${path}`),
);

const ATTACHMENTS =
  "Attachment and file-attribute URLs are bearer download links and are always withheld; the name, type and size remain.";
const EMAIL_HEADERS =
  "Email header addresses and the OTP failure reason are customer data and event metadata, not credentials.";
const PART_LINKS = [
  "conversation_parts.conversation_parts[].email_message_metadata.email_address_headers",
  "conversation_parts.conversation_parts[].event_details.event.data.otp_email_verification_failed.reason",
  "source.email_message_metadata.email_address_headers",
];
const CONVERSATION = redact(
  `${ATTACHMENTS} ${EMAIL_HEADERS}`,
  ["conversation_parts.conversation_parts[].attachments[].url", "source.attachments[].url"],
  PART_LINKS,
);
const CONVERSATION_LIST = redact(
  `${ATTACHMENTS} ${EMAIL_HEADERS}`,
  ["conversations[].source.attachments[].url", "conversations[].ticket.custom_attributes.{}.value.url"],
  ["conversations[].source.email_message_metadata.email_address_headers"],
);
const TICKET = (prefix: string) =>
  redact(ATTACHMENTS, [
    `${prefix}ticket_attributes.{}.url`,
    `${prefix}ticket_attributes.{}[].url`,
    `${prefix}ticket_parts.ticket_parts[].attachments[].url`,
  ]);
const CALL_LINKS = ["recording_url", "transcription_url", "fin_recording_url", "fin_transcription_url"];
const CALLS = (prefix: string) =>
  redact(
    "Recording and transcript download URLs are withheld; read a transcript through its own operation.",
    CALL_LINKS.map((name) => `${prefix}${name}`),
  );

const REVIEWED: Readonly<Record<string, ValueSafetyVerdict>> = {
  "GET /conversations": CONVERSATION_LIST,
  "POST /conversations/search": CONVERSATION_LIST,
  "GET /conversations/{conversation_id}": CONVERSATION,
  [NAMED_WRITES.reply]: CONVERSATION,
  [NAMED_WRITES.manage]: CONVERSATION,
  "GET /conversations/{id}/side_conversations": redact(
    `${ATTACHMENTS} ${EMAIL_HEADERS}`,
    ["side_conversations[].conversation_parts[].attachments[].url"],
    [
      "side_conversations[].conversation_parts[].email_message_metadata.email_address_headers",
      "side_conversations[].conversation_parts[].event_details.event.data.otp_email_verification_failed.reason",
    ],
  ),
  "GET /tickets/{ticket_id}": TICKET(""),
  "POST /tickets/search": TICKET("tickets[]."),
  "GET /calls": CALLS("data[]."),
  "POST /calls/search": CALLS("data[]."),
  "GET /calls/{call_id}": CALLS(""),
};

const SAFE_READ = safe(
  "Workspace records, contacts and help content; no API credential is returned. Contact details are customer data, and vendor error prose stays withheld.",
);
const SAFE_WRITE = safe("The tag object applied or removed; no credential or download link is returned.");

export const INTERCOM_VALUE_SAFETY: ValueSafetyTable = {
  title: "Intercom",
  operations: Object.fromEntries(
    openapi.ops.map(([method, path]) => {
      const key = `${method} ${path}`;
      const refused = refusal(method, path);
      return [key, refused ? refuse(refused) : (REVIEWED[key] ?? (WRITES.has(key) ? SAFE_WRITE : SAFE_READ))];
    }),
  ),
  embeddedUrls: {
    operations: {
      "GET /conversations": ["conversations[].source.body", "conversations[].source.subject"],
      "POST /conversations/search": ["conversations[].source.body", "conversations[].source.subject"],
      "GET /conversations/{conversation_id}": ["conversation_parts.conversation_parts[].body", "source.body"],
      [NAMED_WRITES.reply]: ["conversation_parts.conversation_parts[].body", "source.body"],
      [NAMED_WRITES.manage]: ["conversation_parts.conversation_parts[].body", "source.body"],
      "GET /conversations/{id}/side_conversations": ["side_conversations[].conversation_parts[].body"],
      "GET /tickets/{ticket_id}": ["ticket_parts.ticket_parts[].body"],
      "POST /tickets/search": ["tickets[].ticket_parts.ticket_parts[].body"],
      "GET /notes/{note_id}": ["body"],
      "GET /contacts/{contact_id}/notes": ["data[].body"],
      "GET /companies/{company_id}/notes": ["data[].body"],
    },
  },
};
