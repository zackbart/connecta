import { describe, expect, it, vi } from "vitest";
import { api } from "../src/connectors/api.js";
import type { ConnectaConfig } from "../src/index.js";
import type { AuthenticatedIdentity, InboundAuth } from "../src/types.js";
import { describeConfigSources } from "../src/config-value-sources.js";
import { memoryStorage } from "../src/storage/memory.js";
import { createTestConnecta, silentLogger } from "./helpers.js";
import { mcpRpc, readJsonRpc } from "./fixtures/http.js";
import { scriptedExecutor } from "./fixtures/misc.js";

const BASE = "https://connecta.test";
const METADATA = "/.well-known/oauth-protected-resource";

function deployment(options: Partial<Parameters<typeof createTestConnecta>[0]> = {}) {
  const auth: InboundAuth = {
    kind: "test",
    authorize(request) {
      const id = /^Bearer (human|agent)$/.exec(request.headers.get("Authorization") ?? "")?.[1];
      return id ? { ok: true, subjectId: id } : { ok: false, response: new Response(null, { status: 401 }) };
    },
    handleMetadata(request) {
      const path = new URL(request.url).pathname;
      return path === METADATA || path.startsWith(`${METADATA}/mcp`)
        ? Response.json({ resource: `${BASE}${path.slice(METADATA.length) || "/mcp"}` })
        : null;
    },
  };
  return createTestConnecta({
    connectors: [
      api("docs", {
        tools: [
          {
            name: "read",
            description: "Read docs",
            annotations: { readOnlyHint: true },
            handler: () => "x".repeat(500),
          },
        ],
      }),
    ],
    auth,
    publicUrl: BASE,
    logger: silentLogger,
    pools: {
      allowed: { tools: ["docs"], grant: () => true },
      refused: { tools: ["docs"], grant: () => false },
    },
    ...options,
  });
}

const rpc = (app: ReturnType<typeof deployment>, pool?: string, token = "human") =>
  mcpRpc(app, "tools/list", {}, { ...(pool ? { pool } : {}), token });

async function wire(response: Response) {
  return {
    status: response.status,
    headers: [...response.headers].sort(),
    body: [...new Uint8Array(await response.arrayBuffer())],
  };
}

describe("default endpoint grant", () => {
  it.each([undefined, () => true, async () => true])(
    "INV-4: admits /mcp with an omitted or literal-true grant: %s",
    async (grant) => {
      const app = deployment({ grant });
      try {
        const response = await rpc(app);
        expect(response.status).toBe(200);
        expect((await readJsonRpc(response)).result.tools.map((tool: { name: string }) => tool.name)).toContain(
          "call_tool",
        );
      } finally {
        await app.close();
      }
    },
  );

  it("INV-4 INV-6: refuses /mcp byte-identically to pools after auth and still admits a granting pool", async () => {
    const grant = vi.fn((identity: Readonly<AuthenticatedIdentity>) => identity.subject?.id === "human");
    const warn = vi.fn();
    const app = deployment({ grant, logger: { ...silentLogger, warn } });
    try {
      const denied = await wire(await rpc(app, undefined, "agent"));
      expect(denied.status).toBe(404);
      for (const pool of ["refused", "missing"]) expect(await wire(await rpc(app, pool, "agent"))).toEqual(denied);
      expect(warn.mock.calls.flat()).toContainEqual(expect.objectContaining({ reason: "default_grant_denied" }));
      grant.mockClear();
      const allowed = await rpc(app, "allowed", "agent");
      expect(allowed.status).toBe(200);
      await allowed.arrayBuffer();
      expect(grant).not.toHaveBeenCalled();
      const unauthenticated = await mcpRpc(app, "tools/list", {});
      expect(unauthenticated.status).toBe(401);
      await unauthenticated.arrayBuffer();
      expect(grant).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it.each([false, undefined, null, 1, "true", {}, []].map((value) => ({ value })))(
    "INV-4: denies a non-true grant return: $value",
    async ({ value }) => {
      const app = deployment({ grant: (async () => value) as ConnectaConfig["grant"] });
      try {
        expect(await wire(await rpc(app))).toEqual(await wire(await rpc(app, "refused")));
        expect(
          await wire(
            await app.fetch(new Request(`${BASE}${METADATA}`, { headers: { Authorization: "Bearer human" } })),
          ),
        ).toEqual(await wire(await rpc(app, "refused")));
      } finally {
        await app.close();
      }
    },
  );

  it.each([false, true])(
    "INV-4 INV-6: a throwing grant denies without logging its error, async=%s",
    async (asyncThrow) => {
      const warn = vi.fn();
      const fail = () => {
        throw new Error("private-grant-error");
      };
      const app = deployment({ grant: asyncThrow ? async () => fail() : fail, logger: { ...silentLogger, warn } });
      try {
        expect(await wire(await rpc(app))).toEqual(await wire(await rpc(app, "refused")));
        expect(
          await wire(
            await app.fetch(new Request(`${BASE}${METADATA}`, { headers: { Authorization: "Bearer human" } })),
          ),
        ).toEqual(await wire(await rpc(app, "refused")));
        expect(warn.mock.calls.flat()).toContainEqual(expect.objectContaining({ reason: "default_grant_threw" }));
        expect(JSON.stringify(warn.mock.calls)).not.toContain("private-grant-error");
      } finally {
        await app.close();
      }
    },
  );

  it.each([null, true, false, "grant", 42, {}, []].map((grant) => ({ grant })))(
    "INV-11: rejects an invalid top-level grant at construction: $grant",
    ({ grant }) => {
      expect(() => deployment({ grant: grant as unknown as ConnectaConfig["grant"] })).toThrow("ConnectaConfig.grant");
    },
  );

  it.each([METADATA, `${METADATA}/mcp`])(
    "INV-4: applies the grant to default protected-resource metadata: %s",
    async (path) => {
      const grant = vi.fn((identity: Readonly<AuthenticatedIdentity>) => identity.subject?.id === "human");
      const app = deployment({ grant });
      const metadata = (token?: string) =>
        app.fetch(new Request(`${BASE}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} }));
      try {
        expect(await wire(await metadata("agent"))).toEqual(await wire(await rpc(app, "refused", "agent")));
        expect(await (await metadata("human")).json()).toEqual({ resource: `${BASE}/mcp` });
        grant.mockClear();
        const anonymous = await metadata();
        expect(anonymous.status).toBe(401);
        await anonymous.arrayBuffer();
        expect(grant).not.toHaveBeenCalled();
        const pool = await app.fetch(new Request(`${BASE}${METADATA}/mcp/allowed`));
        expect(pool.status).toBe(200);
        await pool.arrayBuffer();
        expect(grant).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    },
  );

  it("INV-4: authenticates protected-resource metadata against the MCP endpoint audience", async () => {
    const authorize = vi.fn((request: Request) => {
      expect(new URL(request.url).pathname).toBe("/mcp");
      expect(request.headers.get("Authorization")).toBe("Bearer human");
      return { ok: true as const, subjectId: "human" };
    });
    const app = deployment({
      grant: () => true,
      auth: { kind: "audience-check", authorize, handleMetadata: () => Response.json({ resource: `${BASE}/mcp` }) },
    });
    try {
      const response = await app.fetch(
        new Request(`${BASE}${METADATA}/mcp`, { headers: { Authorization: "Bearer human" } }),
      );
      expect(await response.json()).toEqual({ resource: `${BASE}/mcp` });
      expect(authorize).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it("INV-4: keeps metadata public when no default grant is configured", async () => {
    const app = deployment();
    try {
      expect(await (await app.fetch(new Request(`${BASE}${METADATA}`))).json()).toEqual({ resource: `${BASE}/mcp` });
    } finally {
      await app.close();
    }
  });

  it("INV-4: binds result handles to their endpoint and rechecks the default grant when paging", async () => {
    let allowed = true;
    let revokeInProgram = false;
    let resultId = "";
    const app = deployment({
      grant: () => allowed,
      storage: memoryStorage(),
      calls: { maxResultBytes: 100 },
      executor: scriptedExecutor(async (fns) => {
        if (revokeInProgram) allowed = false;
        return fns.result!(resultId, { maxBytes: 100 });
      }),
    });
    const call = async (name: string, args: object, pool?: string) =>
      (
        await readJsonRpc(
          await mcpRpc(app, "tools/call", { name, arguments: args }, { token: "human", ...(pool ? { pool } : {}) }),
        )
      ).result;
    const page = (pool?: string) => call("execute_code", { code: "return await connecta.result(id)" }, pool);
    try {
      for (const pool of [undefined, "allowed"]) {
        const original = await call("call_tool", { address: "docs.read" }, pool);
        resultId = JSON.parse(original.content[0].text.split("\n")[0]).resultId;
        expect(resultId).toBeTypeOf("string");
        expect((await page(pool)).isError).toBeFalsy();
        expect((await page(pool === undefined ? "allowed" : undefined)).isError).toBe(true);
      }
      resultId = JSON.parse(
        (await call("call_tool", { address: "docs.read" })).content[0].text.split("\n")[0],
      ).resultId;
      revokeInProgram = true;
      expect((await page()).isError).toBe(true);
      expect((await wire(await rpc(app))).status).toBe(404);
      expect((await page("allowed")).isError).toBe(true);
    } finally {
      await app.close();
    }
  });

  it.each([undefined, () => false])(
    "INV-4 INV-10: describes grant presence without evaluating it: %s",
    async (configured) => {
      const grant = configured ? vi.fn(configured) : undefined;
      const app = deployment({ grant });
      try {
        expect(app.describeConfig().hasGrant).toBe(Boolean(grant));
        const raw = { readOnly: false, connectors: [], executor: {} as ConnectaConfig["executor"], grant };
        expect(describeConfigSources(app.describeConfig(), raw)["config.hasGrant"]).toBe(grant ? "config" : "default");
        const ui = await app.fetch(
          new Request(`${BASE}/ui/api/config`, { headers: { Authorization: "Bearer human" } }),
        );
        expect((await ui.json()) as object).toHaveProperty("config.hasGrant", Boolean(grant));
        if (grant) expect(grant).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    },
  );
});
