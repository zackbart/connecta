// Real Effect declarations for Gmail's curated surface. MIME interpretation stays in tools.ts.
import { routeDescription } from "../../../agent-routes.js";
import { Schema } from "effect";
import { Integer, isMinChars, isMaxChars } from "../../../http/json-schema.js";
import { StandardPage } from "../../../http/paging.js";
import { fieldsContract } from "../../../http/fields.js";
const optional = Schema.optionalKey;
const pattern = (regex: RegExp) =>
  Schema.makeFilter((value: string) => regex.test(value), {
    toJsonSchema: () => ({ pattern: regex.source }),
  });
const string = (description: string, max: number, min = 0) =>
  Schema.String.check(isMinChars(min), isMaxChars(max)).annotate({
    description,
  });
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
const labelIds = (description: string) =>
  optional(
    Schema.Array(id("Label id from list_labels, such as INBOX, UNREAD, STARRED or Label_12."))
      .check(Schema.isMaxLength(100))
      .annotate({ description }),
  );
const relabel = {
  addLabelIds: labelIds("Label ids to add: STARRED stars, UNREAD marks unread, INBOX moves back to the inbox."),
  removeLabelIds: labelIds("Label ids to remove: INBOX archives, UNREAD marks read, STARRED unstars."),
};
const messageIds = (verb: string) =>
  Schema.Array(id("Message id from a thread or search."))
    .check(Schema.isMinLength(1), Schema.isMaxLength(1000))
    .annotate({
      description: `Message ids to ${verb}, at most 1,000 (Gmail's batch limit).`,
    });
const visibility = {
  messageListVisibility: optional(
    Schema.Literals(["show", "hide"]).annotate({
      description: "Show or hide the label in the message list.",
    }),
  ),
  labelListVisibility: optional(
    Schema.Literals(["labelShow", "labelShowIfUnread", "labelHide"]).annotate({
      description: "Show the label in the label list always, only when unread, or never.",
    }),
  ),
  color: optional(
    Schema.Struct({
      backgroundColor: string("Hex color from Gmail's label palette, such as #fb4c2f.", 7, 7).check(
        pattern(/^#[0-9a-fA-F]{6}$/),
      ),
      textColor: string("Hex color from Gmail's label palette, such as #ffffff.", 7, 7).check(
        pattern(/^#[0-9a-fA-F]{6}$/),
      ),
    }).annotate({
      description: "Label colors; Gmail accepts only its palette.",
    }),
  ),
};
const vacationTime = (description: string) =>
  optional(
    string(description, 40, 1).check(
      pattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/),
    ),
  );
const vacation = {
  enableAutoReply: optional(
    Schema.Boolean.annotate({
      description: "Turn the automatic reply on or off.",
    }),
  ),
  responseSubject: optional(string("Subject prepended to automatic replies.", 900).check(pattern(/^[^\r\n]*$/))),
  responseBodyPlainText: optional(string("Plain-text automatic reply.", 100000)),
  responseBodyHtml: optional(string("HTML automatic reply; takes precedence over plain text.", 100000)),
  restrictToContacts: optional(
    Schema.Boolean.annotate({
      description: "Reply only to the person's contacts.",
    }),
  ),
  restrictToDomain: optional(
    Schema.Boolean.annotate({
      description: "Reply only within the Workspace domain.",
    }),
  ),
  startTime: vacationTime("ISO 8601 time automatic replies start, with offset."),
  endTime: vacationTime("ISO 8601 time automatic replies stop, with offset."),
};
const filterCriteria = Schema.Struct({
  from: optional(string("Sender to match.", 1000)),
  to: optional(string("Recipient to match.", 1000)),
  subject: optional(string("Subject words to match.", 1000)),
  query: optional(string("Gmail search query the message must match.", 2048)),
  negatedQuery: optional(string("Gmail search query the message must not match.", 2048)),
  hasAttachment: optional(
    Schema.Boolean.annotate({
      description: "Match only messages with attachments.",
    }),
  ),
  excludeChats: optional(Schema.Boolean.annotate({ description: "Never match chats." })),
}).annotate({
  description: "What a message must match; state at least one criterion.",
});
const filterAction = Schema.Struct({
  addLabelIds: labelIds("Label ids to add; TRASH deletes, STARRED stars, IMPORTANT marks important."),
  removeLabelIds: labelIds("Label ids to remove: INBOX skips the inbox, UNREAD marks read."),
  forward: optional(
    string("Verified forwarding address to forward matches to.", 320, 3).check(pattern(/^[^\s@]+@[^\s@]+$/)),
  ),
}).annotate({
  description: "What happens to matches; state at least one action.",
});
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
const rows = {
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
  list_labels: loose({
    id: Schema.String,
    name: Schema.String,
    type: Schema.Literals(["system", "user"]),
  }),
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
const LabelRow = loose({
  id: Schema.String,
  name: Schema.String,
  type: Schema.Literals(["system", "user"]),
  messageListVisibility: Schema.String,
  labelListVisibility: Schema.String,
  color: loose({ backgroundColor: Schema.String, textColor: Schema.String }),
});
const FilterRow = loose({
  id: Schema.String,
  criteria: Schema.Record(Schema.String, Schema.Unknown),
  action: Schema.Record(Schema.String, Schema.Unknown),
});
const Vacation = loose({
  enableAutoReply: Schema.Boolean,
  responseSubject: Schema.String,
  responseBodyPlainText: Schema.String,
  responseBodyHtml: Schema.String,
  restrictToContacts: Schema.Boolean,
  restrictToDomain: Schema.Boolean,
  startTime: Schema.String,
  endTime: Schema.String,
});
const Sent = Schema.Struct({
  messageId: optional(Schema.String),
  threadId: optional(Schema.String),
  labelIds: optional(Schema.Array(Schema.String)),
  sent: Schema.Literal(true),
  note: optional(Schema.String),
  truncated,
});
const Relabeled = Schema.Struct({
  messageId: optional(Schema.String),
  threadId: optional(Schema.String),
  labelIds: optional(Schema.Array(Schema.String)),
  messageCount: optional(Integer),
  truncated,
});
const deleted = (key: string) => Schema.Struct({ [key]: Schema.String, deleted: Schema.Literal(true) });
const Counted = (key: "updated" | "deleted") => Schema.Struct({ [key]: Integer });
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
  list_labels: Schema.Struct({
    items: Schema.Array(rows.list_labels),
    page: Schema.Struct({ hasMore: Schema.Literal(false) }),
    truncated,
  }),
  list_drafts: listOutput(rows.list_drafts),
  get_thread: loose({
    id: Schema.String,
    messageCount: Integer,
    messages: Schema.Array(Message),
    page: loose({ hasMore: Schema.Boolean, nextCursor: Schema.String }),
    truncated: Schema.Array(Schema.String),
  }),
  get_message: Schema.Struct({ ...Message.fields, truncated }),
  get_draft: Schema.Struct({
    ...loose({
      draftId: Schema.String,
      messageId: Schema.String,
      ...draftFields,
    }).fields,
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
  send_message: Sent,
  forward_message: Sent,
  send_draft: Sent,
  delete_draft: deleted("draftId"),
  update_message_labels: Relabeled,
  update_thread_labels: Relabeled,
  batch_update_message_labels: Counted("updated"),
  trash_message: Relabeled,
  restore_message: Relabeled,
  trash_thread: Relabeled,
  restore_thread: Relabeled,
  delete_message: deleted("messageId"),
  delete_thread: deleted("threadId"),
  batch_delete_messages: Counted("deleted"),
  create_label: Schema.Struct({ ...LabelRow.fields, truncated }),
  update_label: Schema.Struct({ ...LabelRow.fields, truncated }),
  delete_label: deleted("labelId"),
  list_filters: Schema.Struct({
    items: Schema.Array(FilterRow),
    page: Schema.Struct({ hasMore: Schema.Literal(false) }),
    truncated,
  }),
  create_filter: Schema.Struct({ ...FilterRow.fields, truncated }),
  delete_filter: deleted("filterId"),
  get_vacation: Schema.Struct({ ...Vacation.fields, truncated }),
  update_vacation: Schema.Struct({ ...Vacation.fields, truncated }),
};
export type GmailToolName = keyof typeof inputs;
/** Each read's `fields`, anchored at its result or, for a list, each item. */
export const fieldContracts = {
  search_threads: fieldsContract("item", rows.search_threads),
  list_labels: fieldsContract("item", rows.list_labels),
  list_drafts: fieldsContract("item", rows.list_drafts),
  get_thread: fieldsContract("result", outputs.get_thread),
  get_message: fieldsContract("result", outputs.get_message),
  get_draft: fieldsContract("result", outputs.get_draft),
  get_attachment: fieldsContract("result", outputs.get_attachment),
  list_filters: fieldsContract("item", FilterRow),
  get_vacation: fieldsContract("result", outputs.get_vacation),
};
const fields = (name: keyof typeof fieldContracts) => optional(fieldContracts[name].input);
export const inputs = {
  search_threads: Schema.Struct({
    query,
    includeSpamTrash: optional(Schema.Boolean),
    limit,
    cursor,
    fields: fields("search_threads"),
  }),
  get_thread: Schema.Struct({
    threadId: id("Thread id from search_threads or a message."),
    maxBodyChars: bodyChars(3000),
    cursor,
    fields: fields("get_thread"),
  }),
  get_message: Schema.Struct({
    messageId: id("Message id from a thread or draft."),
    maxBodyChars: bodyChars(12000),
    fields: fields("get_message"),
  }),
  get_attachment: Schema.Struct({
    fields: fields("get_attachment"),
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
        description: routeDescription(
          (phrases) =>
            `Whole-result byte budget. Raise only ${phrases.forDirect}${phrases.program ? `; ${phrases.program} cannot receive large results` : ""}.`,
        ),
      }),
    ),
  }),
  list_labels: Schema.Struct({ fields: fields("list_labels") }),
  list_drafts: Schema.Struct({
    query,
    limit,
    cursor,
    fields: fields("list_drafts"),
  }),
  get_draft: Schema.Struct({
    fields: fields("get_draft"),
    draftId: id("Stable draft id from list_drafts or create_draft."),
    maxBodyChars: bodyChars(12000),
  }),
  create_draft: Schema.Struct(compose),
  update_draft: Schema.Struct({
    draftId: id("Draft to replace; attachments and inline images are refused."),
    ...compose,
  }),
  send_message: Schema.Struct({
    ...compose,
    to: recipients("To recipients; required for a new message, replies default to Reply-To, else From."),
  }),
  forward_message: Schema.Struct({
    messageId: id("Message to forward; it travels as an attached .eml with its attachments."),
    to: Schema.Array(string("Address or Name <address@example.com>.", 320, 3).check(pattern(/^[^\r\n]*$/)))
      .check(Schema.isMinLength(1), Schema.isMaxLength(100))
      .annotate({ description: "To recipients." }),
    cc: compose.cc,
    bcc: compose.bcc,
    subject: optional(string("Subject; defaults to Fwd: and the original subject.", 900).check(pattern(/^[^\r\n]*$/))),
    body: optional(string("Plain-text note above the forwarded message.", 200000)),
    htmlBody: compose.htmlBody,
  }),
  send_draft: Schema.Struct({
    draftId: id("Stable draft id from list_drafts or create_draft."),
  }),
  delete_draft: Schema.Struct({
    draftId: id("Stable draft id from list_drafts or create_draft."),
  }),
  update_message_labels: Schema.Struct({
    messageId: id("Message id from a thread or search."),
    ...relabel,
  }),
  update_thread_labels: Schema.Struct({
    threadId: id("Thread id from search_threads."),
    ...relabel,
  }),
  batch_update_message_labels: Schema.Struct({
    messageIds: messageIds("relabel"),
    ...relabel,
  }),
  trash_message: Schema.Struct({
    messageId: id("Message id from a thread or search."),
  }),
  restore_message: Schema.Struct({ messageId: id("Trashed message id.") }),
  trash_thread: Schema.Struct({
    threadId: id("Thread id from search_threads."),
  }),
  restore_thread: Schema.Struct({ threadId: id("Trashed thread id.") }),
  delete_message: Schema.Struct({
    messageId: id("Message id to destroy permanently."),
  }),
  delete_thread: Schema.Struct({
    threadId: id("Thread id to destroy permanently."),
  }),
  batch_delete_messages: Schema.Struct({
    messageIds: messageIds("destroy permanently"),
  }),
  create_label: Schema.Struct({
    name: string("Label name; a slash nests it, as Work/Clients.", 225, 1).check(pattern(/^[^\r\n]*$/)),
    ...visibility,
  }),
  update_label: Schema.Struct({
    labelId: id("User label id from list_labels."),
    name: optional(string("New label name.", 225, 1).check(pattern(/^[^\r\n]*$/))),
    ...visibility,
  }),
  delete_label: Schema.Struct({
    labelId: id("User label id from list_labels."),
  }),
  list_filters: Schema.Struct({ fields: fields("list_filters") }),
  create_filter: Schema.Struct({
    criteria: filterCriteria,
    action: filterAction,
  }),
  delete_filter: Schema.Struct({
    filterId: id("Filter id from list_filters."),
  }),
  get_vacation: Schema.Struct({ fields: fields("get_vacation") }),
  update_vacation: Schema.Struct(vacation),
};
