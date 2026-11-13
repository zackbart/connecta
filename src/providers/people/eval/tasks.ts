/** Resolve attendees across three address books, save one, and label it: graded on fake state, ledger and answer. */
import { PEOPLE_PRIVATE } from "./fake.js";
import { deliveredValues } from "../../../../eval/tasks/correctness.js";
import { check } from "../../../../eval/tasks/baseline.js";
import type { ActiveTask } from "../../../../eval/tasks/types.js";
import type { ProviderTasks } from "../../../../eval/support/provider-eval.js";

type Row = Record<string, any>;

const PLANNING = "contactGroups/7a1b2c";
const ATTENDEES = [
  { name: "Bob Example", email: "bob@example.com", book: /^(my )?contacts?$/i },
  { name: "Carol Other", email: "carol@example.net", book: /other/i },
  { name: "Dana Coworker", email: "dana@example.com", book: /directory/i },
];

function answerOf(text: string | undefined): Row {
  for (const candidate of [text ?? "", /\{[\s\S]*\}/.exec(text ?? "")?.[0] ?? ""]) {
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === "object") return value;
    } catch {
      /* Try the next candidate. */
    }
  }
  return {};
}

const PEOPLE_TASK: ActiveTask = {
  status: "active",
  id: "people-attendee-journey",
  title: "Google People attendee resolution",
  introducedIn: "#703",
  measures:
    "Search warm-up, the three address books, one additive copy, one group change, sensitive-field and photo secrecy",
  world: { people: true },
  prompt:
    'Prepare the Q4 planning invite list. Resolve each attendee to an email address: Bob Example is one of my contacts, Carol Other is someone I have emailed but never saved, and Dana Coworker is in our Workspace directory. Then save Carol to my contacts exactly once and add that new contact to my "Planning" contact group. Do not report birthdays, notes or photos. Return only JSON: {"source":"Google People","attendees":[{"name","email","book"}],"carolContact":"<new contact resource name>","group":"<Planning group resource name>"}, with book one of "contacts", "other contacts" or "directory".',
  async reference(ctx) {
    const reply = await ctx.call("execute_code", {
      code: `async () => {
      const read = async (tool, args) => (await connecta.call("people." + tool, args)).data;
      const bob = (await read("search_contacts", { query: "Bob Example" })).items[0];
      const carol = (await read("search_other_contacts", { query: "Carol" })).items[0];
      const dana = (await read("search_directory", { query: "Dana" })).items[0];
      const groups = (await read("list_contact_groups", {})).items;
      return { bob, carol, dana, planning: groups.find((group) => group.name === "Planning") };
    }`,
    });
    if (reply.isError) throw new Error(reply.text);
    const found = JSON.parse(reply.text).result as Row;
    const email = (person: Row) => person.emailAddresses[0].value as string;
    const write = async (tool: string, args: Row) => {
      const result = await ctx.call("call_destructive_tool", {
        address: `people.${tool}`,
        args,
        resultMode: "value",
      });
      if (result.isError) throw new Error(result.text);
      return JSON.parse(result.text) as Row;
    };
    const copied = await write("copy_other_contact", { resourceName: found.carol.resourceName });
    const contact = (copied.data ?? copied).resourceName as string;
    await write("update_contact_group_members", { resourceName: found.planning.resourceName, add: [contact] });
    // A refused input never reaches Google: a withheld field and an unreviewed path.
    const sends = ctx.world.ledger.calls.length;
    for (const [tool, args] of [
      ["call_tool", { address: "people.get_person", args: { resourceName: "people/me", personFields: ["birthdays"] } }],
      ["call_tool", { address: "people.people_api_read", args: { path: "https://evil.example/v1/people/me" } }],
    ] as const)
      if (!(await ctx.call(tool, args)).isError) throw new Error("A refused People input was accepted");
    if (ctx.world.ledger.calls.length !== sends) throw new Error("A refused People input reached Google");
    ctx.answer(
      JSON.stringify({
        source: "Google People",
        attendees: [
          { name: "Bob Example", email: email(found.bob), book: "contacts" },
          { name: "Carol Other", email: email(found.carol), book: "other contacts" },
          { name: "Dana Coworker", email: email(found.dana), book: "directory" },
        ],
        carolContact: contact,
        group: found.planning.resourceName,
      }),
    );
  },
  grade({ world, trace }) {
    const answer = answerOf(trace.finalAnswer);
    const state = world.fakes.people.state;
    const calls = world.ledger.calls.filter((c) => c.service === "people").map((c) => ({ ...c, args: c.args as Row }));
    const reads = calls.filter((c) => c.kind === "read" && c.outcome === "ok");
    const writes = calls.filter((c) => c.kind === "write");
    const delivered = deliveredValues(trace);
    const saved = state.contacts.filter((p) => p.emailAddresses?.some((e: Row) => e.value === "carol@example.net"));
    const contact = saved[0]?.resourceName as string | undefined;
    /** A search answered with results only after its own warm-up, as Google documents. */
    const warmed = (path: string, email: string) =>
      reads.some(
        (c) =>
          c.args.path === path &&
          c.args.query.query &&
          JSON.stringify(c.args.returned ?? {}).includes(email) &&
          reads.some((w) => w.args.path === path && w.args.query.query === "" && w.seq < c.seq),
      );
    const text = JSON.stringify(trace);
    return [
      check(
        "delivered-data",
        "Each attendee's actual email address reached the agent from Google People",
        ATTENDEES.every(({ email }) => delivered.includes(email)),
      ),
      check(
        "correct-destination",
        "Warmed contact and other-contact searches and a directory search found each attendee",
        warmed("/people:searchContacts", "bob@example.com") &&
          warmed("/otherContacts:search", "carol@example.net") &&
          reads.some(
            (c) =>
              c.args.path === "/people:searchDirectoryPeople" &&
              JSON.stringify(c.args.returned ?? {}).includes("dana@example.com"),
          ) &&
          state.mints.every((mint) => mint.subject === "alice@example.com"),
      ),
      check(
        "write-once",
        "Carol was copied exactly once and that contact added to Planning once, with no other write",
        saved.length === 1 &&
          writes.length === 2 &&
          writes.filter((c) => c.args.path === "/otherContacts/c2002:copyOtherContactToMyContactsGroup").length === 1 &&
          writes.filter(
            (c) =>
              c.args.path === `/${PLANNING}/members:modify` &&
              JSON.stringify(c.args.body.resourceNamesToAdd) === JSON.stringify([contact]),
          ).length === 1 &&
          !!contact &&
          state.members[PLANNING]!.includes(contact),
      ),
      check(
        "answer-evidence",
        "The final attendee list matches independent fake state",
        answer.source === "Google People" &&
          Array.isArray(answer.attendees) &&
          answer.attendees.length === ATTENDEES.length &&
          ATTENDEES.every((expected) =>
            answer.attendees.some(
              (row: Row) =>
                row?.name === expected.name && row?.email === expected.email && expected.book.test(String(row?.book)),
            ),
          ) &&
          answer.carolContact === contact &&
          answer.group === PLANNING,
      ),
      check(
        "privacy",
        "No birthday, note, photo destination or client data escapes",
        !Object.values(PEOPLE_PRIVATE).some((secret) => text.includes(secret)),
      ),
    ];
  },
};

export const evalTasks: ProviderTasks = {
  tasks: [PEOPLE_TASK],
  checkKinds: {
    "people-attendee-journey": { route: [], outcome: ["delivered-data", "write-once", "privacy"] },
  },
  outcomes: {
    "people-attendee-journey": {
      scenario: "warmed searches across three address books, one copied contact labeled once, and contact privacy",
      withoutCalls: "People attendee list",
      withoutDeliveredFacts: true,
    },
  },
  smoke: {
    description: "Actual Google People attendee resolution, copy and labeling journey",
    tasks: [PEOPLE_TASK],
  },
};
