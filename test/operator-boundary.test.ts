import { describe, expect, it } from "vitest";
import { api } from "../src/connectors/api.js";
import { memoryStorage } from "../src/storage/memory.js";
import { isExplicitlyReadOnly } from "../src/tool-safety.js";
import type { Connector, InboundAuth, ToolDef } from "../src/types.js";
import { createTestConnecta } from "./helpers.js";

/**
 * The operator boundary, enforced rather than asserted in prose (#338).
 *
 * Operator routes may manage authentication material for capabilities the
 * deployment already declares. They may not change the connector set, the tool
 * catalog or its annotations, the admission policy, or the caller's tool
 * scope — those take an edit and a redeploy. So: snapshot every declared
 * structure, drive every operator mutation route, and demand the snapshot come
 * back byte-identical.
 */

const BASE = "https://connecta.test";
const OPERATOR_TOKEN = "clerk-operator";
const CREDENTIAL_KEY = btoa("0123456789abcdef0123456789abcdef");

type Deployment = ReturnType<typeof createTestConnecta>;

function fakeClerkOperator(): InboundAuth {
  return {
    kind: "clerk",
    uiAuth: {
      kind: "clerk",
      publishableKey: "pk_test_fake",
      frontendApiUrl: "https://clerk.example.test",
    },
    authorize(request) {
      return request.headers.get("authorization") ===
        `Bearer ${OPERATOR_TOKEN}`
        ? { ok: true, userId: "user_operator" }
        : {
            ok: false,
            response: Response.json({ error: "unauthorized" }, { status: 401 }),
          };
    },
  };
}

/** Credential slot, downstream OAuth, an admission policy, and both safety classes. */
function oauthConnector(): Connector {
  return {
    ...api("alpha", {
      description: "Alpha connector",
      credential: { label: "API token" },
      callAdmission: { rules: [{ maxConcurrency: 2 }], maxPartitions: 8 },
      tools: [
        {
          name: "read",
          description: "Read from alpha",
          inputSchema: { type: "object", additionalProperties: false },
          annotations: { readOnlyHint: true },
          handler: async () => ({ ok: true }),
        },
        {
          name: "write",
          description: "Write to alpha",
          inputSchema: { type: "object", additionalProperties: false },
          handler: async () => ({ ok: true }),
        },
      ],
    }),
    async startAuth() {
      return {
        state: "auth_required",
        authorizationUrl: "https://provider.example/authorize",
      };
    },
    async disconnectAuth() {},
    async verifyState(state) {
      return state === "valid-state";
    },
    async finishAuth() {},
  };
}

function plainConnector(): Connector {
  return api("beta", {
    description: "Beta connector",
    tools: [
      {
        name: "list",
        description: "List beta records",
        inputSchema: { type: "object", additionalProperties: false },
        annotations: { readOnlyHint: true },
        handler: async () => [],
      },
    ],
  });
}

function makeConnecta(connectors: Connector[]): Deployment {
  return createTestConnecta({
    connectors,
    auth: [fakeClerkOperator()],
    storage: memoryStorage(),
    accessTokens: {},
    credentials: { encryptionKey: CREDENTIAL_KEY },
    publicUrl: BASE,
  });
}

let nextId = 0;
async function rpc(
  connecta: Deployment,
  method: string,
  token: string,
): Promise<unknown> {
  const response = await connecta.fetch(
    new Request(`${BASE}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++nextId,
        method,
        params: {},
      }),
    }),
  );
  expect(response.status, method).toBe(200);
  const text = await response.text();
  const payload = (response.headers.get("content-type") ?? "").includes(
    "text/event-stream",
  )
    ? text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .pop()
        ?.slice("data:".length)
        .trim()
    : text;
  return JSON.parse(payload ?? "null") as unknown;
}

/** Exactly what a caller may call: the tool list `/mcp` serves that caller. */
async function callerToolScope(
  connecta: Deployment,
  token: string,
): Promise<unknown> {
  const body = (await rpc(connecta, "tools/list", token)) as {
    result?: { tools?: unknown };
  };
  return body.result?.tools;
}

function describeTool(tool: ToolDef) {
  return {
    name: tool.name,
    description: tool.description ?? null,
    inputSchema: tool.inputSchema ?? null,
    outputSchema: tool.outputSchema ?? null,
    annotations: tool.annotations ?? null,
    // The destructive boundary is derived from annotations, so it is a
    // declared structure too: a route that quietly promoted a tool to
    // read-only would widen the sandbox without touching the catalog.
    readOnly: isExplicitlyReadOnly(tool),
  };
}

/**
 * Every structure an operator route must leave alone, rendered as text so the
 * comparison is byte-for-byte rather than "deeply equal enough".
 */
async function declaredSurface(
  connecta: Deployment,
  token: string,
): Promise<string> {
  const connectors = [];
  for (const connector of [...connecta.registry.listConnectors()].sort(
    (a, b) => a.id.localeCompare(b.id),
  )) {
    const tools = await connecta.registry.getTools(connector.id, BASE);
    connectors.push({
      id: connector.id,
      kind: connector.kind ?? null,
      title: connector.title ?? null,
      description: connector.description ?? null,
      credential: connector.credential ?? null,
      admission: connector.callAdmission ?? null,
      maxResultBytes: connector.maxResultBytes ?? null,
      tools: tools.map(describeTool),
    });
  }
  return JSON.stringify(
    { connectors, callerToolScope: await callerToolScope(connecta, token) },
    null,
    2,
  );
}

function operatorHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${OPERATOR_TOKEN}`,
    Origin: BASE,
    "Content-Type": "application/json",
  };
}

describe("the operator boundary", () => {
  it("manages authentication material without moving a declared structure", async () => {
    const connecta = makeConnecta([oauthConnector(), plainConnector()]);
    const before = await declaredSurface(connecta, OPERATOR_TOKEN);
    // A snapshot that silently captured nothing would pass every comparison
    // below, so establish that it holds both connectors, both safety classes,
    // and the caller's whole tool scope before anything mutates.
    expect((await callerToolScope(connecta, OPERATOR_TOKEN)) as unknown[])
      .toHaveLength(7);
    for (const marker of [
      '"id": "alpha"',
      '"id": "beta"',
      '"readOnly": true',
      '"readOnly": false',
      '"execute_code"',
    ]) {
      expect(before, marker).toContain(marker);
    }

    // Recorded as the mutations run so a failure names the route that moved.
    const drifted: string[] = [];
    let issuedTokenId = "";
    let issuedTokenSecret = "";

    const mutations: Array<{
      label: string;
      run: () => Promise<Response>;
      status: number;
    }> = [
      {
        label: "credential set",
        status: 200,
        run: () =>
          connecta.fetch(
            new Request(`${BASE}/ui/credentials/alpha`, {
              method: "PUT",
              headers: operatorHeaders(),
              body: JSON.stringify({ value: "first-token-1234" }),
            }),
          ),
      },
      {
        label: "credential rotate",
        status: 200,
        run: () =>
          connecta.fetch(
            new Request(`${BASE}/ui/credentials/alpha`, {
              method: "PUT",
              headers: operatorHeaders(),
              // A replacement token may reach further downstream than the one
              // it replaces. That is the provider's grant, not connecta's
              // declaration — which is precisely why this test measures the
              // declaration.
              body: JSON.stringify({ value: "broader-token-5678" }),
            }),
          ),
      },
      {
        label: "access token issue",
        status: 201,
        run: async () => {
          const response = await connecta.fetch(
            new Request(`${BASE}/ui/access-tokens`, {
              method: "POST",
              headers: operatorHeaders(),
              body: JSON.stringify({ name: "Claude desktop" }),
            }),
          );
          const issued = (await response.clone().json()) as {
            token: string;
            accessToken: { id: string };
          };
          issuedTokenId = issued.accessToken.id;
          issuedTokenSecret = issued.token;
          return response;
        },
      },
      {
        label: "downstream OAuth start",
        status: 200,
        run: () =>
          connecta.fetch(
            new Request(`${BASE}/ui/oauth/alpha`, {
              method: "POST",
              headers: operatorHeaders(),
            }),
          ),
      },
      {
        label: "downstream OAuth completion",
        status: 200,
        run: () =>
          connecta.fetch(
            new Request(
              `${BASE}/oauth/callback/alpha?code=auth-code&state=valid-state`,
            ),
          ),
      },
      {
        label: "downstream OAuth disconnect",
        status: 204,
        run: () =>
          connecta.fetch(
            new Request(`${BASE}/ui/oauth/alpha`, {
              method: "DELETE",
              headers: operatorHeaders(),
            }),
          ),
      },
      {
        label: "access token revoke",
        status: 200,
        run: () =>
          connecta.fetch(
            new Request(`${BASE}/ui/access-tokens/${issuedTokenId}`, {
              method: "DELETE",
              headers: operatorHeaders(),
            }),
          ),
      },
      {
        label: "credential delete",
        status: 204,
        run: () =>
          connecta.fetch(
            new Request(`${BASE}/ui/credentials/alpha`, {
              method: "DELETE",
              headers: operatorHeaders(),
            }),
          ),
      },
    ];

    for (const mutation of mutations) {
      const response = await mutation.run();
      // A route that 404s or 403s proves nothing, so pin the success status
      // before reading anything into the snapshot that follows it.
      expect(response.status, mutation.label).toBe(mutation.status);
      await response.arrayBuffer();
      if ((await declaredSurface(connecta, OPERATOR_TOKEN)) !== before) {
        drifted.push(mutation.label);
      }

      // An issued access token identifies a caller; it never scopes one. The
      // scope it sees is the scope the operator sees, for as long as it lives.
      if (mutation.label === "access token issue") {
        expect(await callerToolScope(connecta, issuedTokenSecret)).toEqual(
          await callerToolScope(connecta, OPERATOR_TOKEN),
        );
      }
    }

    expect(drifted).toEqual([]);
    expect(await declaredSurface(connecta, OPERATOR_TOKEN)).toBe(before);
    await connecta.close();
  });

  it("notices when a credential write does widen the declared catalog", async () => {
    // The guard above is only worth its runtime if the snapshot can fail. This
    // connector deliberately breaks the invariant — its catalog grows once a
    // credential exists — and the same comparison must catch it.
    const read: ToolDef = {
      name: "read",
      description: "Read from drifting",
      inputSchema: { type: "object", additionalProperties: false },
      annotations: { readOnlyHint: true },
    };
    const drifting: Connector = {
      id: "drifting",
      kind: "api",
      description: "Widens its catalog once a credential is stored",
      credential: { label: "API token" },
      async listTools(ctx) {
        const stored = await ctx.credential?.get();
        return stored
          ? [read, { ...read, name: "read_more", description: "Read more" }]
          : [read];
      },
      async callTool() {
        return {};
      },
    };
    const connecta = makeConnecta([drifting]);
    const before = await declaredSurface(connecta, OPERATOR_TOKEN);

    const stored = await connecta.fetch(
      new Request(`${BASE}/ui/credentials/drifting`, {
        method: "PUT",
        headers: operatorHeaders(),
        body: JSON.stringify({ value: "first-token-1234" }),
      }),
    );
    expect(stored.status).toBe(200);

    const after = await declaredSurface(connecta, OPERATOR_TOKEN);
    expect(after).not.toBe(before);
    expect(after).toContain("read_more");
    await connecta.close();
  });
});
