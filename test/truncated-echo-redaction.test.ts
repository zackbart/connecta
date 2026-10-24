// A vendor that echoes a sent secret in an error message or result, where
// connecta shortens that text before it leaves: redaction must see the whole
// text first. A cut through an echoed form leaves a fragment that no
// registered form matches, so redacting after the cut leaks the fragment.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachCaller } from "../src/connector-caller.js";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { ConnectorCallError } from "../src/errors.js";
import { installOwnedTransport } from "./fixtures/owned-transport.js";
import { createMetaTools } from "../src/meta-tools.js";
import { SentSecrets } from "../src/sent-secrets.js";
import { breeze } from "../src/providers/breeze/index.js";
import { cloudflare } from "../src/providers/cloudflare/index.js";
import { gmail } from "../src/providers/gmail/index.js";
import { api } from "../src/connectors/api.js";
import { redactBoundedRead } from "../src/sent-secrets.js";
import { overflow } from "../src/providers/overflow/index.js";
import { vercel } from "../src/providers/vercel/index.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { AuthenticatedIdentity, ConnectorContext } from "../src/types.js";
import { makeRegistry, silentLogger } from "./helpers.js";
import { httpDownstream } from "./fixtures/downstream-mcp.js";
import { connectorContext } from "./fixtures/misc.js";
import { SECRET, echoForms, expectNoFragment, head, straddling } from "./helpers/secret-echoes.js";

// Decoder variants are covered at the shared boundary; each provider keeps raw
// and escaped cut regressions on its own output path.
const PROVIDER_ECHO_FORMS = echoForms(SECRET).filter(([name]) => name === "raw" || name === "\\u-escaped (lower hex)");

/** A connector context whose credential slot holds SECRET. */
const keyed = (): ConnectorContext => ({
  ...connectorContext(),
  credential: { get: async () => SECRET, getAll: async () => ({ value: SECRET }) },
});

/** The ConnectorCallError a call fails with. */
async function refusal(call: unknown): Promise<ConnectorCallError> {
  const error = await Promise.resolve(call).then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ConnectorCallError);
  return error as ConnectorCallError;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Google Workspace error messages", () => {
  const keys = crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  ) as Promise<CryptoKeyPair>;
  let accounts = 0;

  async function account() {
    const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", (await keys).privateKey)) as ArrayBuffer);
    let binary = "";
    for (const byte of der) binary += String.fromCharCode(byte);
    return {
      clientEmail: `echo-${++accounts}@project.iam.gserviceaccount.com`,
      privateKey: `-----BEGIN PRIVATE KEY-----\n${btoa(binary)}\n-----END PRIVATE KEY-----\n`,
    };
  }

  function context(): ConnectorContext {
    const identity: AuthenticatedIdentity = {
      actor: { kind: "test-users", id: "alice", namespace: "https://identity.test" },
      subject: { namespace: "https://identity.test", id: "alice" },
      principal: { namespace: "https://identity.test", id: "alice" },
      interactive: true,
    };
    const ctx: ConnectorContext = {
      storage: memoryStorage(),
      logger: silentLogger,
      baseUrl: "https://connecta.example",
    };
    return attachCaller(ctx, { identity, authenticated: true });
  }

  it.each(PROVIDER_ECHO_FORMS)(
    "INV-5: a 401 echoing the sent token %s across the 500-character cap leaks no fragment of it",
    async (_name, form) => {
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        if (String(input) === "https://oauth2.googleapis.com/token")
          return Response.json({ access_token: SECRET, expires_in: 3599, token_type: "Bearer" });
        return Response.json({ error: { code: 401, message: straddling(form, 500) } }, { status: 401 });
      });
      const connector = gmail("mail", {
        purpose: "Staff email",
        serviceAccount: await account(),
        subject: "alice@org.example",
      });
      const failure = await refusal(connector.callTool("list_labels", {}, context()));
      expect(failure).toMatchObject({ code: "auth_required" });
      expectNoFragment(failure.message, form);
    },
  );
});

describe("shared REST failure mappers", () => {
  it.each(PROVIDER_ECHO_FORMS)(
    "INV-5: a Vercel 400 echoing the sent token %s across the 1,000-character cap leaks no fragment of it",
    async (_name, form) => {
      vi.stubGlobal("fetch", async () =>
        Response.json({ error: { message: straddling(form, 1_000) } }, { status: 400 }),
      );
      const connector = vercel("hosting", { purpose: "Ops", auth: { type: "token" }, teamId: "team_default" });
      const error = await refusal(connector.callTool("vercel_api_read", { path: "/v5/domains" }, keyed()));
      expectNoFragment(error.message, form);
    },
  );

  it.each(PROVIDER_ECHO_FORMS)(
    "INV-5: a Vercel log read's 400 echoing the sent token %s across the 1,000-character cap leaks no fragment of it",
    async (_name, form) => {
      vi.stubGlobal("fetch", async () =>
        Response.json({ error: { message: straddling(form, 1_000) } }, { status: 400 }),
      );
      const connector = vercel("hosting", { purpose: "Ops", auth: { type: "token" }, teamId: "team_default" });
      const error = await refusal(connector.callTool("get_deployment_build_logs", { deploymentId: "dpl_1" }, keyed()));
      expectNoFragment(error.message, form);
    },
  );

  it.each(PROVIDER_ECHO_FORMS)(
    "INV-5: a Vercel upload's 400 echoing the sent token %s across the 1,000-character cap leaks no fragment of it",
    async (_name, form) => {
      vi.stubGlobal("fetch", async () =>
        Response.json({ error: { message: straddling(form, 1_000) } }, { status: 400 }),
      );
      const connector = vercel("hosting", { purpose: "Ops", auth: { type: "token" }, teamId: "team_default" });
      const previousTransport = installOwnedTransport();
      try {
        const error = await refusal(
          connector.callTool("vercel_api_upload", { method: "POST", path: "/v2/files", textBody: "hello" }, keyed()),
        );
        expectNoFragment(error.message, form);
        expect(previousTransport.send).toHaveBeenCalledTimes(1);
        expect(error.code).toBe("invalid_args");
      } finally {
        previousTransport.restore();
      }
    },
  );

  it.each(PROVIDER_ECHO_FORMS)(
    "INV-5: a Vercel build log line echoing the sent token %s across the 4,000-character clamp leaks no fragment of it",
    async (_name, form) => {
      vi.stubGlobal("fetch", async () =>
        Response.json([{ type: "stdout", payload: { text: straddling(form, 4_000) } }]),
      );
      const connector = vercel("hosting", { purpose: "Ops", auth: { type: "token" }, teamId: "team_default" });
      const result = (await connector.callTool("get_deployment_build_logs", { deploymentId: "dpl_1" }, keyed())) as {
        events: { text: string }[];
      };
      const text = result.events[0]!.text;
      expectNoFragment(text, form);
    },
  );

  it.each(PROVIDER_ECHO_FORMS)(
    "INV-5: a Cloudflare 400 echoing the sent token %s across the 500-character cap leaks no fragment of it",
    async (_name, form) => {
      vi.stubGlobal("fetch", async () =>
        Response.json(
          { success: false, errors: [{ code: 1000, message: straddling(form, 500) }], messages: [], result: null },
          { status: 400 },
        ),
      );
      const connector = cloudflare("cf", { purpose: "Ops", auth: { type: "apiToken" } });
      const error = await refusal(connector.callTool("cloudflare_api_read", { path: `/zones` }, keyed()));
      expectNoFragment(error.message, form);
    },
  );

  it.each(PROVIDER_ECHO_FORMS)(
    "INV-5: a Cloudflare 200 with success false echoing the sent token %s across the 500-character cap leaks no fragment of it",
    async (_name, form) => {
      vi.stubGlobal("fetch", async () =>
        Response.json({
          success: false,
          errors: [{ code: 1000, message: straddling(form, 500) }],
          messages: [],
          result: null,
        }),
      );
      const connector = cloudflare("cf", { purpose: "Ops", auth: { type: "apiToken" } });
      const error = await refusal(connector.callTool("cloudflare_api_read", { path: `/zones` }, keyed()));
      expectNoFragment(error.message, form);
    },
  );
});

describe("Breeze reported failures", () => {
  it.each(PROVIDER_ECHO_FORMS)(
    "INV-5: a success: false reply echoing the sent key %s across the 300-character cap leaks no fragment of it",
    async (_name, form) => {
      // shortText cuts JSON.stringify(errors), which opens with {"detail":".
      const opening = JSON.stringify({ detail: "" }).length - 2;
      vi.stubGlobal("fetch", async () =>
        Response.json({ success: false, errors: { detail: straddling(form, 300 - opening) } }),
      );
      const connector = breeze("church", { subdomain: "gracechurch", purpose: "Pastoral care" });
      const error = await refusal(connector.callTool("list_people", {}, keyed()));
      expectNoFragment(error.message, form);
    },
  );
});

describe("remote MCP error text", () => {
  const writeOnly = {
    type: "object" as const,
    properties: {
      config: { type: "object" as const, properties: { password: { type: "string" as const, writeOnly: true } } },
    },
  };

  /** A downstream whose tools/call fails with `fail(message)`, echoing what it is told. */
  function echoing(fail: (message: string) => Response) {
    let message = "";
    const downstream = httpDownstream((server) => {
      server.registerTool("placeholder", { description: "Advertise tools" }, async () => ({ content: [] }));
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const rpc =
        request.method === "POST" ? ((await request.clone().json()) as { id: number; method: string }) : undefined;
      if (rpc?.method === "tools/list")
        return Response.json({
          jsonrpc: "2.0",
          id: rpc.id,
          result: {
            resultType: "complete",
            ttlMs: 60_000,
            cacheScope: "private",
            tools: [{ name: "read", description: "Echo", annotations: { readOnlyHint: true }, inputSchema: writeOnly }],
          },
        });
      if (rpc?.method === "tools/call") {
        const response = fail(message);
        return response.status === 200
          ? Response.json({ jsonrpc: "2.0", id: rpc.id, ...((await response.json()) as object) })
          : response;
      }
      return downstream.fetch(request.url, init);
    });
    const meta = createMetaTools(makeRegistry([remoteMcp("echo", { url: downstream.url })]), "https://connecta.test");
    return async (text: string): Promise<string> => {
      message = text;
      const result = await meta.callTool({ address: "echo.read", args: { config: { password: SECRET } } });
      expect(result.isError).toBe(true);
      return (result.structuredContent as { error: { message: string } }).error.message;
    };
  }

  const cases = {
    "a JSON-RPC error": (message: string) => Response.json({ error: { code: -32602, message } }),
    "an HTTP 400 body": (message: string) => Response.json({ message }, { status: 400 }),
  };

  for (const [route, fail] of Object.entries(cases)) {
    it.each(PROVIDER_ECHO_FORMS)(
      `INV-5: ${route} echoing a writeOnly argument %s across the 512-byte cut leaks no fragment of it`,
      async (_name, form) => {
        const call = echoing(fail);
        // Whatever connecta or the SDK puts before the downstream's words moves the cut.
        const probe = await call("probe-marker");
        const before = probe.indexOf("probe-marker");
        expect(before).toBeGreaterThanOrEqual(0);
        const message = await call(straddling(form, 512 - before));
        expectNoFragment(message, form);
      },
    );
  }
});

describe("Overflow plain-text failures", () => {
  it.each(PROVIDER_ECHO_FORMS)(
    "INV-5: a plain-text 400 echoing the sent key %s across the 300-character cap leaks no fragment of it",
    async (_name, form) => {
      vi.stubGlobal("fetch", async () => new Response(straddling(form, 300), { status: 400 }));
      const keys: Record<string, string> = { clientId: "client-123", apiKey: SECRET };
      const ctx: ConnectorContext = {
        ...connectorContext(),
        credential: { get: async (field) => (field ? (keys[field] ?? null) : null), getAll: async () => keys },
      };
      const connector = overflow("giving", { environment: "production", purpose: "Giving" });
      const error = await refusal(
        connector.callTool("get_contribution", { contributionId: "0123456789abcdef01234567" }, ctx),
      );
      expectNoFragment(error.message, form);
    },
  );
});

describe("Cloudflare zone-ownership lookups", () => {
  it.each(PROVIDER_ECHO_FORMS)(
    "INV-5: a refused lookup echoing the sent token %s across the 500-character cap leaks no fragment of it",
    async (_name, form) => {
      vi.stubGlobal("fetch", async () =>
        Response.json(
          { success: false, errors: [{ code: 1000, message: straddling(form, 500) }], messages: [], result: null },
          { status: 400 },
        ),
      );
      const connector = cloudflare("cf", {
        purpose: "Ops",
        auth: { type: "apiToken" },
        pin: { accountIds: ["0123456789abcdef0123456789abcdef"] },
      });
      const zone = "023e105f4ecef8ad9ca31a8372d0c353";
      const error = await refusal(
        connector.callTool("cloudflare_api_read", { path: `/zones/${zone}/dns_records` }, keyed()),
      );
      expectNoFragment(error.message, form);
    },
  );
});

describe("Cloudflare GraphQL errors", () => {
  let transport: ReturnType<typeof installOwnedTransport>;
  beforeEach(() => {
    transport = installOwnedTransport();
  });

  it.each(PROVIDER_ECHO_FORMS)(
    "INV-5: a rejected query echoing the sent token %s across the 500-character cap leaks no fragment of it",
    async (_name, form) => {
      vi.stubGlobal("fetch", async () => Response.json({ data: null, errors: [{ message: straddling(form, 500) }] }));
      const connector = cloudflare("cf", { purpose: "Ops", auth: { type: "apiToken" } });
      const query = `query Daily { viewer { zones(filter: { zoneTag: "023e105f4ecef8ad9ca31a8372d0c353" }) { dimensions { date } } } }`;
      const error = await refusal(connector.callTool("graphql_query", { query }, keyed()));
      expectNoFragment(error.message, form);
      expect(transport.send).toHaveBeenCalledTimes(1);
    },
  );
});

describe("Breeze contribution dates", () => {
  it("INV-5: a paid_on that echoes the sent key is never cut to its first ten characters", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json([
        { id: "1", amount: "5.00", paid_on: SECRET },
        { id: "2", amount: "6.00", paid_on: "2026-01-02 03:04:05" },
      ]),
    );
    const connector = breeze("church", { subdomain: "gracechurch", purpose: "Pastoral care" });
    const result = (await connector.callTool(
      "list_contributions",
      { start: "2026-01-01", end: "2026-01-31" },
      keyed(),
    )) as {
      items: { paidOn?: string }[];
    };
    expect(result.items.map((row) => row.paidOn)).toEqual(["[redacted]", "2026-01-02"]);
  });
});

describe("open tails of bounded reads", () => {
  const secrets = () => {
    const set = new SentSecrets();
    set.add(SECRET);
    return set;
  };

  it.each(echoForms(SECRET))("INV-5: a read that stops inside the %s form loses that tail", (_name, form) => {
    // Include long prefixes as well as the one-unit cases in the fix-round suite.
    for (const end of [form.startsWith("\\u") ? 48 : 8, Math.floor(form.length / 2), form.length - 1]) {
      const text = `intro ${form.slice(0, end)}`;
      expect(secrets().redactOpenTail(text)).toBe("intro [redacted]");
    }
  });
});

describe("vendor-bounded text", () => {
  it.each(PROVIDER_ECHO_FORMS)(
    "INV-5: a title the vendor stopped listing inside the sent token %s shows no fragment of it",
    async (_name, form) => {
      vi.stubGlobal("fetch", async () => Response.json({ title: `intro ${head(form)}` }));
      const connector = api("notes", {
        credential: { label: "API token" },
        tools: [
          {
            name: "get_title",
            description: "Read a vendor-bounded title",
            inputSchema: { type: "object" },
            annotations: { readOnlyHint: true },
            handler: async (_args, ctx) => {
              const token = await ctx.credential!.get();
              const body = (await (
                await ctx.fetch("https://notes.example/title", { headers: { Authorization: `Bearer ${token}` } })
              ).json()) as { title: string };
              return { title: redactBoundedRead(ctx, body.title) };
            },
          },
        ],
      });
      const result = (await connector.callTool("get_title", {}, keyed())) as { title: string };
      expect(result.title).toBe("intro [redacted]");
    },
  );
});
