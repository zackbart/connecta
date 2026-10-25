// Node-only: the offline eval world uses Node fake-service and crypto modules.
import { describe, expect, it } from "vitest";
import { parseTrace } from "../eval/agent/trace.js";
import { ALICE } from "../eval/fakes/google.js";
import { World } from "../eval/fakes/world.js";
import { GOOGLE_TASKS } from "../eval/tasks/google.js";

const ids = Array.from({ length: 100 }, (_, i) => `m${i + 1}`);

function gmailGrade(answerIds: unknown, source = "gmail") {
  const world = new World({ google: { product: "gmail", task: 3 } });
  world.ledger.calls.push({
    seq: 1,
    at: 0,
    service: "gmail",
    tool: "GET",
    kind: "read",
    outcome: "ok",
    resultBytes: 0,
    args: {
      subject: ALICE,
      path: "/threads/t1",
      query: {},
      returned: {
        messages: ids.map((id) => ({ id, threadId: "t1" })),
      },
    },
  });
  const trace = parseTrace([], [], []);
  trace.finalAnswer = `ANSWER: ${JSON.stringify({ source, ids: answerIds })}`;
  trace.toolUses.push({
    id: "read",
    turn: 1,
    tool: "call_tool",
    input: { address: "gmail.get_thread" },
    isError: false,
    resultText: JSON.stringify({ ok: true, data: { page: { hasMore: false } } }),
  });
  return GOOGLE_TASKS.find((task) => task.id === "google-gmail-3")!.grade({ world, trace });
}

function sheetsGrade(range: string, task = 5) {
  const world = new World({ google: { product: "sheets", task } });
  const row = [task === 5 ? "external1" : "recover1", "2026-10-02", "office", task === 5 ? 77 : 88];
  const account = world.google.state.accounts[ALICE];
  account.values.push(row);
  account.mutations.push({ product: "sheets" });
  world.ledger.calls.push(
    {
      seq: 1,
      at: 0,
      service: "sheets",
      tool: "POST",
      kind: "write",
      outcome: task === 5 ? "ok" : "fault",
      resultBytes: 0,
      args: {
        subject: ALICE,
        path: `/spreadsheets/sheets1/values/${range}:append`,
        query: { valueInputOption: "RAW", insertDataOption: "INSERT_ROWS" },
        body: { values: [row] },
      },
    },
    {
      seq: 2,
      at: 0,
      service: "sheets",
      tool: "GET",
      kind: "read",
      outcome: "ok",
      resultBytes: 0,
      args: {
        subject: ALICE,
        path: "/spreadsheets/sheets1/values/'Alice''s costs'!A1:D8",
        query: {},
        returned: { values: account.values },
      },
    },
  );
  const trace = parseTrace([], [], []);
  trace.finalAnswer = `ANSWER: ${JSON.stringify({ source: "sheets", id: "sheets1", recordId: row[0], amount: row[3] })}`;
  trace.toolUses.push({
    id: "append",
    turn: 1,
    tool: "call_destructive_tool",
    input: { address: "sheets.append_values" },
    isError: false,
    resultText: undefined,
  });
  return {
    world,
    trace,
    grade: () => GOOGLE_TASKS.find((entry) => entry.id === `google-sheets-${task}`)!.grade({ world, trace }),
  };
}

describe("Google offline outcome grading (#1024)", () => {
  it("accepts complete numeric and lexical Gmail lists with all other evidence required", () => {
    for (const order of [ids, [...ids].sort()])
      expect(gmailGrade(order).filter((check) => !check.advisory && !check.pass)).toEqual([]);
  });

  it("rejects unsorted, duplicated, missing, extra and wrong-source Gmail evidence", () => {
    for (const order of [
      [...ids].reverse(),
      [ids[1], ids[0], ...ids.slice(2)],
      [...ids.slice(0, -1), "m1"],
      ids.slice(1),
      [...ids, "m101"],
      [...ids.slice(0, -1), "t1"],
    ])
      expect(gmailGrade(order).find((check) => check.id === "answer-evidence")?.pass).toBe(false);
    expect(gmailGrade(ids, "drive").find((check) => check.id === "answer-evidence")?.pass).toBe(false);
  });

  it("accepts equivalent A..D table-search ranges for append and recovery", () => {
    for (const task of [5, 6])
      for (const range of ["A:D", "A1:D1", "A1:D7", "A2:D20", "A:D7", "A1:D"])
        expect(
          sheetsGrade(`'Alice''s costs'!${range}`, task)
            .grade()
            .filter((check) => !check.advisory && !check.pass),
        ).toEqual([]);
  });

  it("rejects wrong sheets, workbooks, columns and malformed append ranges even with matching final state", () => {
    for (const range of [
      "People!A:D",
      "'Alice costs'!A:D",
      "'Alice''s costs'!B:D",
      "'Alice''s costs'!A:E",
      "'Alice''s costs'!AA:DD",
      "'Alice''s costs'!A0:D7",
      "'Alice''s costs'!A1:D7/extra",
      "'Alice''s costs'!A1:D7\n",
    ])
      expect(
        sheetsGrade(range)
          .grade()
          .find((check) => check.id === "only-requested-writes")?.pass,
      ).toBe(false);
    const wrongBook = sheetsGrade("'Alice''s costs'!A1:D7");
    wrongBook.world.ledger.calls[0]!.args.path = "/spreadsheets/other/values/'Alice''s costs'!A1:D7:append";
    expect(wrongBook.grade().find((check) => check.id === "only-requested-writes")?.pass).toBe(false);
  });

  it("still rejects duplicate, nonliteral, overwrite, wrong-row and unverified appends", () => {
    for (const defect of ["duplicate", "nonliteral", "overwrite", "wrong-row", "unverified"] as const) {
      const control = sheetsGrade("'Alice''s costs'!A1:D7");
      const write = control.world.ledger.calls[0]!;
      const query = write.args.query as { valueInputOption: string; insertDataOption: string };
      const body = write.args.body as { values: unknown[][] };
      if (defect === "duplicate") control.world.ledger.calls.push({ ...write, seq: 3 });
      if (defect === "nonliteral") query.valueInputOption = "USER_ENTERED";
      if (defect === "overwrite") query.insertDataOption = "OVERWRITE";
      if (defect === "wrong-row") body.values = [["unexpected", "2026-10-02", "office", 77]];
      if (defect === "unverified") control.world.ledger.calls.splice(1, 1);
      const check =
        defect === "duplicate"
          ? "once"
          : defect === "wrong-row"
            ? "only-requested-writes"
            : defect === "unverified"
              ? "correct-destination"
              : "state";
      expect(control.grade().find((entry) => entry.id === check)?.pass).toBe(false);
    }
  });
});
