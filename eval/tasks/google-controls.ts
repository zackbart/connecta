/** Deterministic identity and transport controls; no model or Workspace network. */
import { World } from "../fakes/world.js";
import { ALICE, BOB } from "../fakes/google.js";
import type { GoogleOptions } from "../fakes/google.js";
import { startNodeDeployment } from "../deploy/node.js";
import { connectMcp } from "../support/mcp.js";

function delivered<T>(result: { structured: unknown; text: string }): T {
  const envelope = (result.structured ?? JSON.parse(result.text)) as { data?: T; result?: T };
  return (envelope.data ?? envelope.result ?? envelope) as T;
}

export async function googleTransportControls(): Promise<void> {
  const world = new World({ google: { product: "forms", task: 1 } });
  await world.start();
  const specs = world.connectorSpecs();
  specs.push({
    ...specs.find((s) => s.id === "forms")!,
    id: "forms_fixed",
    google: { ...specs.find((s) => s.id === "forms")!.google!, subject: "fixed" },
  });
  world.google.state.accounts[BOB].form.info.title = "Bob private form";
  const deployment = await startNodeDeployment(specs, {
    pools: {
      bob: { owner: BOB, members: ["agent:eval-machine"], tools: ["forms"] },
      ownerless: { members: ["agent:eval-machine"], tools: ["forms", "forms_fixed"] },
      readonly: { owner: ALICE, readOnly: true, members: ["agent:eval-machine"], tools: ["forms"] },
      native: { owner: ALICE, surface: "native", executeCode: true, members: ["agent:eval-machine"], tools: ["forms"] },
    },
  });
  const sessions: Awaited<ReturnType<typeof connectMcp>>[] = [];
  const session = async (pool: string) => {
    const result = await connectMcp(`${deployment.origin}/agent/${pool}`, {
      Authorization: `Bearer ${deployment.token}`,
    });
    sessions.push(result);
    return result;
  };
  try {
    const ownerless = await session("ownerless");
    const before = world.ledger.calls.length,
      mints = world.google.state.mints.length;
    const refused = await ownerless.call("call_tool", { address: "forms.get_form", args: { formId: "forms1" } });
    if (!refused.isError || world.ledger.calls.length !== before || world.google.state.mints.length !== mints)
      throw new Error("Ownerless Google mapping performed I/O");
    const fixed = await ownerless.call("call_tool", { address: "forms_fixed.get_form", args: { formId: "forms1" } });
    if (fixed.isError || world.ledger.calls.at(-1)?.args.subject !== ALICE)
      throw new Error(`Fixed subject lost its deployment identity: ${fixed.text}`);
    const bob = await session("bob");
    const read = await bob.call("call_tool", { address: "forms.get_form", args: { formId: "forms1" } });
    if (read.isError || !read.text.includes("Bob private form") || world.ledger.calls.at(-1)?.args.subject !== BOB)
      throw new Error("Google owner-bound pool crossed subjects");
    const readonly = await session("readonly");
    const count = world.ledger.calls.length;
    const denied = await readonly.call("call_destructive_tool", {
      address: "forms.update_form_info",
      args: { formId: "forms1", title: "Forbidden" },
    });
    if (!denied.isError || world.ledger.calls.length !== count)
      throw new Error("Read-only Google write reached the fake");
    const native = await session("native");
    const catalog = await native.listTools();
    if (!catalog.some((t) => t.name === "forms__get_form"))
      throw new Error("Google native catalog is missing its read");
    const nativeRead = await native.call("forms__get_form", { formId: "forms1" });
    if (nativeRead.isError || world.ledger.calls.at(-1)?.args.subject !== ALICE)
      throw new Error("Google native read crossed identity");
    for (const [url, authorization] of [
      ["https://forms.googleapis.com/v1/forms/forms1", "Bearer unregistered"],
      ["https://docs.googleapis.com/v1/documents/docs1", "Bearer unregistered"],
    ]) {
      let rejected = false;
      try {
        await fetch(url!, { headers: { Authorization: authorization! } });
      } catch {
        rejected = true;
      }
      if (!rejected) throw new Error("Unregistered Google credential escaped the fake transport");
    }
    if (
      !world.google.state.mints.some((mint) => mint.subject === BOB) ||
      !world.google.state.mints.some((mint) => mint.subject === ALICE)
    )
      throw new Error("Google JWT delegation evidence is missing");
    if (world.ledger.calls.some((c) => c.kind === "write"))
      throw new Error("Identity controls performed a business mutation");
  } finally {
    await Promise.allSettled(sessions.map((s) => s.close()));
    await deployment.close();
    await world.stop();
  }
}

export async function googleBoundaryControls(): Promise<void> {
  for (const [product, boundary, tool, args] of [
    ["docs", "split", "docs_api_read", { path: "/documents/docs1", query: { includeTabsContent: true } }],
    ["gmail", "base64", "get_message", { messageId: "m1" }],
    ["drive", "binary", "get_file_content", { fileId: "pdf1" }],
    ["forms", "cursor", "list_responses", { formId: "forms1", limit: 2 }],
    ["drive", "decision", "get_file", { fileId: "pdf1" }],
  ] as const) {
    const world = new World({ google: { product, task: 1, boundary } as GoogleOptions });
    await world.start();
    const deployment = await startNodeDeployment(world.connectorSpecs());
    const session = await connectMcp(deployment.mcpUrl, { Authorization: `Bearer ${deployment.token}` });
    try {
      const result = await session.call("call_tool", { address: `${product}.${tool}`, args, resultMode: "value" });
      const tokens = world.google.boundaryTokens;
      if (!tokens.length) throw new Error(`Google ${boundary} fixture did not dispatch`);
      for (const token of tokens)
        for (let i = 0; i + 8 <= token.length; i++)
          if (result.text.includes(token.slice(i, i + 8)))
            throw new Error(`Google ${boundary} exposed a credential fragment`);
      if (["split", "base64", "decision"].includes(boundary) && !result.text.includes("[redacted]"))
        throw new Error(`Google ${boundary} did not exercise redaction`);
      const value = delivered<{ content?: string; page?: { nextCursor?: string } }>(result);
      const cursor = value?.page?.nextCursor;
      if (cursor)
        for (const token of tokens)
          for (let i = 0; i + 8 <= token.length; i++)
            if (
              Buffer.from(cursor, "base64url")
                .toString()
                .includes(token.slice(i, i + 8))
            )
              throw new Error("Google cursor contains a credential fragment");
      if (
        boundary === "binary" &&
        !result.isError &&
        value?.content !== "" &&
        Buffer.from(value?.content ?? "", "base64").toString() !== "[redacted]" &&
        !/redacted|unavailable|withheld/.test(result.text)
      )
        throw new Error("Google binary echo was not wholly withheld");
      if (world.ledger.calls.some((c) => c.kind === "write")) throw new Error("Google privacy fixture mutated data");
    } finally {
      await session.close();
      await deployment.close();
      await world.stop();
    }
  }

  // An out-of-band reorder must invalidate a local positional continuation;
  // a vendor's legitimately empty collection must still be a terminal page.
  const world = new World({ google: { product: "forms", task: 1 } });
  await world.start();
  const account = world.google.state.accounts[ALICE];
  const fakeRead = async (url: URL | string, scope: string) =>
    (
      await world.google.handle(new Request(url), ALICE, [`https://www.googleapis.com/auth/${scope}`])
    ).json() as Promise<Record<string, any>>;
  for (const [fields, grid, metadata] of [
    ["developerMetadata", false, true],
    ["sheets/dataValidation", false, false],
    ["sheets.dataValidation", false, false],
    ["sheets.properties(sheetId,title)", false, false],
    ["sheets(properties,data(rowData))", true, false],
    ["sheets/data/rowData", true, false],
    ["sheets.data.rowData", true, false],
    ["sheets.data(rowData)", true, false],
    ["sheets.properties,developerMetadata", false, true],
  ] as const) {
    const url = new URL("https://sheets.googleapis.com/v4/spreadsheets/sheets1");
    url.searchParams.set("fields", fields);
    const result = await fakeRead(url, "spreadsheets");
    if (!!result.sheets[0].data !== grid) throw new Error(`Google fake misread field mask ${fields}`);
    if (Array.isArray(result.developerMetadata) !== metadata)
      throw new Error(`Google fake exposed unselected metadata for ${fields}`);
  }
  for (const fields of ["id,permissions", "permissions.role", "permissions(emailAddress)"]) {
    const url = new URL("https://www.googleapis.com/drive/v3/files/pdf1");
    url.searchParams.set("fields", fields);
    const file = await fakeRead(url, "drive");
    if (file.id !== "pdf1" || file.permissions?.length !== 2)
      throw new Error("Google fake omitted selected file permissions");
  }
  const grid = await fakeRead(
    "https://sheets.googleapis.com/v4/spreadsheets/sheets1?includeGridData=true",
    "spreadsheets",
  );
  if (grid.sheets[1]?.data?.[0]?.rowData?.[1]?.values?.[1]?.userEnteredValue?.stringValue !== "Bob")
    throw new Error("Google fake omitted People grid data");
  for (const [range, sheetId] of [
    ["'People'", 1],
    ["'Alice''s costs'", 0],
  ] as const) {
    const url = new URL("https://sheets.googleapis.com/v4/spreadsheets/sheets1?includeGridData=true");
    url.searchParams.set("ranges", range);
    const selected = await fakeRead(url, "spreadsheets");
    if (selected.sheets.length !== 1 || selected.sheets[0].properties.sheetId !== sheetId)
      throw new Error(`Google fake ignored quoted sheet-only range ${range}`);
  }
  const selectedGrid = await fakeRead(
    "https://sheets.googleapis.com/v4/spreadsheets/sheets1?includeGridData=true&ranges=People!B2:B2",
    "spreadsheets",
  );
  if (
    selectedGrid.sheets.length !== 1 ||
    selectedGrid.sheets[0].properties.sheetId !== 1 ||
    selectedGrid.sheets[0].data[0].startRow !== 1 ||
    selectedGrid.sheets[0].data[0].startColumn !== 1 ||
    selectedGrid.sheets[0].data[0].rowData[0].values[0].userEnteredValue.stringValue !== "Bob"
  )
    throw new Error("Google fake ignored the selected sheet/grid range");
  const layout = await fakeRead(
    "https://slides.googleapis.com/v1/presentations/slides1/pages/layout1",
    "presentations",
  );
  if (layout.objectId !== "layout1" || layout.pageElements?.[0]?.objectId !== "placeholder1")
    throw new Error("Google fake omitted the layout page join");
  const item = structuredClone(account.form.items[0]);
  account.form.items = Array.from({ length: 800 }, (_, i) => {
    const copy = structuredClone(item);
    copy.itemId = `reorder-${i}`;
    copy.questionItem.question.questionId = `q-reorder-${i}`;
    copy.title = `Review ${i} ${"x".repeat(300)}`;
    copy.description = "y".repeat(1000);
    return copy;
  });
  const deployment = await startNodeDeployment(world.connectorSpecs());
  const session = await connectMcp(deployment.mcpUrl, { Authorization: `Bearer ${deployment.token}` });
  try {
    const args = { formId: "forms1" };
    const first = await session.call("execute_code", {
      code: 'async () => { const {data}=await connecta.call("forms.get_form",{formId:"forms1"}); return data.page; }',
    });
    const cursor = delivered<{ nextCursor?: string }>(first).nextCursor;
    if (first.isError || !cursor)
      throw new Error(`Google reorder control did not obtain a local cursor: ${first.text}`);
    account.form.items.reverse();
    account.form.revisionId = "revision-reordered";
    const continued = await session.call("call_tool", {
      address: "forms.get_form",
      args: { ...args, cursor },
      resultMode: "value",
    });
    if (!continued.isError || !/conflict/.test(continued.text))
      throw new Error("Google reordered content accepted a stale positional cursor");
    account.responses = [];
    const empty = await session.call("call_tool", {
      address: "forms.list_responses",
      args: { formId: "forms1" },
      resultMode: "value",
    });
    const data = delivered<{
      items?: unknown[];
      responses?: unknown[];
      page?: { hasMore?: boolean; nextCursor?: unknown };
    }>(empty);
    const rows = data?.items ?? data?.responses;
    const terminal =
      data?.items !== undefined
        ? data.responses === undefined && data.page?.hasMore === false && data.page?.nextCursor === undefined
        : data.page?.nextCursor === null;
    if (empty.isError || !Array.isArray(rows) || rows.length !== 0 || !terminal)
      throw new Error(`Google empty collection did not terminate: ${empty.text}`);
    if (world.ledger.calls.some((call) => call.kind === "write"))
      throw new Error("Google content controls dispatched a mutation");
  } finally {
    await session.close();
    await deployment.close();
    await world.stop();
  }
}
