import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installOwnedTransport } from "../../../test/fixtures/owned-transport.js";
import { silentLogger } from "../../../test/helpers.js";
import { memoryStorage } from "../../storage/memory.js";
import type { ConnectorContext } from "../../types.js";
import { granola } from "./index.js";

const KEY = "grn_fixture_workspace_secret";
const NOTE = "not_abcdefghijklmn";
const FOLDER = "fol_abcdefghijklmn";
const SPACE = "spa_abcdefghijklmn";
const requests: { url: URL; init: RequestInit }[] = [];
let respond: (url: URL) => Response;
beforeEach(() => {
  installOwnedTransport();
  requests.length = 0;
  respond = () => Response.json({ notes: [], hasMore: false, cursor: null });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: URL | string, init: RequestInit = {}) => {
      const url = new URL(input);
      requests.push({ url, init });
      expect(url.origin).toBe("https://public-api.granola.ai");
      expect(init.redirect).toBe("manual");
      expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${KEY}`);
      return respond(url);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function setup(value: string | null = KEY) {
  const connector = granola("granola", { purpose: "Shared workspace notes" });
  const ctx: ConnectorContext = {
    storage: memoryStorage(),
    logger: silentLogger,
    baseUrl: "https://connecta.example",
    credential: { get: async () => value, getAll: async () => (value === null ? null : { value }) },
  };
  return {
    connector,
    ctx,
    call: (args: Record<string, unknown>) => connector.callTool("granola_api_read", args, ctx) as Promise<any>,
  };
}

it("INV-1 INV-3 INV-5 INV-10: discovers only read tools without credentials or vendor I/O", async () => {
  const { connector, ctx } = setup(null);
  const tools = await connector.listTools(ctx);
  expect(tools.map((t) => t.name).sort()).toEqual(["granola_api_details", "granola_api_read", "granola_api_search"]);
  expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
  const unrestricted = granola("granola", { purpose: "Shared workspace notes", readOnly: false });
  expect((await unrestricted.listTools(ctx)).map((t) => t.name).sort()).toEqual(tools.map((t) => t.name).sort());
  const search = await connector.callTool("granola_api_search", { query: "transcript" }, ctx);
  expect(JSON.stringify(search)).toContain("/v1/notes/{note_id}/transcript");
  const details = await connector.callTool(
    "granola_api_details",
    { method: "GET", path: "/v1/notes/{note_id}/transcript" },
    ctx,
  );
  expect(JSON.stringify(details)).toContain("page_size");
  expect(requests).toHaveLength(0);
});

it("INV-3 INV-5: pages empty intermediate results, narrows fields and binds transcript continuations to their note", async () => {
  const { call } = setup();
  respond = () => Response.json({ transcript: [], hasMore: true, cursor: "vendor-token-α" });
  const args = { path: `/v1/notes/${NOTE}/transcript`, query: { page_size: 1 }, fields: ["transcript.text"] };
  const first = await call(args);
  expect(first.page).toMatchObject({ hasMore: true, nextCursor: expect.any(String) });
  expect(first.page.nextCursor).not.toBe("vendor-token-α");
  respond = (url) => {
    expect(url.searchParams.get("cursor")).toBe("vendor-token-α");
    expect(url.searchParams.get("page_size")).toBe("1");
    return Response.json({
      transcript: [{ text: "Decision: ship", speaker: { source: "microphone" } }],
      hasMore: false,
      cursor: null,
    });
  };
  const last = await call({ ...args, cursor: first.page.nextCursor });
  expect(last.data).toEqual({ transcript: [{ text: "Decision: ship" }] });
  expect(last.page).toMatchObject({ hasMore: false });
  expect(last.page.nextCursor).toBeUndefined();
  const count = requests.length;
  for (const changed of [
    { ...args, path: "/v1/notes/not_zyxwvutsrqponm/transcript" },
    { ...args, query: { page_size: 2 } },
  ])
    await expect(call({ ...changed, cursor: first.page.nextCursor })).rejects.toMatchObject({ code: "invalid_args" });
  expect(requests).toHaveLength(count);
});

it("INV-3 INV-5: withholds sent credentials, bearer attachment URLs, embedded links and unsafe continuations before fields selection", async () => {
  const { call } = setup();
  respond = () =>
    Response.json({
      id: NOTE,
      title: KEY,
      summary_text: `See https://example.com/file?token=${KEY}`,
      attachments: [{ id: "att_abcdefghijklmn", url: "https://files.example.com/bearer-link" }],
      api_key: "stored-other-secret",
    });
  const result = await call({ path: `/v1/notes/${NOTE}`, fields: ["id", "title", "summary_text", "attachments.url"] });
  const text = JSON.stringify(result);
  expect(text).not.toContain(KEY);
  expect(text).not.toContain("stored-other-secret");
  expect(text).not.toContain("bearer-link");
  expect(text).toContain("[redacted]");
  respond = () => Response.json({ notes: [], hasMore: true, cursor: KEY });
  const error = await call({ path: "/v1/notes" }).catch((error: unknown) => error);
  expect(error).toMatchObject({ code: "connector_call_failed", retryable: false });
  expect(String(error)).not.toContain(KEY);
});

it("INV-2 INV-3 INV-11: confines paths, operations and query contracts before authentication or dispatch", async () => {
  const { call } = setup(null);
  for (const args of [
    { path: "https://evil.example/v1/notes" },
    { path: "//evil.example/v1/notes" },
    { path: "/v1/notes/../spaces" },
    { path: "/v1/audit" },
    { path: "/v1/legal-holds" },
    { path: "/v1/webhook-endpoints" },
    { path: "/v1/notes", method: "POST" },
    { path: "/v1/notes", query: { search: "meeting content" } },
    { path: "/v1/notes", query: { page_size: 31 } },
    { path: `/v1/notes/${NOTE}/transcript`, query: { page_size: 101 } },
    { path: "/v1/notes", query: { folder_id: "some folder" } },
    { path: "/v1/notes", query: { cursor: "raw-vendor-token" } },
    { path: "/v1/notes/not_uuid" },
  ])
    await expect(call(args), JSON.stringify(args)).rejects.toMatchObject({ code: "invalid_args" });
  expect(requests).toHaveLength(0);
  for (const options of [
    { baseUrl: "https://evil.example" },
    { authScope: "personal" },
    { apiKey: KEY },
    { auth: { type: "oauth" } },
  ])
    expect(() => granola("granola", { purpose: "Notes", ...options })).toThrow();
});

it("INV-5 INV-10: refuses missing/malformed credentials offline and invalid keys without leaking downstream prose", async () => {
  for (const value of [null, "", "bad\r\nkey"])
    await expect(setup(value).call({ path: "/v1/notes" })).rejects.toMatchObject({ code: "auth_required" });
  expect(requests).toHaveLength(0);
  respond = () => Response.json({ message: `Do not disclose ${KEY} or private-meeting-content` }, { status: 401 });
  const error = await setup()
    .call({ path: "/v1/notes" })
    .catch((error: unknown) => error);
  expect(error).toMatchObject({ code: "auth_required" });
  expect(String(error)).not.toContain("private-meeting-content");
  expect(String(error)).not.toContain(KEY);
  expect(requests).toHaveLength(1);
});

it("INV-5 INV-7: refuses redirects, reports rate-limit hints and sends each call once", async () => {
  const { call } = setup();
  respond = () => new Response(null, { status: 302, headers: { location: "https://evil.example/steal" } });
  await expect(call({ path: "/v1/notes" })).rejects.toMatchObject({ code: "connector_call_failed" });
  expect(requests).toHaveLength(1);
  respond = () => Response.json({ error: KEY }, { status: 429, headers: { "Retry-After": "3" } });
  await expect(call({ path: "/v1/notes" })).rejects.toMatchObject({ code: "rate_limited", retryAfterMs: 3000 });
  expect(requests).toHaveLength(2);
});

it("INV-5: recovers an oversized inline transcript through explicit paged reads without hidden fetches", async () => {
  const { call } = setup();
  respond = () => Response.json({ error: { code: "TRANSCRIPT_TOO_LARGE", message: KEY } }, { status: 413 });
  const failure = await call({ path: `/v1/notes/${NOTE}`, query: { include: "transcript" } }).catch((e: unknown) => e);
  expect(failure).toMatchObject({ code: "connector_call_failed" });
  expect(String(failure)).toContain("/transcript");
  expect(requests).toHaveLength(1);
  respond = () => Response.json({ id: NOTE, summary_text: "Ship on Tuesday" });
  expect((await call({ path: `/v1/notes/${NOTE}` })).data.summary_text).toBe("Ship on Tuesday");
  respond = () => Response.json({ transcript: [{ text: "Ship on Tuesday" }], hasMore: false, cursor: null });
  expect((await call({ path: `/v1/notes/${NOTE}/transcript` })).data.transcript[0].text).toBe("Ship on Tuesday");
  expect(requests).toHaveLength(3);
});

it("INV-5: returns honest folder/space metadata, refuses inconsistent paging and bounds whole responses", async () => {
  const { call } = setup();
  for (const [path, key, id] of [
    ["/v1/folders", "folders", FOLDER],
    ["/v1/spaces", "spaces", SPACE],
  ]) {
    respond = () => Response.json({ [key!]: [{ id, name: "Team" }], hasMore: false, cursor: null });
    expect((await call({ path })).data[key!][0].id).toBe(id);
  }
  respond = () => Response.json({ notes: [], hasMore: true, cursor: null });
  await expect(call({ path: "/v1/notes" })).rejects.toMatchObject({ code: "connector_call_failed" });
  respond = () => Response.json({ notes: [], hasMore: "false" });
  await expect(call({ path: "/v1/notes" })).rejects.toMatchObject({ code: "connector_call_failed" });
  respond = () =>
    new Response("{}", {
      headers: { "Content-Type": "application/json", "Content-Length": String(4 * 1024 * 1024 + 1) },
    });
  await expect(call({ path: "/v1/notes" })).rejects.toMatchObject({ code: "connector_call_failed" });
});
