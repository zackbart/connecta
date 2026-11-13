import { Effect, Option, Schema } from "effect";
import type { ApiTool } from "../../connectors/api-connector.js";
import { ConnectorCallError } from "../../errors.js";
import { Refusal } from "../../http/errors.js";
import { isMaxChars, isMinChars } from "../../http/json-schema.js";
import { write } from "../../http/tools.js";
import type { Connection } from "../../http/vendor.js";
import { Operation } from "../../runtime/call.js";
import { adminFor, type IntercomAdmin } from "./lib/admin.js";
import { record } from "./api.js";
import { NAMED_WRITES } from "./safety.js";

const MAX_BODY = 65_536;
const NUMERIC_ID = /^[1-9][0-9]{0,23}$/u;

const described = <S extends Schema.Top>(schema: S, description: string) => schema.annotate({ description });
const numericId = (description: string) => described(Schema.String.check(Schema.isPattern(NUMERIC_ID)), description);
const conversationId = numericId("Intercom conversation id, from a conversation read or search.");
const messageBody = (description: string) =>
  described(Schema.String.check(isMinChars(1), isMaxChars(MAX_BODY)), `${description} Connecta's bound.`);
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/u;

const NullableText = Schema.Union([Schema.String, Schema.Null]);
const ConversationResult = Schema.Struct({
  conversationId: Schema.String,
  state: Schema.optionalKey(NullableText.annotate({ description: "open, closed or snoozed." })),
  adminAssigneeId: Schema.optionalKey(NullableText),
  teamAssigneeId: Schema.optionalKey(NullableText),
  snoozedUntil: Schema.optionalKey(Schema.Union([Schema.Number, Schema.Null])),
  partId: Schema.optionalKey(NullableText.annotate({ description: "The conversation part this write added." })),
});
const TagResult = Schema.Struct({
  conversationId: Schema.String,
  tagId: Schema.String,
  name: Schema.optionalKey(NullableText),
});

const contextOf = Effect.gen(function* () {
  const operation = yield* Effect.serviceOption(Operation);
  if (Option.isNone(operation) || !operation.value)
    return yield* Effect.die(new Error("Missing Intercom call context."));
  return operation.value;
});

function idText(value: unknown): string | null {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : null;
}

function conversationResult(data: unknown, fallbackId: string) {
  const conversation = record(data);
  const parts = record(conversation["conversation_parts"])["conversation_parts"];
  const last = Array.isArray(parts) ? record(parts.at(-1)) : {};
  return {
    conversationId: idText(conversation["id"]) ?? fallbackId,
    state: typeof conversation["state"] === "string" ? conversation["state"] : null,
    adminAssigneeId: idText(conversation["admin_assignee_id"]),
    teamAssigneeId: idText(conversation["team_assignee_id"]),
    snoozedUntil: typeof conversation["snoozed_until"] === "number" ? conversation["snoozed_until"] : null,
    partId: idText(last["id"]),
  };
}

export function intercomTools({
  connection,
  admin,
}: {
  connection: Connection;
  admin: IntercomAdmin | undefined;
}): ApiTool[] {
  const actingAdmin = Effect.gen(function* () {
    const ctx = yield* contextOf;
    return yield* Effect.tryPromise({ try: () => adminFor(admin, ctx), catch: (error) => error }).pipe(
      Effect.catch((error) =>
        error instanceof ConnectorCallError ? Effect.fail(new Refusal({ error })) : Effect.die(error),
      ),
    );
  });
  const send = (template: string, path: string, body: (adminId: string) => Record<string, unknown>) =>
    Effect.gen(function* () {
      const adminId = yield* actingAdmin;
      return yield* connection.sendPath({
        method: template.startsWith("DELETE ") ? "DELETE" : "POST",
        path,
        template: template.slice(template.indexOf(" ") + 1),
        json: JSON.stringify(body(adminId)),
      });
    });
  const reply = (id: string, payload: Record<string, unknown>) =>
    send(NAMED_WRITES.reply, `/conversations/${id}/reply`, (adminId) => ({
      ...payload,
      type: "admin",
      admin_id: adminId,
    })).pipe(Effect.map(({ data }) => conversationResult(data, id)));
  const manage = (id: string, payload: Record<string, unknown>) =>
    send(NAMED_WRITES.manage, `/conversations/${id}/parts`, (adminId) => ({ ...payload, admin_id: adminId })).pipe(
      Effect.map(({ data }) => conversationResult(data, id)),
    );
  const ById = Schema.Struct({ conversationId });
  return [
    write(connection, {
      name: "reply_to_conversation",
      description:
        "Send a reply the customer sees in an Intercom conversation, as this connection's configured teammate. For a teammate-only message use add_conversation_note.",
      destructive: true,
      idempotent: false,
      input: Schema.Struct({ conversationId, body: messageBody("Reply text; Intercom accepts some HTML.") }),
      output: ConversationResult,
      run: (args) => reply(args.conversationId, { message_type: "comment", body: args.body }),
    }),
    write(connection, {
      name: "add_conversation_note",
      description:
        "Add an internal note to an Intercom conversation, visible to teammates only, as this connection's configured teammate. The customer is not notified.",
      destructive: false,
      idempotent: false,
      input: Schema.Struct({ conversationId, body: messageBody("Note text; Intercom accepts some HTML.") }),
      output: ConversationResult,
      run: (args) => reply(args.conversationId, { message_type: "note", body: args.body }),
    }),
    write(connection, {
      name: "close_conversation",
      description:
        "Close an Intercom conversation as this connection's configured teammate, with notifications skipped. A CSAT survey or a workflow on close can still message the customer.",
      destructive: true,
      input: ById,
      output: ConversationResult,
      run: (args) => manage(args.conversationId, { message_type: "close", type: "admin", skip_notifications: true }),
    }),
    write(connection, {
      name: "open_conversation",
      description:
        "Reopen a closed or snoozed Intercom conversation as this connection's configured teammate, with notifications skipped. It keeps its current assignee.",
      destructive: false,
      input: ById,
      output: ConversationResult,
      run: (args) => manage(args.conversationId, { message_type: "open", skip_notifications: true }),
    }),
    write(connection, {
      name: "snooze_conversation",
      description:
        "Snooze an Intercom conversation until a future time, as this connection's configured teammate. Intercom reopens it then, or sooner on a customer reply.",
      destructive: false,
      input: Schema.Struct({
        conversationId,
        until: described(
          Schema.String.check(Schema.isPattern(DATE_TIME)),
          "When it reopens, RFC 3339 with an offset; whole seconds are sent.",
        ),
      }),
      check: (args, problems) => {
        const at = Date.parse(args.until);
        if (!Number.isFinite(at) || at <= Date.now()) problems.add("until", "a future RFC 3339 time with an offset");
      },
      output: ConversationResult,
      run: (args) =>
        manage(args.conversationId, {
          message_type: "snoozed",
          snoozed_until: Math.floor(Date.parse(args.until) / 1000),
        }),
    }),
    write(connection, {
      name: "assign_conversation",
      description:
        "Assign an Intercom conversation to a teammate or team as this connection's configured teammate, with notifications skipped. A closed conversation reopens.",
      destructive: false,
      input: Schema.Struct({
        conversationId,
        assigneeType: described(Schema.Literals(["admin", "team"]), "Whether assigneeId names a teammate or a team."),
        assigneeId: numericId("The teammate (admin) or team id to assign."),
      }),
      output: ConversationResult,
      run: (args) =>
        manage(args.conversationId, {
          message_type: "assignment",
          type: args.assigneeType,
          assignee_id: args.assigneeId,
          skip_notifications: true,
        }),
    }),
    write(connection, {
      name: "unassign_conversation",
      description:
        "Unassign an Intercom conversation, clearing its teammate and team assignee, as this connection's configured teammate, with notifications skipped. A closed one reopens.",
      destructive: false,
      input: ById,
      output: ConversationResult,
      run: (args) =>
        manage(args.conversationId, {
          message_type: "assignment",
          type: "admin",
          assignee_id: "0",
          skip_notifications: true,
        }),
    }),
    write(connection, {
      name: "tag_conversation",
      description:
        "Apply an existing Intercom tag to a conversation, as this connection's configured teammate. Resolve the tag id from the tags list; this never creates a tag.",
      destructive: false,
      input: Schema.Struct({ conversationId, tagId: numericId("Intercom tag id, from the tags list.") }),
      output: TagResult,
      run: (args) =>
        send(NAMED_WRITES.tag, `/conversations/${args.conversationId}/tags`, (adminId) => ({
          id: args.tagId,
          admin_id: adminId,
        })).pipe(
          Effect.map(({ data }) => ({
            conversationId: args.conversationId,
            tagId: idText(record(data)["id"]) ?? args.tagId,
            name: typeof record(data)["name"] === "string" ? (record(data)["name"] as string) : null,
          })),
        ),
    }),
    write(connection, {
      name: "untag_conversation",
      description:
        "Remove a tag from an Intercom conversation, as this connection's configured teammate. The tag itself stays in the workspace.",
      destructive: false,
      input: Schema.Struct({ conversationId, tagId: numericId("Intercom tag id currently on the conversation.") }),
      output: TagResult,
      run: (args) =>
        send(NAMED_WRITES.untag, `/conversations/${args.conversationId}/tags/${args.tagId}`, (adminId) => ({
          admin_id: adminId,
        })).pipe(
          Effect.map(({ data }) => ({
            conversationId: args.conversationId,
            tagId: idText(record(data)["id"]) ?? args.tagId,
            name: typeof record(data)["name"] === "string" ? (record(data)["name"] as string) : null,
          })),
        ),
    }),
  ];
}
