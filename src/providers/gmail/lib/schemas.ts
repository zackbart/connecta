// Real Effect declarations for Gmail's curated surface. MIME interpretation stays in tools.ts.
import { Schema } from "effect";
import { Integer, isMinChars, isMaxChars } from "../../../http/json-schema.js";
import { StandardPage } from "../../../http/paging.js";
import { fieldsInput } from "../../../http/fields.js";
const optional = Schema.optionalKey;
const pattern = (regex: RegExp) =>
  Schema.makeFilter((value: string) => regex.test(value), { toJsonSchema: () => ({ pattern: regex.source }) });
const string = (description: string, max: number, min = 0) =>
  Schema.String.check(isMinChars(min), isMaxChars(max)).annotate({ description });
const id = (description: string) => string(description, 256, 1).check(pattern(/^[A-Za-z0-9_-]+$/));
const cursor = optional(string("Opaque page.nextCursor from the same call. Pass it back unchanged.", 4096, 1));
const limit = optional(
  Integer.check(Schema.isBetween({ minimum: 1, maximum: 25 })).annotate({
    default: 10,
    description: "Rows per page, default 10, at most 25. Each summary costs a metadata read.",
  }),
);
const query = optional(
  string("Gmail search syntax: from:, subject:, label:, is:unread, newer_than:7d. Omit for everything.", 2048),
);
const bodyChars = (value: number) =>
  optional(
    Integer.check(Schema.isBetween({ minimum: 0, maximum: 100000 })).annotate({
      default: value,
      description: "Body characters kept per message; size cuts appear in truncated.",
    }),
  );
const recipients = (description: string) =>
  optional(
    Schema.Array(string("Address or Name <address@example.com>.", 320, 3).check(pattern(/^[^\r\n]*$/)))
      .check(Schema.isMaxLength(100))
      .annotate({ description }),
  );
const compose = {
  to: recipients("To recipients; replies default to Reply-To, else From."),
  cc: recipients("Cc recipients."),
  bcc: recipients("Bcc recipients."),
  subject: optional(
    string("Subject; replies default to Re: and the original subject.", 900).check(pattern(/^[^\r\n]*$/)),
  ),
  body: string("Full new plain-text body.", 200000),
  htmlBody: optional(string("Optional HTML alternative to the plain-text body.", 500000)),
  replyToMessageId: optional(id("Message to reply to; sets its thread and guarded In-Reply-To/References.")),
};
const itemFields = optional(fieldsInput("Dot paths to keep in each item. It only narrows the projection."));
export const inputs = {
  search_threads: Schema.Struct({
    query,
    includeSpamTrash: optional(Schema.Boolean),
    limit,
    cursor,
    fields: itemFields,
  }),
  get_thread: Schema.Struct({
    threadId: id("Thread id from search_threads or a message."),
    maxBodyChars: bodyChars(3000),
    cursor,
  }),
  get_message: Schema.Struct({ messageId: id("Message id from a thread or draft."), maxBodyChars: bodyChars(12000) }),
  get_attachment: Schema.Struct({
    messageId: id("Message carrying the attachment."),
    partId: optional(
      string(
        "Immutable partId from the attachment listing, including an empty root id. Takes precedence over attachmentId.",
        256,
      ),
    ),
    attachmentId: optional(
      string("Alternative rotating attachmentId from a fresh listing; prefer partId.", 2048, 1).check(
        pattern(/^[A-Za-z0-9_-]+$/),
      ),
    ),
    maxChars: optional(
      Integer.check(Schema.isBetween({ minimum: 1, maximum: 100000 })).annotate({
        default: 12000,
        description: "Text code points kept; ignored for binaries.",
      }),
    ),
    maxBytes: optional(
      Integer.check(Schema.isBetween({ minimum: 65536, maximum: 4194304 })).annotate({
        default: 196608,
        description:
          "Whole-result byte budget. Raise only for a direct call_tool; execute_code cannot receive large results.",
      }),
    ),
  }),
  list_labels: Schema.Struct({ limit, cursor, fields: itemFields }),
  list_drafts: Schema.Struct({ query, limit, cursor, fields: itemFields }),
  get_draft: Schema.Struct({
    draftId: id("Stable draft id from list_drafts or create_draft."),
    maxBodyChars: bodyChars(12000),
  }),
  create_draft: Schema.Struct(compose),
  update_draft: Schema.Struct({
    draftId: id("Draft to replace; attachments and inline images are refused."),
    ...compose,
  }),
};
const loose = <F extends Schema.Struct.Fields>(fields: F) =>
  Schema.Struct(Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, optional(value)])));
const truncated = optional(Schema.Array(Schema.String));
const Attachment = loose({
  filename: Schema.String,
  mimeType: Schema.String,
  size: Integer,
  attachmentId: Schema.String,
  partId: Schema.String,
});
const messageFields = {
  id: Schema.String,
  threadId: Schema.String,
  labelIds: Schema.Array(Schema.String),
  date: Schema.String,
  from: Schema.String,
  to: Schema.String,
  cc: Schema.String,
  bcc: Schema.String,
  replyTo: Schema.String,
  subject: Schema.String,
  messageIdHeader: Schema.String,
  inReplyTo: Schema.String,
  snippet: Schema.String,
  body: Schema.String,
  bodyFormat: Schema.Literals(["text", "html", "none", "unavailable"]),
  bodyNote: Schema.String,
  attachments: Schema.Array(Attachment),
};
const Message = loose(messageFields);
const { id: _id, ...draftFields } = messageFields;
export const rows = {
  search_threads: loose({
    id: Schema.String,
    subject: Schema.String,
    from: Schema.String,
    lastFrom: Schema.String,
    messageCount: Integer,
    lastMessageAt: Schema.String,
    unread: Schema.Boolean,
    labelIds: Schema.Array(Schema.String),
    snippet: Schema.String,
  }),
  list_labels: loose({ id: Schema.String, name: Schema.String, type: Schema.Literals(["system", "user"]) }),
  list_drafts: loose({
    draftId: Schema.String,
    messageId: Schema.String,
    threadId: Schema.String,
    subject: Schema.String,
    to: Schema.String,
    updatedAt: Schema.String,
    snippet: Schema.String,
  }),
};
const listOutput = (row: Schema.Top) => Schema.Struct({ items: Schema.Array(row), page: StandardPage, truncated });
const Saved = Schema.Struct({
  draftId: optional(Schema.String),
  messageId: optional(Schema.String),
  threadId: optional(Schema.String),
  saved: Schema.Literal(true),
  sent: Schema.Literal(false),
  note: optional(Schema.String),
  truncated,
});
export const outputs = {
  search_threads: listOutput(rows.search_threads),
  list_labels: listOutput(rows.list_labels),
  list_drafts: listOutput(rows.list_drafts),
  get_thread: loose({
    id: Schema.String,
    messageCount: Integer,
    messages: Schema.Array(Message),
    page: StandardPage,
    truncated: Schema.Array(Schema.String),
  }),
  get_message: Schema.Struct({ ...Message.fields, truncated }),
  get_draft: Schema.Struct({
    ...loose({ draftId: Schema.String, messageId: Schema.String, ...draftFields }).fields,
    truncated,
  }),
  get_attachment: loose({
    messageId: Schema.String,
    partId: Schema.String,
    filename: Schema.String,
    mimeType: Schema.String,
    size: Integer,
    format: Schema.Literals(["text", "base64", "unavailable"]),
    content: Schema.String,
    note: Schema.String,
    truncated: Schema.Array(Schema.String),
  }),
  create_draft: Saved,
  update_draft: Saved,
};
export type GmailToolName = keyof typeof inputs;
