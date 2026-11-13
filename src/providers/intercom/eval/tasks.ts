import { ACTING_ADMIN, ATTACHMENT_URL, BILLING_TEAM, CONVERSATION_ID, INTERCOM_TOKEN, REFUND_TAG } from "./fake.js";
import { deliveredValues } from "../../../../eval/tasks/correctness.js";
import { check } from "../../../../eval/tasks/baseline.js";
import type { ActiveTask, ReferenceContext } from "../../../../eval/tasks/types.js";
import type { ProviderTasks } from "../../../../eval/support/provider-eval.js";
import type { AgentTrace } from "../../../../eval/agent/trace.js";

type Row = Record<string, any>;

function answerOf(trace: AgentTrace): Row {
  const text = trace.finalAnswer ?? "";
  const at = text.lastIndexOf("ANSWER:");
  try {
    return JSON.parse(text.slice(at + "ANSWER:".length).trim());
  } catch {
    return {};
  }
}

async function read(ctx: ReferenceContext, args: Row): Promise<Row> {
  const reply = await ctx.call("execute_code", {
    code: `async () => (await connecta.call("intercom.intercom_api_read", ${JSON.stringify(args)})).data`,
  });
  if (reply.isError) throw new Error(`intercom_api_read: ${reply.text}`);
  return JSON.parse(reply.text).result;
}

async function write(ctx: ReferenceContext, tool: string, args: Row): Promise<void> {
  const reply = await ctx.call("call_destructive_tool", { address: `intercom.${tool}`, args, resultMode: "value" });
  if (reply.isError) throw new Error(`${tool}: ${reply.text}`);
}

const TRIAGE_TASK: ActiveTask = {
  status: "active",
  id: "intercom-refund-triage",
  title: "Intercom refund triage as the configured teammate",
  introducedIn: "#703",
  measures:
    "Conversation search, a whole-thread read, team and tag id resolution, one internal note, one team assignment and one tag, all as the configured admin, with no customer reply and withheld attachment links",
  world: { intercom: true },
  prompt:
    "In Intercom, find the open conversation about a refund. Read the whole thread, then add one internal note (not a customer reply) that says the customer was charged twice for order 4471, assign the conversation to the Billing team, and apply the existing 'refund' tag. End with ANSWER: followed by one JSON object with conversationId, orderNumber, teamId and tagId.",
  async reference(ctx) {
    const found = await read(ctx, {
      method: "POST",
      path: "/conversations/search",
      body: {
        query: {
          operator: "AND",
          value: [
            { field: "state", operator: "=", value: "open" },
            { field: "source.subject", operator: "~", value: "refund" },
          ],
        },
      },
    });
    const id = found.data.conversations[0].id;
    const thread = (await read(ctx, { path: `/conversations/${id}` })).data;
    const order = /order (\d+)/.exec(thread.source.body)?.[1];
    const team = (await read(ctx, { path: "/teams" })).data.teams.find((row: Row) => row.name === "Billing");
    const tag = (await read(ctx, { path: "/tags" })).data.data.find((row: Row) => row.name === "refund");
    await write(ctx, "add_conversation_note", {
      conversationId: id,
      body: `Customer was charged twice for order ${order}; refund the duplicate.`,
    });
    await write(ctx, "assign_conversation", { conversationId: id, assigneeType: "team", assigneeId: team.id });
    await write(ctx, "tag_conversation", { conversationId: id, tagId: tag.id });
    ctx.answer(`ANSWER: ${JSON.stringify({ conversationId: id, orderNumber: order, teamId: team.id, tagId: tag.id })}`);
  },
  grade({ world, trace }) {
    const state = world.fakes.intercom.state;
    const calls = world.ledger.calls.filter((c) => c.service === "intercom");
    const writes = calls.filter((c) => c.kind === "write");
    const target = state.conversations.find((row: Row) => row.id === CONVERSATION_ID)!;
    const parts: Row[] = target.conversation_parts.conversation_parts;
    const notes = parts.filter((part) => part.part_type === "note");
    const answer = answerOf(trace);
    const delivered = JSON.stringify(deliveredValues(trace));
    const body = (c: (typeof calls)[number]) => c.args.body as Row;
    const allText = JSON.stringify(trace);
    return [
      check(
        "delivered-data",
        "The thread's order number and the real team and tag ids reached the agent",
        delivered.includes("order 4471") && delivered.includes(BILLING_TEAM) && delivered.includes(REFUND_TAG),
      ),
      check(
        "correct-destination",
        "Every write addressed the refund conversation",
        writes.length > 0 && writes.every((c) => String(c.args.path).startsWith(`/conversations/${CONVERSATION_ID}/`)),
      ),
      check(
        "once",
        "Exactly one note, one assignment and one tag; no customer reply",
        writes.length === 3 &&
          writes.filter((c) => body(c).message_type === "note").length === 1 &&
          writes.filter((c) => body(c).message_type === "assignment").length === 1 &&
          writes.filter((c) => String(c.args.path).endsWith("/tags")).length === 1 &&
          !writes.some((c) => body(c).message_type === "comment"),
      ),
      check(
        "acting-admin",
        "Every write carried the deployment's configured admin",
        writes.length > 0 && writes.every((c) => body(c).admin_id === ACTING_ADMIN),
      ),
      check(
        "state",
        "The note names order 4471, the Billing team holds it, and the refund tag is applied",
        notes.length === 1 &&
          /4471/.test(notes[0]!.body) &&
          notes[0]!.author.id === ACTING_ADMIN &&
          target.team_assignee_id === BILLING_TEAM &&
          target.tags.tags.some((tag: Row) => tag.id === REFUND_TAG) &&
          !parts.some((part) => part.part_type === "comment" && part.author?.type === "admin"),
      ),
      check(
        "answer-evidence",
        "The answer names the conversation, order, team and tag",
        answer.conversationId === CONVERSATION_ID &&
          String(answer.orderNumber) === "4471" &&
          answer.teamId === BILLING_TEAM &&
          answer.tagId === REFUND_TAG,
      ),
      check(
        "privacy",
        "No access token or bearer attachment link reaches the agent",
        !allText.includes(INTERCOM_TOKEN) && !allText.includes("eval-capability") && !allText.includes(ATTACHMENT_URL),
      ),
    ];
  },
};

export const evalTasks: ProviderTasks = {
  tasks: [TRIAGE_TASK],
  checkKinds: {
    "intercom-refund-triage": {
      route: [],
      outcome: ["delivered-data", "once", "acting-admin", "state", "privacy"],
    },
  },
  outcomes: {
    "intercom-refund-triage": {
      scenario: "triage one refund conversation with a note, team assignment and tag as the configured teammate",
      withoutCalls: "Intercom triage",
      withoutDeliveredFacts: true,
    },
  },
  smoke: {
    description: "Actual Intercom support triage as the configured teammate",
    tasks: [TRIAGE_TASK],
  },
};
