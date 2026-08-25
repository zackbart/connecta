import { describe, expect, it } from "vitest";
import { api } from "../src/connectors/api.js";
import { memoryStorage } from "../src/storage/memory.js";
import { isExplicitlyReadOnly } from "../src/tool-safety.js";
import type { Connector, ToolDef } from "../src/types.js";
import { createTestConnecta } from "./helpers.js";
import {
  fakeClerkAuth,
  makeDeployment,
  mcpRpc,
  readJsonRpc,
} from "./fixtures/http.js";

/**
 * The operator boundary, enforced rather than asserted in prose (#338).
 *
 * Operator routes may manage authentication material for capabilities the
 * deployment already declares. They may not change the connector set, the
 * declared tool catalog or its annotations, the admission policy, or the
 * caller's tool scope — those take an edit and a redeploy. So: snapshot every
 * declared structure, drive every operator mutation route, and demand the
 * snapshot come back byte-identical.
 *
 * The snapshot has to be able to move, or it proves nothing. `api()` sets
 * `staticTools`, and every Registry read path short-circuits on it, so a
 * catalog built from `api()` alone is the same frozen array whatever a route
 * does. The fixture set therefore includes a connector that declares its tools
 * through `listTools`, and the deployment runs with a zero catalog TTL, so
 * every snapshot below is a live load through the cache and through
 * `invalidateStored()` — the one path on which a catalog could actually move.
 */

const BASE = "https://connecta.test";
const OPERATOR_TOKEN = "clerk-operator";
const CREDENTIAL_KEY = btoa("0123456789abcdef0123456789abcdef");

type Deployment = ReturnType<typeof createTestConnecta>;

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
          annotations: { readOnlyHint: false },
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

/**
 * A live catalog rather than a frozen one. `listTools` is the only shape whose
 * result travels through the cache and through `invalidateStored()`, so this
 * connector is what makes the snapshot falsifiable. Its catalog is
 * deliberately credential-independent — it reads the stored credential and
 * ignores it — because that is what the invariant claims about a catalog
 * connecta itself declares.
 */
function dynamicConnector(catalog: { listings: number }): Connector {
  const tools: ToolDef[] = [
    {
      name: "search",
      description: "Search gamma",
      inputSchema: { type: "object", additionalProperties: false },
      annotations: { readOnlyHint: true },
    },
    {
      name: "update",
      description: "Update gamma",
      inputSchema: { type: "object", additionalProperties: false },
    },
  ];
  return {
    id: "gamma",
    kind: "api",
    description: "Gamma connector",
    credential: { label: "API token" },
    callAdmission: { rules: [{ maxConcurrency: 1 }], maxPartitions: 4 },
    async listTools(ctx) {
      catalog.listings += 1;
      await ctx.credential?.get();
      return tools;
    },
    async callTool() {
      return {};
    },
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

function boundaryConfig(connectors: Connector[]) {
  return {
    connectors,
    auth: [fakeClerkAuth({ token: OPERATOR_TOKEN })],
    storage: memoryStorage(),
    accessTokens: {},
    credentials: { encryptionKey: CREDENTIAL_KEY },
    publicUrl: BASE,
    // No cached catalog may stand in for a live one here: a TTL would let a
    // dynamic connector's tools be served from memory and quietly turn this
    // suite back into a comparison of two frozen arrays.
    discovery: { catalogTtlSeconds: 0 },
  };
}

async function callerRpc(
  connecta: Deployment,
  method: string,
  token: string,
): Promise<unknown> {
  const response = await mcpRpc(connecta, method, {}, { token });
  expect(response.status, method).toBe(200);
  return readJsonRpc(response) as Promise<unknown>;
}

/** Exactly what a caller may call: the tool list `/mcp` serves that caller. */
async function callerToolScope(
  connecta: Deployment,
  token: string,
): Promise<unknown> {
  const body = (await callerRpc(connecta, "tools/list", token)) as {
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

type Mutation = {
  label: string;
  run: () => Promise<Response>;
  status: number;
};

/** Every connector-scoped operator route, driven against one connector. */
function credentialAndOAuthMutations(
  connecta: Deployment,
  id: string,
): Mutation[] {
  return [
    {
      label: `${id}: credential set`,
      status: 200,
      run: () =>
        connecta.fetch(
          new Request(`${BASE}/ui/credentials/${id}`, {
            method: "PUT",
            headers: operatorHeaders(),
            body: JSON.stringify({ value: "first-token-1234" }),
          }),
        ),
    },
    {
      label: `${id}: credential rotate`,
      status: 200,
      run: () =>
        connecta.fetch(
          new Request(`${BASE}/ui/credentials/${id}`, {
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
      label: `${id}: downstream OAuth start`,
      status: 200,
      run: () =>
        connecta.fetch(
          new Request(`${BASE}/ui/oauth/${id}`, {
            method: "POST",
            headers: operatorHeaders(),
          }),
        ),
    },
    {
      label: `${id}: downstream OAuth completion`,
      status: 200,
      run: () =>
        connecta.fetch(
          new Request(
            `${BASE}/oauth/callback/${id}?code=auth-code&state=valid-state`,
          ),
        ),
    },
    {
      label: `${id}: downstream OAuth disconnect`,
      status: 204,
      run: () =>
        connecta.fetch(
          new Request(`${BASE}/ui/oauth/${id}`, {
            method: "DELETE",
            headers: operatorHeaders(),
          }),
        ),
    },
    {
      label: `${id}: credential delete`,
      status: 204,
      run: () =>
        connecta.fetch(
          new Request(`${BASE}/ui/credentials/${id}`, {
            method: "DELETE",
            headers: operatorHeaders(),
          }),
        ),
    },
  ];
}

describe("the operator boundary", () => {
  it("manages authentication material without moving a declared structure", async () => {
    const catalog = { listings: 0 };
    const connecta = makeDeployment(boundaryConfig([
      oauthConnector(),
      plainConnector(),
      dynamicConnector(catalog),
    ]));
    const before = await declaredSurface(connecta, OPERATOR_TOKEN);
    // A snapshot that silently captured nothing would pass every comparison
    // below, so establish that it holds all three connectors, both safety
    // classes, a live catalog, and the caller's whole tool scope before
    // anything mutates.
    expect((await callerToolScope(connecta, OPERATOR_TOKEN)) as unknown[])
      .toHaveLength(7);
    expect(catalog.listings).toBeGreaterThan(0);
    for (const marker of [
      '"id": "alpha"',
      '"id": "beta"',
      '"id": "gamma"',
      '"name": "search"',
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

    const mutations: Mutation[] = [
      // `alpha` declares a static catalog, `gamma` a dynamic one; every
      // connector-scoped route runs against both, so each one is measured
      // against a catalog that `invalidateStored()` really re-loads.
      ...credentialAndOAuthMutations(connecta, "alpha"),
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
      ...credentialAndOAuthMutations(connecta, "gamma"),
      {
        label: "access token rename",
        status: 200,
        run: () =>
          connecta.fetch(
            new Request(`${BASE}/ui/access-tokens/${issuedTokenId}`, {
              method: "PUT",
              headers: operatorHeaders(),
              body: JSON.stringify({ name: "Claude desktop, renamed" }),
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
    ];

    for (const mutation of mutations) {
      const response = await mutation.run();
      // A route that 404s or 403s proves nothing, so pin the success status
      // before reading anything into the snapshot that follows it.
      expect(response.status, mutation.label).toBe(mutation.status);
      await response.arrayBuffer();
      const listedBefore = catalog.listings;
      const after = await declaredSurface(connecta, OPERATOR_TOKEN);
      // The comparison is only worth making if the catalog it compares was
      // re-read: `gamma` lists dynamically and the TTL is zero, so a snapshot
      // that did not call `listTools` again was served from somewhere frozen.
      expect(catalog.listings, mutation.label).toBeGreaterThan(listedBefore);
      if (after !== before) drifted.push(mutation.label);

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

  it("notices when a credential write moves a catalog", async () => {
    // The guard above is only worth its runtime if the snapshot can fail, so
    // here is a catalog that does move on a credential write, caught by the
    // same comparison.
    //
    // This is not a rogue connector: it is what every `mcp()` connector does.
    // A remote MCP server's tools are fetched after the connection
    // authenticates, so storing a credential takes that catalog from empty to
    // N — which is why the credential and OAuth routes call
    // `invalidateStored()` in the first place. That catalog is *discovered*,
    // not declared, and the invariant is about the declared kind; what this
    // test proves is only that the instrument has a needle.
    const read: ToolDef = {
      name: "read",
      description: "Read from drifting",
      inputSchema: { type: "object", additionalProperties: false },
      annotations: { readOnlyHint: true },
    };
    const drifting: Connector = {
      id: "drifting",
      kind: "api",
      description: "Grows its catalog once a credential is stored",
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
    const connecta = makeDeployment(boundaryConfig([drifting]));
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
