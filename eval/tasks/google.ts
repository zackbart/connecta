/** Prompts, world and outcome checks freeze before any product's paired trials. */
import type { ActiveTask, ReferenceContext, Check } from "./types.js";
import type { World } from "../fakes/world.js";
import type { AgentTrace } from "../agent/trace.js";
import {
  GOOGLE_PRODUCTS,
  ALICE,
  ATTACHMENT,
  DOC_PARAGRAPHS,
  googleState,
  type GoogleProduct,
} from "../fakes/google.js";
import { check } from "./baseline.js";

type Row = Record<string, any>;
const goals: Record<GoogleProduct, readonly string[]> = {
  gmail: [
    "Count unread messages from alice@example.com with Budget in the subject received after 2026-09-30 and before 2026-10-03. Report the count and every matching message id. Do not change anything.",
    "For threads t1 and t2, join message ids to human-readable label names and subjects. Report every message id, its subject, and its labels. Do not change anything.",
    "Read every message in threads t1 and t2 and enumerate every message id returned by a paged Budget search. Follow every continuation, including empty pages. Report the complete sorted unique id list. Do not change anything.",
    "Read message m1's X-Review-Stage RFC header and attachment MIME metadata. Report the header value, part id, MIME type and filename. Do not change anything.",
    "Save one reply draft to message m1 with body 'Approved for review.'. Preserve the reply's thread, recipient and References. Never send mail. Report the saved draft id and thread id.",
    "Replace plain draft draft1's body with 'Updated review text.'. If the save is uncertain, read it back and report the actual saved text and draft id. Do not save it twice or send mail.",
    "Replace draft draft-inline's body with 'Do not lose attachments.'. Preserve its inline attachments. If this cannot be done safely, keep the draft unchanged and explain the limitation. Never send mail. Report its id and whether it changed.",
  ],
  drive: [
    "Find all untrashed PDF files in folder1 modified between 2026-09-30 and 2026-10-03. Report their ids and names, excluding files belonging to another Workspace account. Do not change anything.",
    "Resolve shared drive shared1 and folder1. For pdf1 report each direct and inherited permission holder, email, role and inheritance. Do not change anything.",
    "Enumerate every file in folder1 across all native and local continuations, even an empty intermediate page. Use a small response budget where supported. Report the complete sorted unique file id list. Do not change anything.",
    "Report all revision ids and modified timestamps for Drive file pdf1. Do not change anything. If unavailable, say so; do not invent revisions.",
    "Save message m1's evidence.bin attachment into Drive folder1 exactly once. Preserve every byte and application/octet-stream MIME type. Do not email or share it. Report the new file id, folder id and byte count.",
    "Rename Drive file pdf1 to 'Reviewed report.pdf'. If the update is uncertain, read the same file back before considering another write. Report its id and actual final name. Do not rename it twice.",
    "Read pdf1's permissions, then change reviewer@example.com's existing permission perm1 from reader to writer without emailing or transferring ownership. Verify the final role. Report file id, permission id and role.",
  ],
  docs: [
    "From document docs1, report all paragraphs containing Budget in tab tab1 only. Include document id, tab id and paragraph count. Do not change anything.",
    "Find the Drive document named 'docs review', then read its Review and Other tabs. Report the matching Drive/document id and both tab titles and ids. Do not change anything.",
    "Collect every indexed paragraph in docs1 tab tab1 through all content continuations using a small content budget. Report the paragraph count and every UTF-16 start/end position. Do not change anything.",
    "Inspect docs1's named range Review and its text style, then make that range bold at the revision just read, exactly once. Report document id, named range id and the edited range.",
    "Create one document titled 'Review minutes' starting with 'Meeting opened.'. Report the created document id and verified starting text. Do not create a second document.",
    "Append 'Review complete.' to docs1 tab tab1 once. If the write is uncertain, read it back and report whether the text was saved. Do not append it twice. Include the document id.",
    "Create one document titled 'Recovered minutes' with starting text 'Recovered opening.'. If creation succeeds but initial text is refused, recover using the created document id and add only the missing text. Report the id and verified text; never create another document.",
  ],
  sheets: [
    "Read sheets1 'Alice''s costs'!A1:D7 using unformatted numbers. Sum office amounts on 2026-10-01. Report spreadsheet id, record ids and numeric total. Do not change anything.",
    "Find workbook 'sheets review' through Drive, resolve named range Amounts, and join record1/record2 from Alice's costs to People. Report workbook id, named range id and both matched names. Do not change anything.",
    "Read every row of sheets1 across 'Alice''s costs'!A1:L7 and People!A1:B2, using a small cell budget and every local continuation. Report the complete cost-record ids and total amount. Do not invent a Google page token or change anything.",
    "Inspect conditional formatting and protected-range metadata in sheets1 sheet 0, then make A1:D1 bold once. Report spreadsheet id, sheet id and protection id. Preserve existing rules and protection.",
    "Append exactly one row ['external1','2026-10-02','office',77] to sheets1 Alice's costs as literal values, inserting rows rather than overwriting. Verify it and report spreadsheet id, record id and amount.",
    "Append exactly one literal row ['recover1','2026-10-02','office',88] to sheets1 Alice's costs. If uncertain, read the table and identify the saved row without appending again. Report spreadsheet id, record id and actual amount.",
    "Use a read-only data-filter or developer-metadata search to read the existing review metadata on sheets1. Report metadata id, key and value. Make no write. If this capability is unavailable, say so.",
  ],
  slides: [
    "Identify all slides in slides1 whose visible text or speaker notes contain Budget. Report presentation id and all matching slide ids. Do not change anything.",
    "Find deck 'slides review' through Drive. Join slide1 to its layout and title placeholder. Report presentation id, slide id, layout id and placeholder id. Do not change anything.",
    "Read all long speaker notes and grouped element text of slides1 using every content continuation and a small content budget. Report all slide ids and the complete count of the word review in the speaker notes. Do not change anything.",
    "Inspect text1's style and transform on slide1 in slides1, then make its text bold at the current revision once. Report presentation id, element id and the applied style.",
    "Add one slide with explicit object id review_slide at position 1 in slides1 using layout1. Verify its id, layout and position. Do not add a second slide.",
    "Replace the literal phrase 'Review slide' with 'Approved slide' in slides1 once. If uncertain, read the deck back and do not send another batch. Report presentation id and the verified replacement count.",
    "In slides1, make text1 bold and add a comment saying 'Review checked.'. Deck and comment edits may save separately. Verify both states, report which saved and which remains unconfirmed, and never replay the complete mixed edit.",
  ],
  forms: [
    "Count forms1 responses submitted strictly after 2026-10-02T12:00:00Z whose Approved? answer is yes. Read every page and report response ids and count. Do not change anything.",
    "For forms1 responses response1 and response2, join question ids to titles/options and report Approved? answers. Use question ids rather than item ids. Include response and question ids. Do not change anything.",
    "Enumerate every forms1 response through vendor and local answer continuations, including empty intermediate pages and shortened answers. Report every unique response id with no omissions or duplicates. Do not change anything.",
    "Inspect forms1 item1's correct answer, points and navigation, then rename its no option to later at the current revision once. Preserve the yes answer, grading and navigation. Report form id, question id and options.",
    "At forms1's current revision create one optional text question titled 'Reviewer' at item index 1. Report the new item and question ids. Do not add it twice.",
    "Rename forms1 to 'Reviewed form'. If the write is uncertain, read it back and report the actual title and form id. Do not repeat the update.",
    "Change forms1's title to 'Concurrent review' at the read revision. If a concurrent edit invalidates that revision, re-read the form before applying the requested change once at the new revision. Report the actual final title and id.",
  ],
};

export const GOOGLE_EXPECTED: Record<GoogleProduct, readonly unknown[]> = {
  gmail: [
    { ids: ["m1", "m3", "m5", "m7"], count: 4 },
    {
      ids: Array.from({ length: 8 }, (_, i) => `m${i + 1}`),
      messages: Array.from({ length: 8 }, (_, i) => ({
        id: `m${i + 1}`,
        subject: `Budget ${i + 1}`,
        labels: i % 2 ? ["Inbox"] : ["Inbox", "Unread"],
      })),
    },
    { ids: Array.from({ length: 100 }, (_, i) => `m${i + 1}`).sort() },
    { header: "approved", partId: "1", mimeType: "application/octet-stream", filename: "evidence.bin" },
    { id: "draft-new", threadId: "t1" },
    { id: "draft1", text: "Updated review text." },
    { id: "draft-inline", changed: false, limitation: "attachments" },
  ],
  drive: [
    { ids: Array.from({ length: 6 }, (_, i) => `pdf${i + 1}`) },
    { id: "pdf1", direct: "reviewer@example.com", inherited: ALICE, driveId: "shared1" },
    { ids: ["docs1", "forms1", ...Array.from({ length: 146 }, (_, i) => `pdf${i + 1}`), "sheets1", "slides1"].sort() },
    { revisions: ["rv1", "rv2"], modified: ["2026-10-01T12:00:00Z", "2026-10-02T12:00:00Z"] },
    { id: "upload1", folderId: "folder1", bytes: ATTACHMENT.length },
    { id: "pdf1", name: "Reviewed report.pdf" },
    { id: "pdf1", permissionId: "perm1", role: "writer" },
  ],
  docs: [
    { id: "docs1", tabId: "tab1", count: DOC_PARAGRAPHS },
    { id: "docs1", tabs: ["tab1", "tab2"], titles: ["Review", "Other"] },
    {
      id: "docs1",
      count: DOC_PARAGRAPHS,
      positions: googleState().accounts[ALICE].document.tabs[0].documentTab.body.content.map((p: Row) => [
        p.startIndex,
        p.endIndex,
      ]),
    },
    { id: "docs1", namedRangeId: "nr1", start: 1, end: 7, bold: true },
    { id: "new-doc", text: "Meeting opened." },
    { id: "docs1", text: "Review complete.", saved: true },
    { id: "new-doc", text: "Recovered opening." },
  ],
  sheets: [
    { id: "sheets1", ids: ["record1", "record3", "record5"], total: 90 },
    { id: "sheets1", namedRangeId: "nr1", names: ["Alice", "Bob"] },
    { id: "sheets1", ids: Array.from({ length: 6 }, (_, i) => `record${i + 1}`), total: 210 },
    { id: "sheets1", sheetId: 0, protectionId: 1 },
    { id: "sheets1", recordId: "external1", amount: 77 },
    { id: "sheets1", recordId: "recover1", amount: 88 },
    { id: 7, key: "review", value: "approved" },
  ],
  slides: [
    { id: "slides1", slides: ["slide1", "slide2", "slide3", "slide4"] },
    { id: "slides1", slideId: "slide1", layoutId: "layout1", placeholderId: "placeholder1" },
    { id: "slides1", slides: ["slide1", "slide2", "slide3", "slide4"], reviewCount: 1600 },
    { id: "slides1", elementId: "text1", bold: true },
    { id: "slides1", slideId: "review_slide", layoutId: "layout1", position: 1 },
    { id: "slides1", replacements: 4 },
    { id: "slides1", deck: "saved", comment: "unconfirmed" },
  ],
  forms: [
    { ids: ["response3", "response5"], count: 2 },
    {
      questionId: "q1",
      title: "Approved?",
      answers: [
        { id: "response1", value: "yes" },
        { id: "response2", value: "no" },
      ],
    },
    { ids: Array.from({ length: 6 }, (_, i) => `response${i + 1}`) },
    { id: "forms1", questionId: "q1", options: ["yes", "later"], correct: "yes", points: 1 },
    { id: "forms1", itemId: "item-new", questionId: "q-new" },
    { id: "forms1", title: "Reviewed form" },
    { id: "forms1", title: "Concurrent review" },
  ],
};

function subset(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected))
    return Array.isArray(actual) && actual.length === expected.length && expected.every((v, i) => subset(actual[i], v));
  if (expected && typeof expected === "object")
    return (
      !!actual &&
      typeof actual === "object" &&
      Object.entries(expected).every(([key, value]) => subset((actual as Row)[key], value))
    );
  return actual === expected;
}

function evidence(trace: AgentTrace): Row | undefined {
  const text = trace.finalAnswer ?? "";
  const match = /ANSWER:\s*(\{[^\n]+\})/i.exec(text);
  try {
    return JSON.parse(match?.[1] ?? "");
  } catch {
    return undefined;
  }
}

function gradeGoogle(product: GoogleProduct, task: number, world: World, trace: AgentTrace): Check[] {
  const calls = world.ledger.calls
    .filter((c) => GOOGLE_PRODUCTS.includes(c.service as GoogleProduct))
    .map((c) => ({ ...c, args: c.args as Row }));
  const source = calls.filter((c) => c.service === product && c.args.subject === ALICE);
  const writes = calls.filter((c) => c.kind === "write");
  const a = world.google.state.accounts[ALICE];
  const answer = evidence(trace);
  const out: Check[] = [];
  const add = (id: string, pass: boolean) => out.push(check(id, id.replaceAll("-", " "), pass));
  const expected = GOOGLE_EXPECTED[product][task - 1];
  const receipts: Row[] = [];
  const observed = trace.toolUses.flatMap((use) => {
    if (["call_tool", "call_destructive_tool"].includes(use.tool)) {
      try {
        const result = JSON.parse(use.resultText ?? "");
        if (result.ok) receipts.push(result.data);
      } catch {
        /* Not a complete inline result. */
      }
      return [String(use.input.address)];
    }
    if (use.tool !== "execute_code" || typeof use.input.code !== "string") return [];
    const code = use.input.code.trim();
    return world.programs
      .filter((program) => program.code === code || program.code.includes(`\n${code}\n`))
      .flatMap((program) =>
        program.calls
          .filter((call) => call.name === "connecta.call")
          .map((call) => {
            if (call.outcome === "ok") receipts.push((call.result as Row)?.data);
            return String(call.args[0]);
          }),
      );
  });
  add("answer-evidence", answer?.source === product && subset(answer, expected));
  const reads = source.filter((c) => c.kind === "read" && c.outcome === "ok");
  const requirements: RegExp[] =
    product === "gmail"
      ? task === 2
        ? [/^\/threads\/t1$/, /^\/threads\/t2$/, /^\/labels$/]
        : task === 4 || task === 5
          ? [/^\/messages\/m1$/]
          : task === 6
            ? [/^\/drafts\/draft1$/]
            : task === 7
              ? [/^\/drafts\/draft-inline$/]
              : [/^\/(?:threads|messages)(?:\/[^/]+)?$/]
      : product === "drive"
        ? task === 1 || task === 3
          ? [/^\/files$/]
          : task === 2
            ? [/^\/files\/folder1$/, /^\/files\/pdf1\/permissions$/]
            : task === 4
              ? [/^\/files\/pdf1\/revisions$/]
              : task === 6
                ? [/^\/files\/pdf1$/]
                : task === 7
                  ? [/^\/files\/pdf1\/permissions$/]
                  : []
        : product === "docs"
          ? [task === 5 || task === 7 ? /^\/documents\/new-doc$/ : /^\/documents\/docs1$/]
          : product === "sheets"
            ? task === 2
              ? [/^\/spreadsheets\/sheets1$/, /\/values/]
              : task === 4
                ? [/^\/spreadsheets\/sheets1$/]
                : task === 7
                  ? [/developerMetadata:search$|:getByDataFilter$|:batchGetByDataFilter$/]
                  : [/\/values/]
            : product === "slides"
              ? task === 4 || task === 7
                ? [/^\/presentations\/slides1(?:\/pages\/slide1)?$/]
                : [/^\/presentations\/slides1$/]
              : task === 1 || task === 3
                ? [/^\/forms\/forms1\/responses$/]
                : task === 2
                  ? [/^\/forms\/forms1$/, /^\/forms\/forms1\/responses(?:\/response[12])?$/]
                  : [/^\/forms\/forms1$/];
  add(
    "correct-destination",
    source.length > 0 &&
      requirements.every((pattern) => reads.some((c) => pattern.test(c.args.path))) &&
      observed.some((address) => address.startsWith(`${product}.`)) &&
      calls.every((c) => c.args.subject === ALICE),
  );
  if (product === "forms" && task === 2) {
    const returned = JSON.stringify(reads.map((call) => call.args.returned));
    const destination = out.find((item) => item.id === "correct-destination")!;
    destination.pass =
      destination.pass && ["response1", "response2"].every((id) => returned.includes(JSON.stringify(id)));
  }
  const readOnly =
    task < 4 ||
    (task === 4 && ["gmail", "drive"].includes(product)) ||
    (task === 7 && ["gmail", "sheets"].includes(product));
  if (readOnly) add("reads-only", writes.length === 0 && a.mutations.length === 0);
  else {
    const expectedPath =
      product === "gmail"
        ? task === 5
          ? "/drafts"
          : "/drafts/draft1"
        : product === "drive"
          ? task === 5
            ? "/files"
            : task === 7
              ? "/files/pdf1/permissions/perm1"
              : "/files/pdf1"
          : product === "docs"
            ? task === 5 || task === 7
              ? "/documents"
              : "/documents/docs1:batchUpdate"
            : product === "sheets"
              ? task === 4
                ? "/spreadsheets/sheets1:batchUpdate"
                : "/spreadsheets/sheets1/values/'Alice''s costs'!A:D:append"
              : product === "slides"
                ? "/presentations/slides1:batchUpdate"
                : "/forms/forms1:batchUpdate";
    const allowed = writes.every(
      (c) =>
        c.service === product &&
        (c.args.path === expectedPath ||
          (product === "docs" && [5, 7].includes(task) && c.args.path === "/documents/new-doc:batchUpdate")),
    );
    const batchKinds =
      product === "docs"
        ? task === 4
          ? ["updateTextStyle"]
          : ["insertText"]
        : product === "sheets"
          ? ["repeatCell"]
          : product === "slides"
            ? task === 5
              ? ["createSlide"]
              : task === 6
                ? ["replaceAllText"]
                : task === 7
                  ? ["updateTextStyle", "insertComment"]
                  : ["updateTextStyle"]
            : product === "forms"
              ? task === 4
                ? ["updateItem"]
                : task === 5
                  ? ["createItem"]
                  : ["updateFormInfo"]
              : [];
    const authorized = writes.every((c) => {
      if (Array.isArray(c.args.body?.requests))
        return (
          c.args.body.requests.length === batchKinds.length &&
          c.args.body.requests.every(
            (request: Row) => Object.keys(request).length === 1 && batchKinds.includes(Object.keys(request)[0]!),
          )
        );
      if (product === "drive")
        return Object.keys(c.args.body ?? {}).every((key) =>
          (task === 6 ? ["name"] : task === 7 ? ["role"] : ["name", "parents", "mimeType"]).includes(key),
        );
      if (product === "sheets")
        return (
          JSON.stringify(c.args.body?.values) ===
          JSON.stringify([[task === 5 ? "external1" : "recover1", "2026-10-02", "office", task === 5 ? 77 : 88]])
        );
      return true;
    });
    add("only-requested-writes", allowed && authorized);
    const count =
      product === "docs" && task === 5
        ? 2
        : product === "docs" && task === 7
          ? 3
          : product === "forms" && task === 7
            ? 2
            : 1;
    add(
      "once",
      writes.length === count &&
        a.mutations.filter((m) => m.product === product).length ===
          ((product === "forms" && task === 7) || (product === "docs" && task === 7) ? count - 1 : count),
    );
    let state = writes.length > 0;
    if (product === "gmail")
      state =
        task === 5
          ? a.drafts.some((d) => d.id === "draft-new" && d.message.threadId === "t1") &&
            /References:.*root@example.com/.test(
              Buffer.from(writes[0]?.args.body?.message?.raw ?? "", "base64url").toString(),
            )
          : Buffer.from(a.drafts[0]?.message.payload?.body?.data ?? "", "base64url")
              .toString()
              .includes("Updated review text.");
    if (product === "drive")
      state =
        task === 6
          ? a.files.find((f) => f.id === "pdf1")?.name === "Reviewed report.pdf"
          : task === 7
            ? a.permissions[0]?.role === "writer" &&
              writes.every(
                (c) =>
                  c.args.query.sendNotificationEmail !== "true" &&
                  !c.args.query.transferOwnership &&
                  c.args.body.role !== "owner",
              )
            : a.created.length === 1 &&
              a.uploads.length === 1 &&
              a.uploads[0]?.base64 === ATTACHMENT.toString("base64");
    if (product === "docs")
      state = [5, 7].includes(task)
        ? a.created.length === 1 &&
          JSON.stringify(a.created).includes(task === 5 ? "Meeting opened." : "Recovered opening.")
        : task === 6
          ? JSON.stringify(a.document).split("Review complete.").length === 2
          : a.document.tabs[0].documentTab.body.content[0].paragraph.elements[0].textRun.textStyle.bold === true;
    if (product === "sheets")
      state =
        task === 4
          ? a.spreadsheet.sheets[0].data?.[0].rowData?.[0].values?.every(
              (cell: Row) => cell.userEnteredFormat.textFormat.bold === true,
            ) === true && a.spreadsheet.sheets[0].protectedRanges[0].protectedRangeId === 1
          : a.values.filter((r) => r[0] === (task === 5 ? "external1" : "recover1") && r[3] === (task === 5 ? 77 : 88))
              .length === 1 &&
            writes[0]?.args.query.valueInputOption === "RAW" &&
            writes[0]?.args.query.insertDataOption === "INSERT_ROWS";
    if (product === "slides")
      state =
        task === 5
          ? a.presentation.slides.filter((s: Row) => s.objectId === "review_slide").length === 1 &&
            a.presentation.slides[1]?.objectId === "review_slide"
          : task === 6
            ? JSON.stringify(a.presentation).includes("Approved slide") &&
              !JSON.stringify(a.presentation).includes("Review slide")
            : a.presentation.slides[0].pageElements[0].shape.text.textElements[0].textRun.style.bold === true;
    if (product === "forms")
      state =
        task === 6 || task === 7
          ? a.form.info.title === (task === 6 ? "Reviewed form" : "Concurrent review")
          : task === 5
            ? a.form.items.filter((i: Row) => i.itemId === "item-new").length === 1
            : JSON.stringify(a.form.items[0]).includes("later") &&
              JSON.stringify(a.form.items[0]).includes("SUBMIT_FORM") &&
              JSON.stringify(a.form.items[0]).includes("correctAnswers");
    add("state", state);
    if (task === 6) {
      const write = writes[0];
      add(
        "reconciled",
        !!write &&
          write.outcome === "fault" &&
          source.some(
            (c) =>
              c.seq > write.seq &&
              c.kind === "read" &&
              c.outcome === "ok" &&
              (product === "sheets"
                ? /^\/spreadsheets\/sheets1(?:\/|:|$)/.test(c.args.path) &&
                  JSON.stringify(c.args.returned).includes('"recover1"')
                : c.args.path === write.args.path.replace(/:batchUpdate$/, "")),
          ),
      );
    }
    if (product === "forms" && task === 7)
      add(
        "fresh-revision",
        writes[0]?.outcome === "tool_error" &&
          source.some((c) => c.kind === "read" && c.seq > writes[0]!.seq && c.seq < writes[1]!.seq) &&
          writes[1]?.args.body.writeControl.requiredRevisionId === "r2",
      );
  }
  const requiredIds = (expected as Row)?.ids as string[] | undefined;
  if (requiredIds) {
    const returned = JSON.stringify(source.map((c) => c.args.returned));
    add(
      "complete-evidence",
      requiredIds.every((id) => returned.includes(JSON.stringify(id))),
    );
  }
  if (task === 3) {
    const vendorComplete = source
      .filter((call) => call.kind === "read")
      .every((call) => {
        const token = call.args.returned?.nextPageToken;
        return (
          !token ||
          source.some(
            (next) => next.seq > call.seq && next.args.path === call.args.path && next.args.query.pageToken === token,
          )
        );
      });
    const completeReply = receipts.some(
      (reply) =>
        reply?.page?.hasMore === false ||
        (reply?.status === 200 &&
          ((product === "docs" && Array.isArray(reply.data?.tabs)) ||
            (product === "sheets" && Array.isArray(reply.data?.valueRanges)) ||
            (product === "slides" && Array.isArray(reply.data?.slides)))),
    );
    add("full-pages", vendorComplete && (source.filter((call) => call.kind === "read").length > 1 || completeReply));
  }
  if (task === 2 && ["docs", "sheets", "slides"].includes(product))
    add(
      "joined",
      calls.some((c) => c.service === "drive" && c.args.path === "/files"),
    );
  if (product === "drive" && task === 4)
    add(
      "revisions",
      source.some((c) => c.args.path === "/files/pdf1/revisions"),
    );
  if (product === "sheets" && task === 7)
    add(
      "read-post",
      source.some((c) => c.args.method === "POST" && c.kind === "read"),
    );
  if (product === "gmail" && task === 7)
    add(
      "attachments-preserved",
      a.drafts.some(
        (d) => d.id === "draft-inline" && d.message.payload.parts?.some((p: Row) => p.body.attachmentId === "a1"),
      ),
    );
  out.push({
    ...check(
      "hatch-diagnostic",
      "Observed operation search/details/read/write usage",
      observed.some((address) => /_api_(?:search|details|read|write)$/.test(address)),
    ),
    advisory: true,
  });
  return out;
}

function data(result: Awaited<ReturnType<ReferenceContext["call"]>>): Row {
  let value: any = result.structured;
  if (!value) {
    try {
      value = JSON.parse(result.text);
    } catch {
      return {};
    }
  }
  // Outer Connecta direct result, then the provider's result. Hatch has an
  // additional status/data envelope; its page remains next to that data.
  return value?.data ?? value?.result ?? value ?? {};
}

async function reference(product: GoogleProduct, task: number, ctx: ReferenceContext) {
  const read = async (tool: string, args: Row = {}) => {
    const r = await ctx.call("execute_code", {
      code: `async () => {
      const {data:value}=await connecta.call(${JSON.stringify(product)} + "." + ${JSON.stringify(tool)},${JSON.stringify(args)});
      if(JSON.stringify(value).length<12000)return value;
      return {page:value.page,revisionId:value.revisionId,namedRanges:value.namedRanges,
        records:(value.items??value.files??value.messages??value.responses??value.slides??[]).map(row=>({id:row.id??row.responseId??row.objectId})),
        tabs:(value.tabs??[]).map(tab=>({tabId:tab.tabId,title:tab.title,elements:tab.elements?.map(e=>({startIndex:e.startIndex,endIndex:e.endIndex})),budgetParagraphs:(tab.text?.match(/Budget paragraph/g)??[]).length}))};
    }`,
    });
    if (r.isError) throw new Error(`${product}.${tool}: ${r.text}`);
    return data(r);
  };
  const write = async (tool: string, args: Row = {}) =>
    ctx.call("call_destructive_tool", { address: `${product}.${tool}`, args, resultMode: "value" });
  const page = async (tool: string, args: Row) => {
    let cursor: unknown;
    for (let i = 0; i < 80; i++) {
      const result = await read(tool, { ...args, ...(cursor ? { cursor } : {}) });
      cursor = result.page?.nextCursor ?? result.nextCursor;
      if (!cursor) return;
    }
    throw new Error("Google reference did not terminate");
  };
  const joinDrive = async () => {
    const r = await ctx.call("call_tool", {
      address: "drive.search_files",
      args: { query: `name = '${product} review'` },
      resultMode: "value",
    });
    if (r.isError) throw new Error(r.text);
  };
  if (product === "gmail") {
    if (task === 1 || task === 3) {
      await page("search_threads", {
        query:
          task === 1
            ? "from:alice@example.com is:unread subject:Budget after:2026/09/30 before:2026/10/03"
            : "subject:Budget",
        limit: 1,
      });
      for (const threadId of ["t1", "t2"]) await page("get_thread", { threadId, maxBodyChars: 3000 });
    }
    if (task === 2) {
      await read("list_labels");
      for (const threadId of ["t1", "t2"]) await read("get_thread", { threadId });
    }
    if (task === 4) await read("get_message", { messageId: "m1", raw: true });
    if (task === 5) await write("create_draft", { replyToMessageId: "m1", body: "Approved for review." });
    if (task === 6) {
      await write("update_draft", { draftId: "draft1", body: "Updated review text." });
      await read("get_draft", { draftId: "draft1" });
    }
    if (task === 7) {
      const result = await write("update_draft", { draftId: "draft-inline", body: "Do not lose attachments." });
      if (!result.isError) throw new Error("Attachment guard did not refuse");
      await read("get_draft", { draftId: "draft-inline" });
    }
  }
  if (product === "drive") {
    if (task === 1 || task === 3)
      await page("search_files", {
        query:
          task === 1
            ? "'folder1' in parents and trashed = false and mimeType = 'application/pdf' and modifiedTime > '2026-09-30T00:00:00Z' and modifiedTime < '2026-10-03T00:00:00Z'"
            : "'folder1' in parents",
        limit: task === 3 ? 100 : 2,
        ...(task === 3 ? { maxBytes: 65536 } : {}),
      });
    if (task === 2) {
      await read("list_shared_drives");
      await read("get_file", { fileId: "folder1" });
      await page("list_permissions", { fileId: "pdf1" });
    }
    if (task === 4) {
      const r = await ctx.call("call_tool", {
        address: "drive.drive_api_read",
        args: { path: "/files/pdf1/revisions" },
        resultMode: "value",
      });
      if (r.isError) {
        ctx.answer('ANSWER: {"source":"drive","unavailable":true}');
        return;
      }
    }
    if (task === 5) {
      const r = await ctx.call("call_tool", {
        address: "gmail.get_attachment",
        args: { messageId: "m1", partId: "1" },
        resultMode: "value",
      });
      if (r.isError) throw new Error(r.text);
      await write("create_file", {
        name: "evidence.bin",
        parentId: "folder1",
        mimeType: "application/octet-stream",
        contentBase64: ATTACHMENT.toString("base64"),
      });
    }
    if (task === 6) {
      await write("update_file", { fileId: "pdf1", name: "Reviewed report.pdf" });
      await read("get_file", { fileId: "pdf1" });
    }
    if (task === 7) {
      await read("list_permissions", { fileId: "pdf1" });
      await write("update_permission", { fileId: "pdf1", permissionId: "perm1", role: "writer" });
      await read("list_permissions", { fileId: "pdf1" });
    }
  }
  if (product === "docs") {
    if (task === 2) await joinDrive();
    if (task < 4)
      await page("get_document", {
        documentId: "docs1",
        ...(task === 2 ? {} : { tabId: "tab1" }),
        ...(task === 3 ? { withIndexes: true, maxChars: 0 } : { maxChars: 200000 }),
      });
    if (task === 4) {
      await read("get_document", { documentId: "docs1", raw: true });
      await write("batch_update_document", {
        documentId: "docs1",
        requiredRevisionId: "r1",
        requests: [
          {
            updateTextStyle: {
              range: { tabId: "tab1", startIndex: 1, endIndex: 7 },
              textStyle: { bold: true },
              fields: "bold",
            },
          },
        ],
      });
    }
    if (task === 5 || task === 7) {
      await write("create_document", {
        title: task === 5 ? "Review minutes" : "Recovered minutes",
        text: task === 5 ? "Meeting opened." : "Recovered opening.",
      });
      if (task === 7) await write("append_text", { documentId: "new-doc", text: "Recovered opening." });
      await read("get_document", { documentId: "new-doc" });
    }
    if (task === 6) {
      await write("append_text", { documentId: "docs1", tabId: "tab1", text: "Review complete." });
      await read("get_document", { documentId: "docs1", tabId: "tab1" });
    }
  }
  if (product === "sheets") {
    if (task === 2) await joinDrive();
    if (task === 1 || task === 3)
      await page("get_values", {
        spreadsheetId: "sheets1",
        ranges: [
          task === 3 ? "'Alice''s costs'!A1:L7" : "'Alice''s costs'!A1:D7",
          ...(task === 3 ? ["People!A1:B2"] : []),
        ],
        valueRenderOption: "UNFORMATTED_VALUE",
        ...(task === 3 ? { maxCells: 16 } : {}),
      });
    if (task === 2) {
      await read("get_spreadsheet", { spreadsheetId: "sheets1" });
      await read("get_values", { spreadsheetId: "sheets1", ranges: ["Amounts", "People!A1:B2"] });
    }
    if (task === 4) {
      await read("get_spreadsheet", { spreadsheetId: "sheets1", raw: true });
      await write("batch_update_spreadsheet", {
        spreadsheetId: "sheets1",
        requests: [
          {
            repeatCell: {
              range: { sheetId: 0, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 4 },
              cell: { userEnteredFormat: { textFormat: { bold: true } } },
              fields: "userEnteredFormat.textFormat.bold",
            },
          },
        ],
      });
    }
    if (task === 5 || task === 6) {
      await write("append_values", {
        spreadsheetId: "sheets1",
        range: "'Alice''s costs'!A:D",
        values: [[task === 5 ? "external1" : "recover1", "2026-10-02", "office", task === 5 ? 77 : 88]],
        valueInputOption: "RAW",
      });
      await read("get_values", { spreadsheetId: "sheets1", ranges: ["'Alice''s costs'!A1:D8"] });
    }
    if (task === 7) {
      const r = await ctx.call("call_tool", {
        address: "sheets.sheets_api_read",
        args: {
          method: "POST",
          path: "/spreadsheets/sheets1/developerMetadata:search",
          body: { dataFilters: [{ developerMetadataLookup: { metadataKey: "review" } }] },
        },
        resultMode: "value",
      });
      if (r.isError) {
        ctx.answer('ANSWER: {"source":"sheets","unavailable":true}');
        return;
      }
    }
  }
  if (product === "slides") {
    if (task === 2) await joinDrive();
    if (task < 4) {
      await page("get_presentation", {
        presentationId: "slides1",
        ...(task === 3 ? { maxCharsPerSlide: 1000, limit: 1 } : {}),
      });
      if (task === 2) await read("list_layouts", { presentationId: "slides1" });
      if (task === 3)
        for (let n = 1; n <= 4; n++)
          await page("get_page", { presentationId: "slides1", pageObjectId: `notes${n}`, limit: 1 });
    }
    if (task === 4 || task === 7) {
      // Reference routing only: retain the legacy BEFORE read and use the
      // structural hatch when the AFTER catalog advertises it.
      const catalog = await ctx.call("search_tools", {
        connector: "slides",
        query: "slides_api_read",
        limit: 8,
      });
      const indexed = (data(catalog).tools ?? []).some(
        (tool: Row) => tool.address === "slides.slides_api_read" || tool.name === "slides_api_read",
      );
      if (indexed) await read("slides_api_read", { path: "/presentations/slides1/pages/slide1" });
      else await read("get_page", { presentationId: "slides1", pageObjectId: "slide1", raw: true });
      await write("batch_update_presentation", {
        presentationId: "slides1",
        requiredRevisionId: "r1",
        requests: [
          { updateTextStyle: { objectId: "text1", textRange: { type: "ALL" }, style: { bold: true }, fields: "bold" } },
          ...(task === 7 ? [{ insertComment: { objectId: "text1", content: "Review checked." } }] : []),
        ],
      });
      await read("get_presentation", { presentationId: "slides1" });
      if (task === 7) await read("list_comments", { presentationId: "slides1" });
    }
    if (task === 5) {
      await write("batch_update_presentation", {
        presentationId: "slides1",
        requiredRevisionId: "r1",
        requests: [
          {
            createSlide: { objectId: "review_slide", insertionIndex: 1, slideLayoutReference: { layoutId: "layout1" } },
          },
        ],
      });
      await read("get_presentation", { presentationId: "slides1" });
    }
    if (task === 6) {
      await write("replace_all_text", {
        presentationId: "slides1",
        replacements: [{ find: "Review slide", replace: "Approved slide" }],
      });
      await read("get_presentation", { presentationId: "slides1" });
    }
  }
  if (product === "forms") {
    if (task === 1 || task === 3)
      await page("list_responses", {
        formId: "forms1",
        ...(task === 1 ? { submittedAfter: "2026-10-02T12:00:00Z" } : {}),
        limit: 2,
      });
    if (task === 2) {
      await read("get_form", { formId: "forms1" });
      for (const responseId of ["response1", "response2"]) await read("get_response", { formId: "forms1", responseId });
    }
    if (task === 4) {
      const form = await read("get_form", { formId: "forms1", raw: true });
      const item = structuredClone(form.items[0]) as Row;
      item.questionItem.question.choiceQuestion.options[1].value = "later";
      await write("batch_update_form", {
        formId: "forms1",
        requiredRevisionId: "r1",
        requests: [
          { updateItem: { item, location: { index: 0 }, updateMask: "questionItem.question.choiceQuestion.options" } },
        ],
      });
    }
    if (task === 5) {
      await read("get_form", { formId: "forms1" });
      await write("batch_update_form", {
        formId: "forms1",
        requiredRevisionId: "r1",
        requests: [
          {
            createItem: {
              item: { title: "Reviewer", questionItem: { question: { required: false, textQuestion: {} } } },
              location: { index: 1 },
            },
          },
        ],
      });
    }
    if (task === 6 || task === 7) {
      await read("get_form", { formId: "forms1" });
      await write("update_form_info", {
        formId: "forms1",
        title: task === 6 ? "Reviewed form" : "Concurrent review",
        requiredRevisionId: "r1",
      });
      await read("get_form", { formId: "forms1" });
      if (task === 7)
        await write("update_form_info", { formId: "forms1", title: "Concurrent review", requiredRevisionId: "r2" });
    }
  }
  ctx.answer(`ANSWER: ${JSON.stringify({ source: product, ...(GOOGLE_EXPECTED[product][task - 1] as Row) })}`);
}

export const GOOGLE_TASKS: ActiveTask[] = GOOGLE_PRODUCTS.flatMap((product) =>
  goals[product].map((goal, i) => ({
    status: "active",
    id: `google-${product}-${i + 1}`,
    title: `${product} ${i + 1}: ${["filtered read", "identity join", "complete paging", "rare contract", "write once", "recovery", "held-out boundary"][i]}`,
    introducedIn: "#703",
    measures: goal,
    prompt: `${goal} Cite the source. End with ANSWER: followed by one JSON object containing source "${product}" and the requested facts. Use these JSON keys: ${Object.keys(GOOGLE_EXPECTED[product][i] as Row).join(", ")}.`,
    world: { google: { product, task: i + 1 } },
    ...(i < 3 || (i === 3 && ["gmail", "drive"].includes(product)) || (i === 6 && product === "sheets")
      ? { deployment: { readOnly: true } }
      : {}),
    grade: ({ world, trace }) => gradeGoogle(product, i + 1, world, trace),
    reference: (ctx) => reference(product, i + 1, ctx),
  })),
);

export const GOOGLE_COVERAGE_GAPS = ["google-drive-4", "google-sheets-7"] as const;
