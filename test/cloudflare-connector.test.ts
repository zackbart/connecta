import { afterEach, describe, expect, it, vi } from "vitest";
import { cloudflareApi } from "../src/connectors/cloudflare.js";
import type { ConnectorContext } from "../src/types.js";
import { memoryStorage } from "../src/storage/memory.js";
import { silentLogger } from "./helpers.js";

const BASE = "https://connecta.test";
const VALUES = {
  apiEmail: "operator@example.com",
  apiKey: "global-api-key",
};

function context(values = VALUES): ConnectorContext {
  return {
    storage: memoryStorage(),
    logger: silentLogger,
    baseUrl: BASE,
    credential: {
      get: async (field = "value") => values[field as keyof typeof values] ?? null,
      getAll: async () => ({ ...values }),
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("cloudflareApi()", () => {
  it("exposes the approved broad API surface and excludes rejected families", async () => {
    const connector = cloudflareApi();
    const tools = await connector.listTools(context());
    const names = new Set(tools.map((tool) => tool.name));

    expect(tools).toHaveLength(1089);
    expect(names).toContain("sdk.getOperationDocumentation");
    expect(names).toContain("workers.scripts.update");
    expect(names).toContain("d1.database.query");
    expect(names).toContain("zones.list");
    expect(names).toContain("dns.records.create");
    expect(names).toContain("zeroTrust.tunnels.cloudflared.create");
    expect(names).toContain("zeroTrust.networks.routes.create");
    expect(names).toContain("zeroTrust.access.applications.create");
    expect(names).toContain("emailSending.send");
    expect(names).toContain("billing.profiles.get");
    expect(names).toContain("user.tokens.create");
    expect([...names].some((name) => name.startsWith("registrar."))).toBe(false);
    expect([...names].some((name) => name.startsWith("magicTransit."))).toBe(false);
    expect([...names].some((name) => name.startsWith("spectrum."))).toBe(false);
    expect([...names].some((name) => name.startsWith("firewall."))).toBe(false);
    expect(
      [...names].some((name) => name.startsWith("originCACertificates.")),
    ).toBe(false);
  });

  it("marks reads safe and requires confirmation for every state change", async () => {
    const connector = cloudflareApi();
    const tools = await connector.listTools(context());
    const read = tools.find((tool) => tool.name === "zones.list")!;
    const write = tools.find((tool) => tool.name === "dns.records.create")!;

    expect(read.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
    });
    expect(write.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
    expect(write.inputSchema).toMatchObject({
      properties: { confirm: { const: true } },
      required: ["confirm"],
    });
    await expect(
      connector.callTool(
        "dns.records.create",
        { arguments: [] },
        context(),
      ),
    ).rejects.toThrow("requires confirm: true");
  });

  it("uses legacy email plus Global API Key headers", async () => {
    let request: Request | undefined;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      request = new Request(input, init);
      return Response.json({
        success: true,
        errors: [],
        messages: [],
        result: [],
        result_info: { page: 1, per_page: 20, count: 0, total_count: 0 },
      });
    });

    const result = await cloudflareApi().callTool(
      "zones.list",
      { arguments: [] },
      context(),
    );

    expect(request?.headers.get("X-Auth-Email")).toBe(VALUES.apiEmail);
    expect(request?.headers.get("X-Auth-Key")).toBe(VALUES.apiKey);
    expect(request?.headers.get("Authorization")).toBeNull();
    expect(result).toMatchObject({ items: [], hasNextPage: false });
  });

  it("bounds raw download bodies before converting them to text or base64", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response("x".repeat(300_000), {
          headers: { "content-type": "text/javascript" },
        }),
    );

    const result = (await cloudflareApi().callTool(
      "workers.scripts.content.get",
      { arguments: ["script-name", { account_id: "account-id" }] },
      context(),
    )) as {
      body: string;
      bodyBytes: number;
      bodyTruncated: boolean;
    };

    expect(result.bodyTruncated).toBe(true);
    expect(result.bodyBytes).toBe(256 * 1024);
    expect(result.body).toHaveLength(256 * 1024);
  });

  it("returns pinned SDK documentation and parameter definitions", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(`
export class BaseDatabase {
  /**
   * Returns the created D1 database.
   */
  create(params: DatabaseCreateParams): Promise<unknown> {
    return this._client.post("/accounts");
  }
}

export interface DatabaseCreateParams {
  /** Identifier of the account. */
  account_id: string;
  /** Database name. */
  name: string;
}
`),
    );

    const result = (await cloudflareApi().callTool(
      "sdk.getOperationDocumentation",
      { operation: "d1.database.create" },
      context(),
    )) as any;

    expect(result.sdkCommit).toBe(
      "3583affb5cea551858ed4c4b6c0fc326a306d3bd",
    );
    expect(result.signature).toContain("client.d1.database.create");
    expect(result.sourceExcerpt).toContain("interface DatabaseCreateParams");
    expect(result.sourceUrl).toContain(
      "/3583affb5cea551858ed4c4b6c0fc326a306d3bd/",
    );
  });

  it("reports missing credentials as auth_required", async () => {
    const connector = cloudflareApi();
    const ctx: ConnectorContext = {
      storage: memoryStorage(),
      logger: silentLogger,
      baseUrl: BASE,
      credential: {
        get: async () => null,
        getAll: async () => null,
      },
    };

    await expect(connector.status!(ctx)).resolves.toMatchObject({
      state: "auth_required",
    });
  });
});
