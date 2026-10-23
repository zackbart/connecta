// The Google Forms connection. Request and result shapes are pinned by
// test/goldens/forms; delegation, subjects, and tokens are
// test/google-workspace-delegation.test.ts. This suite keeps what neither
// reaches: refusals, cuts, declared keys, result bounds, and cursors.
import { Validator } from "@cfworker/json-schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forms } from "./index.js";
import { configureGuardedTransport } from "../../guarded-transport.js";
import { jsonBytes, RESULT_BUDGET_BYTES } from "../_shared/google/result-size.js";
import { memoryStorage } from "../../storage/memory.js";
import { silentLogger } from "../../../test/helpers.js";
import type { Connector, ConnectorContext } from "../../types.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";

const keys = (await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
)) as CryptoKeyPair;
const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", keys.privateKey)) as ArrayBuffer);
const PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----`;

interface ApiCall {
  url: URL;
  method: string;
  body: any;
}

type Route = (call: ApiCall) => { status?: number; body?: unknown } | undefined;

const calls: ApiCall[] = [];
let route: Route = () => undefined;
const realFetch = globalThis.fetch;

beforeEach(() => {
  calls.length = 0;
  route = () => undefined;
  globalThis.fetch = vi.fn(async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    if (url === TOKEN_URL) {
      return Response.json({ access_token: "token", expires_in: 3599 });
    }
    const call: ApiCall = {
      url: new URL(url),
      method: init.method ?? "GET",
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const reply = route(call) ?? {};
    return Response.json(reply.body ?? {}, { status: reply.status ?? 200 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

let accounts = 0;
function connection(overrides: Record<string, unknown> = {}): Connector {
  accounts += 1;
  return forms("forms", {
    purpose: "Event registration",
    serviceAccount: { clientEmail: `forms-${accounts}@project.iam.gserviceaccount.com`, privateKey: PRIVATE_KEY },
    subject: "office@church.example",
    ...overrides,
  } as Parameters<typeof forms>[1]);
}

function context(): ConnectorContext {
  return { storage: memoryStorage(), logger: silentLogger, baseUrl: "https://connecta.example" };
}

function call(connector: Connector, name: string, args: Record<string, unknown> = {}): Promise<any> {
  return connector.callTool(name, args, context()) as Promise<any>;
}

/**
 * Every key a result carries, at every depth, that its output schema does not
 * declare. Output schemas are open, so validation alone would pass a
 * projection that grew a field the schema never learned about.
 */
function undeclared(value: unknown, schema: any, path: string, found: string[]): string[] {
  if (Array.isArray(value)) {
    for (const entry of value) undeclared(entry, schema?.items, `${path}[]`, found);
  } else if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      const property = schema?.properties?.[key];
      if (!property) found.push(`${path}.${key}`);
      else undeclared(entry, property, `${path}.${key}`, found);
    }
  }
  return found;
}

/** A result validates against its tool's output schema, which declares every key it carries. */
async function conforms(connector: Connector, name: string, result: unknown, projected = true) {
  const tool = (await connector.listTools(context())).find((candidate) => candidate.name === name)!;
  const validation = new Validator(tool.outputSchema as never, "2020-12", false).validate(result);
  expect(validation.errors, name).toEqual([]);
  if (projected) expect(undeclared(result, tool.outputSchema, name, []), name).toEqual([]);
}

describe("writing forms", () => {
  // Kit writes on Node go through the owned transport that listen() installs.
  let restoreTransport: ReturnType<typeof configureGuardedTransport>;
  beforeEach(() => {
    restoreTransport = configureGuardedTransport({ send: (url, init) => globalThis.fetch(url, init) });
  });
  afterEach(() => {
    configureGuardedTransport(restoreTransport);
  });

  it.each([
    // 100 grids of 3,000 rows: every row's question id, ~4.5 MB of reply.
    [
      "drops question ids and keeps each created item's id",
      (index: number) => ({
        createItem: {
          itemId: `item${index}`,
          questionId: Array.from({ length: 3_000 }, (_, row) => `q${index}-${row}-abcdef`),
        },
      }),
      (result: any) => {
        expect(result.replies).toHaveLength(100);
        expect(result.replies[7]).toEqual({ createdItemId: "item7" });
      },
    ],
    // Item ids too long for even the id-only reply: counts are what is left.
    [
      "keeps only counts when even the item ids cannot fit",
      (index: number) => ({ createItem: { itemId: `${index}-${"x".repeat(3_000)}`, questionId: ["q"] } }),
      (result: any) => {
        expect(result.replies).toEqual([]);
        expect(result.replyCount).toBe(100);
        expect(result.createdItemCount).toBe(100);
      },
    ],
  ])(
    "bounds a batch reply too large to return whole, and still reports it applied: %s",
    async (_case, reply, check) => {
      route = () => ({
        body: {
          writeControl: { requiredRevisionId: "00000050" },
          replies: Array.from({ length: 100 }, (_, index) => reply(index)),
        },
      });
      const connector = connection();
      const result = await call(connector, "batch_update_form", {
        formId: "form-1",
        requiredRevisionId: "00000049",
        requests: Array.from({ length: 100 }, () => ({
          createItem: { item: { title: "Grid", questionGroupItem: {} }, location: { index: 0 } },
        })),
      });
      expect(jsonBytes(result)).toBeLessThanOrEqual(RESULT_BUDGET_BYTES);
      expect(result).toMatchObject({ formId: "form-1", revisionId: "00000050", truncated: true });
      expect(result.note).toMatch(/^The batch applied\./);
      expect(result.note).not.toMatch(/nothing|not applied|failed/i);
      check(result);
      await conforms(connector, "batch_update_form", result);
    },
  );
});

// Every result must cross execute_code's host bridge, which refuses one
// serialized host result over 256 KiB (`MAX_HOST_RESULT_BYTES` in
// src/executors/quickjs-runtime.ts), as well as a direct call's inline cap.
// These build the largest inputs the projections allow and page through them.
describe("worst-case results fit one host result (256 KiB)", () => {
  const BRIDGE_BYTES = 256 * 1024;
  const bridged = (value: unknown) => new TextEncoder().encode(JSON.stringify({ ok: true, value })).length;

  /** Item ids in page order, a grid continued across pages counted once. */
  const itemIds = (pages: any[]) =>
    pages.flatMap((page) => page.items.filter((item: any) => !item.questionsFrom).map((item: any) => item.itemId));
  /** Every question id one item returned, across every page, in order. */
  const rowsOf = (pages: any[], itemId: string) =>
    pages.flatMap((page) =>
      page.items
        .filter((item: any) => item.itemId === itemId)
        .flatMap((item: any) => item.questions.map((question: any) => question.questionId)),
    );

  async function everyPage(name: string, args: Record<string, unknown>): Promise<any[]> {
    const connector = connection();
    const pages: any[] = [];
    let cursor: string | undefined;
    do {
      const page = await call(connector, name, { ...args, ...(cursor ? { cursor } : {}) });
      // The complete result, cursor included, inside the shared budget — and
      // so inside the bridge, envelope and all.
      expect(jsonBytes(page)).toBeLessThanOrEqual(RESULT_BUDGET_BYTES);
      expect(bridged(page)).toBeLessThan(BRIDGE_BYTES);
      await conforms(connector, name, page);
      pages.push(page);
      cursor = page.page.nextCursor ?? undefined;
      expect(pages.length).toBeLessThan(500);
    } while (cursor);
    return pages;
  }

  it("pages a large form's items, and refuses a cursor once the form has changed", { timeout: 30_000 }, async () => {
    const options = Array.from({ length: 150 }, (_, index) => ({ value: `${index} ${"選".repeat(400)}` }));
    const form = {
      formId: "huge",
      revisionId: "00000009",
      info: { title: "Huge", description: "説".repeat(3_000) },
      items: [
        ...Array.from({ length: 25 }, (_, index) => ({
          itemId: `i${index}`,
          title: "問".repeat(3_000),
          description: "述".repeat(3_000),
          questionItem: { question: { questionId: `q${index}`, choiceQuestion: { type: "DROP_DOWN", options } } },
        })),
        {
          itemId: "grid",
          title: "Grid",
          questionGroupItem: {
            grid: { columns: { type: "RADIO", options: options.slice(0, 5) } },
            questions: Array.from({ length: 2_000 }, (_, index) => ({
              questionId: `row${index}`,
              rowQuestion: { title: "列".repeat(150) },
            })),
          },
        },
      ],
    };
    route = () => ({ body: form });
    const pages = await everyPage("get_form", { formId: "huge" });
    expect(pages.length).toBeGreaterThan(1);
    expect(itemIds(pages)).toEqual([...Array.from({ length: 25 }, (_, index) => `i${index}`), "grid"]);
    expect(pages.every((page) => page.itemCount === 26)).toBe(true);
    // The grid continues across pages until every row is out, each once.
    // everyPage ran each page — moreQuestions and questionsFrom included —
    // through schema validation and the undeclared-key walk.
    expect(rowsOf(pages, "grid")).toEqual(Array.from({ length: 2_000 }, (_, index) => `row${index}`));
    const parts = pages.flatMap((page) => page.items.filter((item: any) => item.itemId === "grid"));
    expect(parts.length).toBeGreaterThan(1);
    expect(parts[0].moreQuestions).toBe(2_000 - parts[0].questions.length);
    expect(parts[1].questionsFrom).toBe(parts[0].questions.length);
    expect(parts.at(-1).moreQuestions).toBeUndefined();

    // The same form whole is more than one result: raw refuses with guidance.
    const raw = await call(connection(), "get_form", { formId: "huge", raw: true }).catch((error) => error);
    expect(raw).toMatchObject({ code: "invalid_args", message: expect.stringContaining("pages its items") });

    // Items are addressed by index; a page of a changed form would skip some.
    const first = await call(connection(), "get_form", { formId: "huge" });
    route = () => ({ body: { ...form, revisionId: "00000010" } });
    await expect(
      call(connection(), "get_form", { formId: "huge", cursor: first.page.nextCursor }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      call(connection(), "get_form", { formId: "other", cursor: first.page.nextCursor }),
    ).rejects.toMatchObject({ code: "invalid_args" });
  });
});

describe("list_responses resumes only on the page it was issued for", () => {
  /** Twelve long answers each: two responses fill a page, a third does not. */
  const form = {
    formId: "f",
    revisionId: "1",
    info: { title: "Retreat" },
    items: Array.from({ length: 12 }, (_, index) => ({
      itemId: `i${index}`,
      title: `Q${index}`,
      questionItem: { question: { questionId: `q${index}`, textQuestion: { paragraph: true } } },
    })),
  };
  const response = (id: string) => ({
    responseId: id,
    answers: Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => [
        `q${index}`,
        { questionId: `q${index}`, textAnswers: { answers: [{ value: "日".repeat(2_500) }] } },
      ]),
    ),
  });

  /** Rows the responses route serves, read afresh on every list call. */
  let rows: string[] | (() => string[]) = [];
  beforeEach(() => {
    route = (request) =>
      request.url.pathname.endsWith("/responses")
        ? { body: { responses: (typeof rows === "function" ? rows() : rows).map(response) } }
        : { body: form };
  });

  it.each([
    // Google promises no stable order: the anchor alone would continue after
    // r1 here and return r0 again while skipping r2.
    ["reordered", ["r2", "r1", "r0", "r3", "r4"]],
    ["the anchor deleted", ["r0", "r2", "r3", "r4"]],
  ])("refuses a page that came back %s, with restart guidance", async (_case, refetched) => {
    rows = ["r0", "r1", "r2", "r3", "r4"];
    const connector = connection();
    const first = await call(connector, "list_responses", { formId: "f" });
    rows = refetched;
    const failure = await call(connector, "list_responses", { formId: "f", cursor: first.page.nextCursor }).catch(
      (error) => error,
    );
    expect(failure).toMatchObject({ code: "conflict", retryable: false });
    expect(failure.message).toContain("Start again without cursor");
    expect(failure.message).toContain("submittedAfter");
  });
});
