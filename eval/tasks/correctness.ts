/** Correct destination and final-answer evidence are independent required checks. */
import type { ActiveTask, Check } from "./types.js";
import type { AgentTrace } from "../agent/trace.js";
import type { World } from "../fakes/world.js";
import type { Surface } from "../agent/surface.js";

const DELIVERED_TOOLS = ["call_tool", "call_destructive_tool", "execute_code", "read_result"];
const PAGING_KEYS = new Set(["page", "pagination", "paging"]);

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Prose or a partial preview cannot establish record facts.
    return undefined;
  }
}

function resultTexts(use: AgentTrace["toolUses"][number]): string[] {
  const texts = use.resultBlocks?.flatMap((block) =>
    block.type === "text" && typeof block.text === "string" ? [block.text] : [],
  );
  // Emitted prose and the returned JSON are separate MCP blocks. Old saved
  // traces may only have their single serialized resultText.
  return texts?.length ? texts : [use.resultText ?? ""];
}

/**
 * Whole retained results rebuilt from a truncation notice's preview and its
 * read_result pages. A range with a gap or no final page proves nothing.
 */
function reassembledResults(trace: AgentTrace): unknown[] {
  const encoder = new TextEncoder();
  const chunks = new Map<string, Map<number, { text: string; last: boolean }>>();
  const chunk = (id: string, offset: number, text: string, last: boolean) => {
    if (!chunks.has(id)) chunks.set(id, new Map());
    chunks.get(id)!.set(offset, { text, last });
  };
  for (const use of trace.toolUses) {
    if (use.isError) continue;
    // A notice-first result: one JSON header, then raw text in the next block
    // or, for a legacy saved trace, on the following lines.
    const texts = resultTexts(use);
    const [first, ...rest] = texts.length > 1 ? texts : (texts[0] ?? "").split(/\n([\s\S]*)/);
    const header = parseJson(first ?? "") as Record<string, unknown> | undefined;
    if (header?.resultId === undefined || typeof header.resultId !== "string") continue;
    if (use.tool === "read_result")
      chunk(header.resultId, Number(header.offset), rest.join(""), header.hasMore === false);
    else if (header.truncated === true && Number(header.nextOffset) > 0)
      chunk(header.resultId, 0, rest.join(""), false);
  }
  return [...chunks.values()].flatMap((pages) => {
    let joined = "";
    let offset = 0;
    for (;;) {
      const next = pages.get(offset);
      if (!next) return [];
      joined += next.text;
      if (next.last) break;
      const length = encoder.encode(next.text).length;
      if (!length) return [];
      offset += length;
    }
    const value = parseJson(joined);
    return value === undefined ? [] : [value];
  });
}

/** Facts actually returned to the agent, excluding discovery and final prose. */
export function deliveredValues(trace: AgentTrace): any[] {
  const values: any[] = [];
  const visit = (value: unknown) => {
    values.push(value);
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") Object.values(value).forEach(visit);
  };
  for (const use of trace.toolUses) {
    if (use.isError || !DELIVERED_TOOLS.includes(use.tool)) continue;
    for (const text of resultTexts(use)) {
      const value = parseJson(text);
      if (value !== undefined) visit(value);
      else {
        // A preview's body is whole JSON after its notice line, and the agent did receive those rows.
        const newline = text.indexOf("\n");
        const notice = newline > 0 ? (parseJson(text.slice(0, newline)) as { rows?: unknown } | undefined) : undefined;
        const body = notice?.rows ? parseJson(text.slice(newline + 1)) : undefined;
        if (body !== undefined) visit(body);
      }
    }
  }
  reassembledResults(trace).forEach(visit);
  return values;
}

/**
 * Whether a program reduced its records to this count, under any field name.
 * Only the program's own return counts: paging metadata such as a retained
 * `page.total` and the envelope's host-call counters describe no reduction.
 */
export function deliveredReducedCount(trace: AgentTrace, count: number): boolean {
  const found = (value: unknown): boolean =>
    value === count ||
    (Array.isArray(value)
      ? value.some(found)
      : Boolean(value) &&
        typeof value === "object" &&
        Object.entries(value as object).some(([key, item]) => !PAGING_KEYS.has(key) && found(item)));
  return trace.toolUses.some(
    (use) =>
      use.tool === "execute_code" &&
      !use.isError &&
      resultTexts(use).some((text) => {
        const body = parseJson(text) as { result?: unknown } | undefined;
        return found(body && typeof body === "object" && "result" in body ? body.result : body);
      }),
  );
}

export interface Correctness {
  destination(world: World, trace: AgentTrace, surface?: Surface): boolean;
  /** Every expression must match the final answer, never the tool output. */
  evidence: RegExp[];
  /** Replaces `evidence` on an arm where the same outcome is worded differently. */
  evidenceOn?: Partial<Record<Surface, RegExp[]>>;
  /** Required record facts, checked against every multi-field clause. */
  records?: EvidenceRecord[];
  /** Full fake record set recognizes facts from unrequested records too. */
  recordUniverse?: (world: World) => EvidenceRecord[];
  consistentAnswer?: (world: World, answer: string) => boolean;
  referenceAnswer: string;
}

type EvidenceRecord = { id: string } & Record<string, string>;

function factPattern(fact: string): RegExp {
  // Accept short or full hex SHAs by the same seven-character prefix.
  const value = /^[a-f0-9]{7,40}$/i.test(fact)
    ? `${fact.slice(0, 7)}[a-f0-9]*`
    : fact.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${value}\\b`, "i");
}

/** Match complete records and reject cross-record contradictions anywhere. */
function recordEvidence(answer: string, records: EvidenceRecord[], universe = records): boolean {
  // Markdown styling is presentation, not part of a fact. Test-count prose
  // is not a run status (for example, "0 failed tests").
  answer = answer.replace(/[*`]/g, "").replace(/\b\d+\s+(?:failed|passed)\s+tests?\b/gi, "test count");
  const patterns = records.map((record) =>
    Object.fromEntries(Object.entries(record).map(([key, fact]) => [key, factPattern(fact)])),
  );
  const known = universe.map((record) =>
    Object.fromEntries(Object.entries(record).map(([key, fact]) => [key, factPattern(fact)])),
  );
  const fields = [...new Set(known.flatMap((record) => Object.keys(record)))];
  const requiredFields = [...new Set(patterns.flatMap((record) => Object.keys(record)))];
  const hasFields = (text: string) =>
    requiredFields.every((field) => patterns.some((record) => record[field]?.test(text)));
  const hasId = (text: string) => patterns.some((record) => record.id!.test(text));
  const clauses: string[] = [];
  // Newlines delimit markdown table rows; bullets also work on a single line.
  for (const sentence of answer
    .replace(/(?:^|\n)\s*\d+[.)]\s+/g, "\n")
    .split(/[.!?](?=\s|$)|[;\r\n]+|(?:^|\s)[*•-]\s+/)) {
    let start = 0;
    for (const separator of sentence.matchAll(/,\s*|\s+and\s+/gi)) {
      const end = separator.index!;
      const next = end + separator[0].length;
      // Keep commas inside a record (including commit-first prose). Split
      // only after a complete set of fields and before another record id.
      if (hasFields(sentence.slice(start, end)) && hasId(sentence.slice(next))) {
        clauses.push(sentence.slice(start, end));
        start = next;
      }
    }
    clauses.push(sentence.slice(start));
  }
  const complete =
    records.length === 1
      ? Object.values(patterns[0]!).every((pattern) => pattern.test(answer))
      : patterns.every((record) =>
          clauses.some((clause) => Object.values(record).every((pattern) => pattern.test(clause))),
        );
  // A single-record answer may distribute evidence across sentences, but
  // every pairing must still describe that requested record. Multi-record
  // answers may describe any one real record in each clause.
  const compatible =
    records.length === 1 ? known.filter((record) => record.id!.source === patterns[0]!.id!.source) : known;
  // A commit hash the record set doesn't contain is a fabricated fact, even
  // when the true commit also appears elsewhere in the answer. A hex token is
  // a commit claim when it follows "commit"/"sha", or shares a clause with a
  // run id. UUIDs and other result ids elsewhere are not commit claims.
  const shas = universe.flatMap((record) => Object.values(record).filter((fact) => /^[a-f0-9]{7,40}$/i.test(fact)));
  const knownSha = (token: string) =>
    shas.some(
      (sha) =>
        sha.toLowerCase().startsWith(token.slice(0, 7).toLowerCase()) ||
        token.toLowerCase().startsWith(sha.toLowerCase()),
    );
  const withoutUuids = (text: string) =>
    text.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, " ");
  const runIds = known.map((record) => record.id!).filter(Boolean);
  const claimed = [...withoutUuids(answer).matchAll(/\b(?:commit|sha)\s*:?\s*([0-9a-f]{7,40})\b/gi)].map(
    (match) => match[1]!,
  );
  for (const clause of clauses.map(withoutUuids)) {
    if (!runIds.some((id) => id.test(clause))) continue;
    claimed.push(
      ...[...clause.matchAll(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/gi)].map((match) => match[0]),
    );
  }
  if (shas.length && claimed.some((token) => !knownSha(token))) return false;
  return (
    complete &&
    clauses.every((clause) => {
      const matches = fields
        .map((field) => ({
          field,
          facts: known.flatMap((record) => (record[field]?.test(clause) ? [record[field]!] : [])),
        }))
        .filter((match) => match.facts.length);
      // Shared facts (such as two runs both passing) are compatible. Every
      // fact in a clause must be consistent with at least one single record.
      return (
        matches.length < 2 ||
        compatible.some((record) =>
          matches.every(({ field, facts }) => facts.every((fact) => fact.source === record[field]?.source)),
        )
      );
    })
  );
}

/** Absence is a service fact; wording about the user's access is allowed. */
export function statesAbsence(answer: string, service: string): boolean {
  const name = service.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `\\b${name}\\b[^.!?;\\n]*\\b(?:unavailable|absent|(?:not|isn['’]t|is not|aren['’]t)\\s+(?:[\\w’']+\\s+){0,2}(?:connected|configured|available)|inaccessible)\\b|` +
      `\\b(?:unavailable|absent|(?:not|isn['’]t|is not|aren['’]t)\\s+(?:[\\w’']+\\s+){0,2}(?:connected|configured|available)|inaccessible)\\b[^.!?;\\n]*\\b${name}\\b`,
    "i",
  ).test(answer);
}

/** The value of the last ANSWER line, independent of the prose around it. */
export function answerLine(answer: string): string | undefined {
  // Markdown emphasis or code may wrap the whole line or just the label; an
  // empty trailing ANSWER line still counts as the last answer.
  const unwrap = (text: string) =>
    text
      .trim()
      .replace(/^[*_`"']+|[*_`"'.]+$/g, "")
      .trim();
  const values = answer.split(/\r?\n/).flatMap((line) => {
    const match = /^answer\s*[*_`]*\s*:\s*[*_`]*\s*(.*)$/i.exec(unwrap(line));
    return match ? [unwrap(match[1]!)] : [];
  });
  return values.at(-1);
}

/** The last ANSWER line supplies the expected result independently of prose. */
export function structuredAnswer(answer: string, expected: string): boolean {
  return answerLine(answer)?.toLowerCase() === expected.toLowerCase();
}

export function structuredAbsence(answer: string): boolean {
  return structuredAnswer(answer, "unavailable");
}

export function called(world: World, address: string, args: Record<string, unknown> = {}): boolean {
  const [service, tool] = address.split(".");
  return world.ledger.calls.some(
    (call) =>
      call.service === service &&
      call.tool === tool &&
      call.outcome === "ok" &&
      Object.entries(args).every(([key, value]) => {
        if (service === "chat" && key === "channel") {
          const channel = (input: unknown) => {
            const text = String(input).replace(/^#/, "").toLowerCase();
            return world.chat.channels.find((c) => c.name === text || c.id.toLowerCase() === text)?.id;
          };
          return channel(value) !== undefined && channel(call.args[key]) === channel(value);
        }
        return JSON.stringify(call.args[key]) === JSON.stringify(value);
      }),
  );
}

export function direct(trace: AgentTrace, tool: string, address: string): boolean {
  return trace.toolUses.some((use) => use.tool === tool && use.input.address === address && use.isError === false);
}

function correctnessChecks(spec: Correctness, world: World, trace: AgentTrace, surface?: Surface): Check[] {
  const answer = (trace.finalAnswer ?? "").replace(/[*`]/g, "");
  const evidence = (surface && spec.evidenceOn?.[surface]) ?? spec.evidence;
  return [
    {
      id: "correct-destination",
      description: "used the requested connector, tool and target",
      pass: spec.destination(world, trace, surface),
    },
    {
      id: "answer-evidence",
      description: "the final answer cites every required fake fact",
      pass:
        evidence.every((pattern) => pattern.test(answer)) &&
        (!spec.records || recordEvidence(answer, spec.records, spec.recordUniverse?.(world))) &&
        (!spec.consistentAnswer || spec.consistentAnswer(world, answer)),
      detail: answer.slice(0, 500),
    },
  ];
}

export function withCorrectness(task: ActiveTask, spec: Correctness): ActiveTask {
  return {
    ...task,
    prompt: `${task.prompt} Finish with the source system, record ids, and facts supporting your answer.`,
    grade: (ctx) => [...task.grade(ctx), ...correctnessChecks(spec, ctx.world, ctx.trace, ctx.surface)],
    reference: async (ctx) => {
      await task.reference(ctx);
      ctx.answer(spec.referenceAnswer);
    },
  };
}

/** Existing outcome graders remain, with source/evidence requirements added. */
export const EXISTING_CORRECTNESS: Record<string, Correctness> = {
  "cross-connector-join": {
    destination: (w) =>
      called(w, "tracker.search_issues") &&
      called(w, "analytics.get_account_metrics", { accountId: "acc_06" }) &&
      called(w, "chat.post_message", { channel: "triage" }),
    evidence: [/tracker/i, /analytics/i, /API-207/, /Stark/i, /56[, ]?500|56\.5k/i],
    referenceAnswer: "Tracker API-207 affects Stark Industries. Analytics acc_06 MRR is $56,500. Posted to #triage.",
  },
  "stale-close-and-summarize": {
    destination: (w) =>
      ["WEB-103", "WEB-105", "WEB-107", "WEB-110"].every((id) => called(w, "tracker.close_issue", { id })) &&
      called(w, "chat.post_message", { channel: "eng" }),
    evidence: [/tracker/i, /closed/i],
    records: ["WEB-103", "WEB-105", "WEB-107", "WEB-110"].map((id) => ({ id })),
    referenceAnswer: "Tracker closed WEB-103, WEB-105, WEB-107 and WEB-110. Posted the closure summary to #eng.",
  },
  "auth-required-recovery": {
    destination: (w) =>
      called(w, "billing.list_invoices", { customerId: "cus_N7" }) &&
      called(w, "chat.post_message", { channel: "finance" }),
    evidence: [/billing/i, /Northwind Traders/i, /5[,]?650\.50/],
    records: ["in_1002", "in_1003", "in_1005"].map((id) => ({ id })),
    referenceAnswer:
      "Billing Northwind Traders cus_N7 owes $5,650.50 on in_1002, in_1003 and in_1005. Posted to #finance.",
  },
  "truncated-read-paging": {
    destination: (w) =>
      called(w, "ci.get_run_log", { runId: 4812 }) && called(w, "chat.post_message", { channel: "ci" }),
    evidence: [/\bCI\b/i, /4812/, /test\/payments\/refund\.test\.ts/],
    referenceAnswer: "CI run 4812 failed test/payments/refund.test.ts with status 409. Posted to #ci.",
  },
  "truncated-write-export": {
    destination: (w) => called(w, "audit.export_events") && called(w, "chat.post_message", { channel: "security" }),
    evidence: [/audit/i, /prod-db/, /project\.deleted/, /dana\.whitfield@example\.com/],
    referenceAnswer: "Audit export shows prod-db project.deleted by dana.whitfield@example.com. Posted to #security.",
  },
};
