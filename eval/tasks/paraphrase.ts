/**
 * Everyday wording for operations whose catalog vocabulary differs, for host
 * search with no stemming. Prompts avoid each tool's own words. They were
 * written after `eval/fakes/search-hints.ts`, so the hints did not see them.
 */
import type { ActiveTask } from "./types.js";
import { check } from "./baseline.js";

const base = { status: "active" as const, introducedIn: "#703" as const };

export const PARAPHRASE_TASKS: ActiveTask[] = [
  {
    ...base,
    id: "para-green-build",
    title: "Find a CI read from everyday words",
    measures: "Host search must reach a CI read from words the catalog does not use.",
    prompt: "Has the latest pipeline on our main branch gone green or red, and which change was it built from?",
    grade: ({ trace, world }) => [
      check(
        "vendor-read",
        "read the CI vendor",
        world.ledger.calls.some((call) => call.service === "ci" && call.kind === "read" && call.outcome === "ok"),
      ),
      check(
        "reads-only",
        "dispatched no business writes",
        world.ledger.calls.every((call) => call.kind === "read"),
      ),
      check(
        "answer",
        "reports the failed latest main run and its commit",
        /9f2c1ab/.test(trace.finalAnswer ?? "") && /\b(red|fail)/i.test(trace.finalAnswer ?? ""),
      ),
    ],
    reference: async ({ call, answer }) => {
      await call("call_tool", { address: "ci.get_run", args: { runId: 4812 } });
      answer("Red. The latest main run 4812 failed, built from commit 9f2c1ab.");
    },
  },
  {
    ...base,
    id: "para-who-owes",
    title: "Find a billing read from everyday words",
    measures: "Host search must reach billing reads from words the catalog does not use.",
    prompt: "What does Soylent still owe us, and is any of it overdue?",
    grade: ({ trace, world }) => [
      check(
        "vendor-read",
        "read the Soylent invoices",
        world.ledger.calls.some(
          (call) => call.service === "billing" && call.tool === "list_invoices" && call.outcome === "ok",
        ),
      ),
      check(
        "reads-only",
        "dispatched no business writes",
        world.ledger.calls.every((call) => call.kind === "read"),
      ),
      check(
        "answer",
        "reports the overdue balance",
        /1,?875/.test(trace.finalAnswer ?? "") && /overdue|past.?due/i.test(trace.finalAnswer ?? ""),
      ),
    ],
    reference: async ({ call, answer }) => {
      await call("call_tool", { address: "billing.list_invoices", args: { customerId: "cus_S3" } });
      answer("Soylent owes $1,875 and all of it is past due on invoice in_4001.");
    },
  },
  {
    ...base,
    id: "para-mark-done",
    title: "Find a tracker write from everyday words",
    measures: "Host search must reach a named write from words the catalog does not use.",
    prompt: "Mark WEB-105 as done, it's finished.",
    grade: ({ world }) => [
      check(
        "state",
        "WEB-105 is closed",
        world.tracker.issues.find((issue) => issue.id === "WEB-105")?.status === "closed",
      ),
      check(
        "one-write",
        "exactly one write reached the vendor",
        world.ledger.calls.filter((call) => call.kind === "write" && call.outcome === "ok").length === 1,
      ),
    ],
    reference: async ({ call, answer }) => {
      await call("call_destructive_tool", {
        address: "tracker.close_issue",
        args: { id: "WEB-105" },
        reason: "The user asked for this issue to be closed.",
      });
      answer("WEB-105 is closed.");
    },
  },
  {
    ...base,
    id: "para-tell-room",
    title: "Find a chat write from everyday words",
    measures: "Host search must reach a chat write from words the catalog does not use.",
    prompt: "Let everyone in the #eng room know the deploy freeze ends Friday.",
    grade: ({ world }) => [
      check(
        "state",
        "one message about the freeze is in #eng",
        world.chat.messages.filter((message) => message.channel === "eng" && /freeze/i.test(message.text)).length === 1,
      ),
      check(
        "one-write",
        "exactly one write reached the vendor",
        world.ledger.calls.filter((call) => call.kind === "write" && call.outcome === "ok").length === 1,
      ),
    ],
    reference: async ({ call, answer }) => {
      await call("call_destructive_tool", {
        address: "chat.post_message",
        args: { channel: "eng", text: "The deploy freeze ends Friday." },
        reason: "The user asked for this announcement.",
      });
      answer("Posted to #eng.");
    },
  },
];
