/** Calendar scheduling and invitation journeys, graded on independent fake state and the physical ledger. */
import { isDeepStrictEqual as same } from "node:util";
import { ALICE, BOB, CAROL, CONFERENCE_PIN, FREE_SLOT, INVITE_ID } from "./fake.js";
import { deliveredValues } from "../../../../eval/tasks/correctness.js";
import { check } from "../../../../eval/tasks/baseline.js";
import type { ActiveTask, ReferenceContext } from "../../../../eval/tasks/types.js";
import type { ProviderTasks } from "../../../../eval/support/provider-eval.js";
import type { World } from "../../../../eval/fakes/world.js";
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

const instant = (value: unknown) => (typeof value === "string" ? Date.parse(value) : Number.NaN);

function ledger(world: World) {
  const calls = world.ledger.calls.filter((c) => c.service === "calendar");
  return { calls, writes: calls.filter((c) => c.kind === "write") };
}

async function read(ctx: ReferenceContext, tool: string, args: Row): Promise<Row> {
  const reply = await ctx.call("execute_code", {
    code: `async () => (await connecta.call(${JSON.stringify(`calendar.${tool}`)}, ${JSON.stringify(args)})).data`,
  });
  if (reply.isError) throw new Error(`calendar.${tool}: ${reply.text}`);
  return JSON.parse(reply.text).result;
}

const write = (ctx: ReferenceContext, tool: string, args: Row) =>
  ctx.call("call_destructive_tool", { address: `calendar.${tool}`, args, resultMode: "value" });

const privacy = (trace: AgentTrace) =>
  check(
    "privacy",
    "No conference PIN or delegated credential reaches the agent",
    !JSON.stringify(trace).includes(CONFERENCE_PIN) && !JSON.stringify(trace).includes("PRIVATE KEY"),
  );

const SCHEDULE_TASK: ActiveTask = {
  status: "active",
  id: "calendar-schedule-meeting",
  title: "Calendar free/busy scheduling with a Meet link",
  introducedIn: "#703",
  measures: "Free/busy across two people, one additive insert with a Meet request, explicit no-email and withheld PINs",
  world: { calendar: true },
  prompt:
    "Find the first 30-minute slot between 2026-11-20T14:00:00Z and 2026-11-20T17:00:00Z when alice@example.com and bob@example.com are both free. Then create one event titled 'Planning sync' in Alice's primary calendar at that slot, with bob@example.com as a guest and a new Google Meet link. Do not email anyone. End with ANSWER: followed by one JSON object with eventId, start, end and meetLink.",
  async reference(ctx) {
    const busy = await read(ctx, "query_free_busy", {
      timeMin: "2026-11-20T14:00:00Z",
      timeMax: "2026-11-20T17:00:00Z",
      calendars: [ALICE, BOB],
    });
    if (busy.calendars.some((calendar: Row) => calendar.status !== "ok")) throw new Error("Availability unknown");
    const taken = busy.calendars.flatMap((calendar: Row) => calendar.busy);
    let start = Date.parse("2026-11-20T14:00:00Z");
    while (taken.some((range: Row) => Date.parse(range.start) < start + 30 * 60_000 && Date.parse(range.end) > start))
      start += 30 * 60_000;
    const reply = await write(ctx, "create_event", {
      summary: "Planning sync",
      start: { dateTime: new Date(start).toISOString() },
      end: { dateTime: new Date(start + 30 * 60_000).toISOString() },
      attendees: [{ email: BOB }],
      addGoogleMeet: true,
      sendUpdates: "none",
    });
    if (reply.isError) throw new Error(reply.text);
    const event = (reply.structured as Row).data;
    ctx.answer(
      `ANSWER: ${JSON.stringify({ eventId: event.id, start: event.start.dateTime, end: event.end.dateTime, meetLink: event.meetLink })}`,
    );
  },
  grade({ world, trace }) {
    const state = world.fakes.calendar.state;
    const { calls, writes } = ledger(world);
    const answer = answerOf(trace);
    const delivered = deliveredValues(trace);
    const has = (value: unknown) => delivered.some((row) => same(row, value));
    const created = state.events.filter((event) => String(event.id).startsWith("created"));
    const event = created[0];
    const insert = writes[0];
    return [
      check(
        "delivered-data",
        "Both people's actual busy intervals reached the agent",
        has(state.busy[ALICE]![0]) && has(state.busy[BOB]![0]),
      ),
      check(
        "correct-destination",
        "Free/busy read both people, and the event went to Alice's primary calendar",
        calls.some(
          (c) =>
            c.kind === "read" &&
            c.outcome === "ok" &&
            c.args.path === "/freeBusy" &&
            [ALICE, BOB].every((id) => (c.args.body as Row).items?.some((item: Row) => item.id === id)),
        ) && ["/calendars/primary/events", `/calendars/${ALICE}/events`].includes(String(insert?.args.path)),
      ),
      check(
        "once",
        "Exactly one write, the event insert",
        writes.length === 1 && insert?.tool.startsWith("POST ") === true,
      ),
      check(
        "state",
        "One event at the first common free slot, with Bob and a created Meet conference",
        created.length === 1 &&
          event?.summary === "Planning sync" &&
          instant(event.start?.dateTime) === Date.parse(FREE_SLOT.start) &&
          instant(event.end?.dateTime) === Date.parse(FREE_SLOT.end) &&
          event.attendees?.some((attendee: Row) => attendee.email === BOB) &&
          typeof event.hangoutLink === "string",
      ),
      check(
        "no-email",
        "The insert asked Google to email no one",
        (insert?.args.query as Row | undefined)?.sendUpdates === "none" &&
          (insert?.args.query as Row | undefined)?.conferenceDataVersion === "1",
      ),
      check(
        "answer-evidence",
        "The answer names the created event, its slot and its Meet link",
        !!event &&
          answer.eventId === event.id &&
          answer.meetLink === event.hangoutLink &&
          instant(answer.start) === Date.parse(FREE_SLOT.start) &&
          instant(answer.end) === Date.parse(FREE_SLOT.end),
      ),
      privacy(trace),
    ];
  },
};

const INVITE_TASK: ActiveTask = {
  status: "active",
  id: "calendar-invite-recovery",
  title: "Calendar invitation answer after an uncertain write",
  introducedIn: "#703",
  measures:
    "Paged search through an empty page, an instance id, guest-list preservation and reconciling a committed write answered HTTP 500",
  world: { calendar: true },
  prompt:
    "Find the 'Budget review' occurrence on 2026-11-21 in Alice's primary calendar and accept that invitation as Alice. Do not email anyone. If the result is uncertain, read the event back before doing anything else, and never answer it twice. End with ANSWER: followed by one JSON object with eventId and response.",
  async reference(ctx) {
    let cursor: unknown;
    let found: Row | undefined;
    for (let page = 0; page < 10; page++) {
      const result = await read(ctx, "list_events", {
        timeMin: "2026-11-21T00:00:00Z",
        timeMax: "2026-11-22T00:00:00Z",
        query: "Budget review",
        ...(cursor ? { cursor } : {}),
      });
      found ??= result.items.find((event: Row) => event.summary === "Budget review");
      cursor = result.page.nextCursor;
      if (!cursor) break;
    }
    if (!found) throw new Error("Budget review not found");
    const reply = await write(ctx, "respond_to_event", {
      eventId: found.id,
      response: "accepted",
      sendUpdates: "none",
    });
    if (!reply.isError) throw new Error("The committed write was expected to answer HTTP 500");
    const event = await read(ctx, "get_event", { eventId: found.id });
    ctx.answer(`ANSWER: ${JSON.stringify({ eventId: event.id, response: event.myResponseStatus })}`);
  },
  grade({ world, trace }) {
    const state = world.fakes.calendar.state;
    const { calls, writes } = ledger(world);
    const answer = answerOf(trace);
    const delivered = deliveredValues(trace);
    const invite = state.events.find((event) => event.id === INVITE_ID)!;
    const response = (email: string) => invite.attendees.find((attendee: Row) => attendee.email === email);
    const lists = calls.filter((c) => c.kind === "read" && c.args.path === "/calendars/primary/events");
    const patch = writes[0];
    return [
      check(
        "delivered-data",
        "The invitation's instance id and title reached the agent",
        delivered.some(
          (row) => row && typeof row === "object" && row.id === INVITE_ID && row.summary === "Budget review",
        ),
      ),
      check(
        "correct-destination",
        "The search followed the empty first page to the page holding the occurrence",
        lists.some((c) => !(c.args.query as Row).pageToken) &&
          lists.some((c) => (c.args.query as Row).pageToken === "events-p2" && c.outcome === "ok") &&
          String(patch?.args.path) === `/calendars/primary/events/${INVITE_ID}`,
      ),
      check(
        "once",
        "The invitation was answered with exactly one write",
        writes.length === 1 && patch?.tool.startsWith("PATCH ") === true,
      ),
      check(
        "state",
        "Alice accepted; every other guest's response and comment survived",
        response(ALICE)?.responseStatus === "accepted" &&
          response(BOB)?.responseStatus === "accepted" &&
          response(CAROL)?.responseStatus === "tentative" &&
          response(CAROL)?.comment === "May join late" &&
          invite.attendees.length === 3,
      ),
      check(
        "reconciled",
        "The uncertain write was read back before the answer",
        patch?.outcome === "fault" &&
          calls.some(
            (c) =>
              c.seq > patch.seq &&
              c.kind === "read" &&
              c.outcome === "ok" &&
              c.args.path === `/calendars/primary/events/${INVITE_ID}`,
          ),
      ),
      check(
        "no-email",
        "The answer asked Google to email no one",
        (patch?.args.query as Row | undefined)?.sendUpdates === "none",
      ),
      check(
        "answer-evidence",
        "The answer names the occurrence and the saved response",
        answer.eventId === INVITE_ID &&
          answer.response === "accepted" &&
          response(ALICE)?.responseStatus === "accepted",
      ),
      privacy(trace),
    ];
  },
};

const OUTCOME = ["delivered-data", "once", "state", "no-email", "privacy"];

export const evalTasks: ProviderTasks = {
  tasks: [SCHEDULE_TASK, INVITE_TASK],
  checkKinds: {
    "calendar-schedule-meeting": { route: [], outcome: OUTCOME },
    "calendar-invite-recovery": { route: [], outcome: [...OUTCOME, "reconciled"] },
  },
  outcomes: {
    "calendar-schedule-meeting": {
      scenario: "find a common free slot and create one Meet event without emailing guests",
      withoutCalls: "Calendar event",
      withoutDeliveredFacts: true,
    },
    "calendar-invite-recovery": {
      scenario: "accept one recurring occurrence once, reconciling a committed write answered HTTP 500",
      withoutCalls: "Calendar response",
      withoutDeliveredFacts: true,
    },
  },
  smoke: {
    description: "Actual Google Calendar delegated scheduling and invitation journeys",
    tasks: [SCHEDULE_TASK, INVITE_TASK],
  },
};
