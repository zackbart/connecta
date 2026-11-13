// Node-only: the shared safety reviewer imports the maintainer detection script.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installOwnedTransport } from "../../../test/fixtures/owned-transport.js";
import { reviewProblems } from "../../../test/fixtures/value-safety.js";
import { silentLogger } from "../../../test/helpers.js";
import { memoryStorage } from "../../storage/memory.js";
import candidates from "./evidence/value-safety.json";
import source from "./evidence/openapi.json";
import { index } from "./api.js";
import { intercom } from "./index.js";
import { COMMA_QUERY, EXPLODED_OBJECT_QUERY } from "./lib/query.js";
import { INTERCOM_VALUE_SAFETY, READS } from "./safety.js";
import document from "./evidence/openapi.document.json";

const TOKEN = "intercom_value_safety_token";
let sent = 0;
let respond: () => Response;
beforeEach(() => {
  installOwnedTransport();
  sent = 0;
  respond = () => Response.json({});
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      sent += 1;
      return respond();
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const ctx = () => ({
  storage: memoryStorage(),
  logger: silentLogger,
  baseUrl: "https://connecta.example",
  credential: { get: async () => TOKEN, getAll: async () => ({ value: TOKEN }) },
});

it("INV-5: accounts for every credential candidate and verifies reviewed paths against Intercom's pinned response schemas", () => {
  const problems = reviewProblems({ table: INTERCOM_VALUE_SAFETY, index, source, candidates });
  expect(Object.values(problems).flat()).toEqual([]);
  const counts = { refuse: 0, redact: 0, safe: 0 };
  for (const verdict of Object.values(INTERCOM_VALUE_SAFETY.operations)) counts[verdict.verdict] += 1;
  expect(counts).toEqual({ refuse: 163, redact: 11, safe: 103 });
  for (const key of Object.keys(candidates.candidates))
    expect(["refuse", "redact"]).toContain(INTERCOM_VALUE_SAFETY.operations[key]?.verdict);
});

it("INV-3: refuses every refused read family before anything is sent, and serves no write hatch", async () => {
  const connector = intercom("support", { purpose: "Support", admin: "1001" });
  const reached: string[] = [];
  for (const [key, verdict] of Object.entries(INTERCOM_VALUE_SAFETY.operations)) {
    const [method, template] = key.split(" ") as [string, string];
    if (verdict.verdict !== "refuse" || method !== "GET") continue;
    const error = await connector
      .callTool("intercom_api_read", { path: template.replace(/\{[^}]+\}/g, "1") }, ctx())
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    if (!(error instanceof Error) || !error.message.includes(`Connecta refuses ${method} ${template}`))
      reached.push(key);
  }
  expect(reached).toEqual([]);
  expect((await connector.listTools(ctx())).some((tool) => tool.name === "intercom_api_write")).toBe(false);
  expect(sent).toBe(0);
});

it("INV-5: withholds vendor error prose that could echo a stored value", async () => {
  const marker = "stored-secret-marker";
  respond = () =>
    Response.json(
      { type: "error.list", request_id: "r1", errors: [{ code: "parameter_invalid", message: `secret ${marker}` }] },
      { status: 400 },
    );
  const connector = intercom("support", { purpose: "Support", admin: "1001" });
  const error = (await connector
    .callTool("intercom_api_read", { path: "/conversations/1" }, ctx())
    .catch((caught: unknown) => caught)) as Error;
  expect(error.message).toContain("parameter_invalid");
  expect(error.message).not.toContain(marker);
  expect(JSON.stringify(error)).not.toContain(marker);
});

it("encodes every styled query parameter of an admitted read exactly as the pinned document declares", () => {
  type Parameter = {
    $ref?: string;
    in?: string;
    name?: string;
    explode?: boolean;
    schema?: { type?: string; $ref?: string };
  };
  const paths = document.paths as unknown as Record<string, Record<string, { parameters?: Parameter[] }>>;
  const comma: Record<string, string[]> = {};
  const exploded: Record<string, string[]> = {};
  for (const [path, item] of Object.entries(paths))
    for (const [method, operation] of Object.entries(item)) {
      const key = `${method.toUpperCase()} ${path}`;
      if (!READS.has(key)) continue;
      for (const parameter of operation.parameters ?? []) {
        if (parameter.in !== "query") continue;
        expect(parameter.$ref, key).toBeUndefined();
        expect(parameter.schema?.$ref, key).toBeUndefined();
        const type = parameter.schema?.type;
        if (type === "array" && parameter.explode === false) (comma[key] ??= []).push(parameter.name!);
        else if (type === "object" && parameter.explode !== false) (exploded[key] ??= []).push(parameter.name!);
        else expect([undefined, true], `${key} ${parameter.name}`).toContain(parameter.explode);
      }
    }
  expect(comma).toEqual(COMMA_QUERY);
  expect(exploded).toEqual(EXPLODED_OBJECT_QUERY);
});
