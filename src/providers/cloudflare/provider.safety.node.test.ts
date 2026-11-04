// Node-only: the shared value-safety harness reads the maintainer detection script in scripts/.
import candidates from "./evidence/value-safety.json";
import source from "./evidence/openapi.json";
import { openapi } from "./openapi.generated.js";
import { CLOUDFLARE_VALUE_SAFETY } from "./safety.js";
import { OperationIndex } from "../_shared/rest/operation-index.js";
import { connectorContext } from "../../../test/fixtures/misc.js";
import { describeValueSafety } from "../../../test/fixtures/value-safety.js";
import { cloudflare } from "./index.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeRegistry, silentLogger } from "../../../test/helpers.js";
import { installOwnedTransport } from "../../../test/fixtures/owned-transport.js";
import { CredentialVault } from "../../credentials.js";
import { createExecuteTool } from "../../execute.js";
import { quickJsExecutor } from "../../executors/quickjs.js";
import { memoryStorage } from "../../storage/memory.js";
import type { AdmittingExecutor } from "../../types.js";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const ZONE = "023e105f4ecef8ad9ca31a8372d0c353";

describeValueSafety("Cloudflare", {
  table: CLOUDFLARE_VALUE_SAFETY,
  index: new OperationIndex(openapi, { vendor: "cloudflare", title: "Cloudflare" }),
  source,
  candidates,
  counts: { refuse: 61, redact: 268, safe: 482 },
  // Reviewed operation paths are relative to result; the provider also scans the
  // outer envelope before retaining its safe metadata.
  dataPath: (field) => {
    if (/^(?:result_info|messages|errors|success)\b/.test(field)) return undefined;
    const data = field.replace(/^result(?:\[\])?(?=\.|\{|$)/, "").replace(/^\./, "");
    return data === "{}" ? "" : data;
  },
  connector: () => cloudflare("cf", { purpose: "Production DNS and Workers", auth: { type: "apiToken" } }),
  ctx: () => ({
    ...connectorContext(),
    credential: { get: async () => "cf-token-123", getAll: async () => ({ value: "cf-token-123" }) },
  }),
  fill: (template) =>
    template
      .replace(/\{account_id\}|\{account_tag\}/g, ACCOUNT)
      .replace(/\{zone_id\}/g, ZONE)
      .replace(/\{[^}]+\}/g, "x1"),
  streamFormat: "json",
  echo: {
    tool: "cloudflare_api_read",
    args: { path: `/accounts/${ACCOUNT}/challenges/widgets/0x4AAA` },
    respond: (marker) =>
      Response.json(
        { success: false, errors: [{ code: 10001, message: `secret ${marker} rejected` }] },
        { status: 400 },
      ),
  },
});

describe("INV-5: a program on a Global API Key connection", () => {
  const EMAIL = "alice@example.com";
  const API_KEY = "cfk0123456789abcdef0123456789abcdef";
  const PATH = `/zones/${ZONE}/dns_records`;
  const realFetch = globalThis.fetch;
  let bodies: string[] = [];
  let executor: AdmittingExecutor;

  beforeAll(() => {
    executor = quickJsExecutor({ cpuTimeMs: 5_000 });
  });
  afterAll(async () => {
    await executor.close?.();
  });
  beforeEach(() => {
    bodies = [];
    installOwnedTransport();
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? init.body : "{}";
      bodies.push(body);
      return Response.json({ success: true, errors: [], messages: [], result: JSON.parse(body) });
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const writes = async (...records: Record<string, unknown>[]) => {
    const storage = memoryStorage();
    const vault = new CredentialVault(storage, btoa(String.fromCharCode(...new Uint8Array(32).fill(7))));
    await vault.setAll("cf", { email: EMAIL, apiKey: API_KEY }, "operator");
    const connector = cloudflare("cf", {
      purpose: "Legacy estate",
      auth: { type: "globalApiKey" },
      pin: { accountIds: [ACCOUNT], zoneIds: [ZONE] },
    });
    const execute = createExecuteTool(
      makeRegistry([connector], { storage, credentialVault: vault }),
      "https://connecta.test",
      executor,
      silentLogger,
      undefined,
      { readOnly: false },
    );
    const result = await execute({
      code: `async () => {
        const out = [];
        for (const body of ${JSON.stringify(records)}) {
          try {
            out.push((await connecta.call("cf.cloudflare_api_write", { method: "POST", path: ${JSON.stringify(PATH)}, body })).data);
          } catch (error) { out.push({ refused: error.code }); }
        }
        return out;
      }`,
    });
    return result.structuredContent?.result as Record<string, unknown>[];
  };

  it("sends its account's domain unchanged on the second write and returns it intact", async () => {
    const first = { type: "A", name: "first.test", content: "192.0.2.1" };
    const second = { type: "A", name: "example.com", content: "192.0.2.2" };
    const out = await writes(first, second);
    expect(bodies.map((body) => JSON.parse(body))).toEqual([first, second]);
    expect(JSON.stringify(out)).toContain("example.com");
    expect(JSON.stringify(out)).not.toContain("[redacted]");
  });

  it("sends the whole account email unchanged as a value", async () => {
    const record = { type: "TXT", name: "owner.test", content: EMAIL };
    await writes({ type: "A", name: "first.test", content: "192.0.2.1" }, record);
    expect(JSON.parse(bodies[1]!)).toEqual(record);
  });

  it.each([
    ["whole", API_KEY],
    ["in part", API_KEY.slice(6, 22)],
  ])("refuses a later write holding the API key %s, sending nothing", async (_label, held) => {
    const out = await writes(
      { type: "A", name: "first.test", content: "192.0.2.1" },
      { type: "TXT", name: "leak.test", content: `v=${held}` },
    );
    expect(bodies).toHaveLength(1);
    expect(out[1]).toEqual({ refused: "invalid_args" });
  });
});
