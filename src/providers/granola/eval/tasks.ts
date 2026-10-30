/** Same meeting outcome and independent grader on Node/SQLite and native Workers/D1. */
import { isDeepStrictEqual as same } from "node:util";
import { GRANOLA_KEY, GRANOLA_PHOTO, GRANOLA_NOTE, GRANOLA_FOLDER, GRANOLA_SPACE } from "./fake.js";
import { deliveredValues } from "../../../../eval/tasks/correctness.js";
import { check } from "../../../../eval/tasks/baseline.js";
import type { ActiveTask } from "../../../../eval/tasks/types.js";
import type { ProviderTasks } from "../../../../eval/support/provider-eval.js";

const GRANOLA_TASK: ActiveTask = {
  status: "active",
  id: "granola-workspace-journey",
  title: "Granola workspace meeting dossier",
  introducedIn: "#703",
  measures:
    "Accessible IDs, empty intermediate pages, transcript fallback, field narrowing, secrecy and durable shared credentials",
  world: { granola: true },
  prompt:
    "Read the Product space's Planning folder, its accessible notes and the complete Launch review transcript. Return sourced JSON with spaces, folders, note ids/titles, summary and transcript. Do not infer private-note access or speaker identities. The operator will restart the application before a credential persistence check.",
  followUps: [
    {
      prompt: "The application restarted. Verify the same shared Granola credential still reads this note.",
      before: async ({ deployment }) => {
        if (!deployment.restart) throw new Error("Granola journey requires restart");
        await deployment.restart();
      },
    },
  ],
  async reference(ctx) {
    const reply = await ctx.call("execute_code", {
      code: `async () => {
      const read = async (args) => (await connecta.call("granola.granola_api_read", args)).data;
      const spaces = (await read({path:"/v1/spaces"})).data.spaces;
      const folders = (await read({path:"/v1/folders"})).data.folders;
      const query = {space_id: spaces[0].id, folder_id: folders[0].id, page_size: 1};
      const notes = []; let cursor;
      do {
        const result = await read({path:"/v1/notes",query,...(cursor ? {cursor} : {})});
        notes.push(...result.data.notes); cursor=result.page.nextCursor;
      } while(cursor);
      let fallback = false;
      try { await read({path:"/v1/notes/"+notes[0].id,query:{include:"transcript"}}); }
      catch { fallback = true; }
      const detail = (await read({path:"/v1/notes/"+notes[0].id,fields:["id","summary_text","attachments.url","title"]})).data;
      const transcript = []; cursor=undefined;
      do {
        const result=await read({path:"/v1/notes/"+notes[0].id+"/transcript",query:{page_size:1},...(cursor ? {cursor} : {})});
        transcript.push(...result.data.transcript); cursor=result.page.nextCursor;
      } while(cursor);
      return {source:"Granola",spaces,folders,notes,summary:detail.summary_text,transcript,fallback,detail};
    }`,
    });
    if (reply.isError) throw new Error(reply.text);
    const answer = JSON.parse(reply.text).result;
    const sends = ctx.world.ledger.calls.length;
    for (const path of ["/v1/audit", "/v1/legal-holds", "/v1/webhook-endpoints", "https://evil.example/v1/notes"])
      if (!(await ctx.call("call_tool", { address: "granola.granola_api_read", args: { path } })).isError)
        throw new Error("Unreviewed Granola read accepted");
    if (ctx.world.ledger.calls.length !== sends) throw new Error("A refused Granola input reached the vendor");
    await ctx.nextTurn();
    const restored = await ctx.call("call_tool", {
      address: "granola.granola_api_read",
      args: { path: `/v1/notes/${GRANOLA_NOTE}`, fields: ["id", "summary_text"] },
    });
    if (restored.isError) throw new Error("Shared Granola vault credential did not survive restart");
    ctx.answer(JSON.stringify(answer));
  },
  grade({ world, trace }) {
    let answer: Record<string, any> = {};
    try {
      answer = JSON.parse(trace.finalAnswer ?? "");
    } catch {
      /* Missing answer fails. */
    }
    const state = world.fakes.granola.state;
    const calls = world.ledger.calls.filter((c) => c.service === "granola");
    const reads = calls.filter((c) => c.kind === "read" && c.outcome === "ok");
    const delivered = deliveredValues(trace);
    const has = (value: unknown) => delivered.some((row) => same(row, value));
    const query = (c: (typeof calls)[number]) => c.args.query as Record<string, string>;
    const transcriptCalls = reads.filter((c) => c.args.path === `/v1/notes/${GRANOLA_NOTE}/transcript`);
    const allText = JSON.stringify(trace);
    return [
      check(
        "delivered-data",
        "Actual workspace and complete transcript facts reached the agent",
        state.spaces.every(has) &&
          state.folders.every(has) &&
          state.transcript.every(has) &&
          has(state.notes[0]!.summary_text),
      ),
      check(
        "correct-destination",
        "Physical reads followed real IDs and both empty intermediate pages",
        reads.some(
          (c) =>
            c.args.path === "/v1/notes" &&
            query(c).space_id === GRANOLA_SPACE &&
            query(c).folder_id === GRANOLA_FOLDER &&
            query(c).cursor === "notes-next",
        ) &&
          same(
            transcriptCalls.map((c) => query(c).cursor ?? null),
            [null, "transcript-empty", "transcript-last"],
          ) &&
          calls.some((c) => c.outcome === "tool_error" && query(c).include === "transcript"),
      ),
      check(
        "answer-evidence",
        "Final dossier matches independent fake state without private-note claims",
        answer.source === "Granola" &&
          same(answer.spaces, state.spaces) &&
          same(answer.folders, state.folders) &&
          same(
            answer.notes,
            state.notes.map(({ id, title }) => ({ id, title })),
          ) &&
          same(answer.transcript, state.transcript) &&
          answer.summary === state.notes[0]!.summary_text &&
          answer.fallback === true,
      ),
      check(
        "privacy",
        "No sent key, bearer photo URL or unrelated private meeting escapes",
        ![GRANOLA_KEY, GRANOLA_PHOTO, state.privateNote.summary_text].some((secret) => allText.includes(secret)),
      ),
      check(
        "read-only",
        "Every vendor dispatch reads only the reviewed meeting scope",
        calls.length >= 9 &&
          calls.every((c) => c.kind === "read" && /^\/v1\/(notes|folders|spaces)(\/|$)/.test(String(c.args.path))),
      ),
    ];
  },
};

export const evalTasks: ProviderTasks = {
  tasks: [GRANOLA_TASK],
  checkKinds: { "granola-workspace-journey": { route: [], outcome: ["delivered-data", "privacy", "read-only"] } },
  outcomes: {
    "granola-workspace-journey": {
      scenario: "complete accessible meeting dossier, transcript fallback, privacy and shared-vault restart",
      withoutCalls: "Granola dossier",
      withoutDeliveredFacts: true,
    },
  },
  smoke: {
    description: "Actual Granola workspace meeting and shared-vault journey",
    tasks: [GRANOLA_TASK],
    worker: {
      name: "connecta-granola-smoke",
      vars: (world) => [`GRANOLA_URL:${world.fakes.granola.url}`, `GRANOLA_KEY:${world.fakes.granola.key}`],
    },
  },
  gatewayControls: ["granola-workspace-journey"],
};
