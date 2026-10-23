import { vi } from "vitest";
import { z } from "zod";
import { github,type GitHubOptions } from "../../src/providers/github/index.js";
import type { ConnectorContext } from "../../src/types.js";
import { httpDownstream } from "./downstream-mcp.js";
import { connectorContext } from "./misc.js";

const keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keys.privateKey) as ArrayBuffer);
export const PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----`;
export const PUBLIC_KEY = keys.publicKey;
export const SENTINEL = "GITHUB_SECRET_ERROR_SENTINEL";
export const SCOPES: GitHubOptions["scopes"] = [
  { org: "acme", access: "read-write" },
  { repo: "acme/locked", access: "read" },
  { repo: "other/one", access: "read-write" },
  { repo: "other/readonly", access: "read" },
];
export function connection(overrides: Partial<GitHubOptions> = {}) {
  return github("github", { purpose: "Engineering", app: { appId: "12345", privateKey: PRIVATE_KEY }, scopes: SCOPES, ...overrides });
}
export function context(overrides: Partial<ConnectorContext> = {}): ConnectorContext {
  return { ...connectorContext(), ...overrides };
}
export interface Exchange { url: URL; method: string; headers: Headers; body?: any; signal?: AbortSignal | null | undefined }

export function apiFixture() {
  const requests: Exchange[] = [];
  const tokens: { installation: string; value: string; body: any }[] = [];
  const resolverTokens: typeof tokens = [];
  let repositories = [
    { id: 101, full_name: "acme/one" }, { id: 102, full_name: "acme/locked" },
    { id: 103, full_name: "acme/future" }, { id: 104, full_name: "acme/two" },
    { id: 201, full_name: "other/one" }, { id: 202, full_name: "other/readonly" },
    { id: 203, full_name: "other/two" },
  ];
  const redirects = new Map<string, number>();
  let installations: any[] = [
    { id: 11, account: { login: "acme", type: "Organization" }, repository_selection: "all", suspended_at: null },
    { id: 22, account: { login: "other", type: "User" }, repository_selection: "selected", suspended_at: null },
    { id: 33, account: { login: "unconfigured", type: "Organization" }, repository_selection: "all", suspended_at: null },
  ];
  let respond: ((request: Exchange) => Promise<Response | undefined> | Response | undefined) | undefined;
  const mcp = httpDownstream((server) => {
    for (const name of ["get_file_contents"]) {
      server.registerTool(name, { description: `Use ${name}`, inputSchema: z.object({ owner: z.string().optional(), repo: z.string().optional() }).passthrough(), annotations: { readOnlyHint: true } },
        async () => ({ content: [{ type: "text", text: '{"ok":true}' }], structuredContent: { ok: true } }));
    }
  }, { url: "https://api.githubcopilot.com/mcp/" });
  const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const body: any = request.method === "POST" || request.method === "PUT" || request.method === "PATCH" ? await request.clone().json() : undefined;
    const exchange = { url: new URL(request.url), method: request.method, headers: request.headers, body, signal: init?.signal };
    requests.push(exchange);
    const custom = await respond?.(exchange);
    if (custom) return custom;
    if (exchange.url.origin === "https://api.githubcopilot.com") {
      return mcp.fetch(request.url, { method: request.method, headers: request.headers, ...(init?.body !== undefined ? { body: init.body } : {}), ...(init?.signal ? { signal: init.signal } : {}) });
    }
    if (exchange.url.pathname === "/app/installations") return Response.json(installations);
    const mint = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(exchange.url.pathname);
    if (mint) {
      const value = `ghs_fixture_${mint[1]}_${tokens.length + resolverTokens.length}`;
      const list = !body.repository_ids && Object.keys(body.permissions).join() === "metadata" ? resolverTokens : tokens;
      list.push({ installation: mint[1]!, value, body });
      return Response.json({ token: value, expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    }
    if (exchange.url.pathname === "/installation/repositories") {
      const bearer = exchange.headers.get("authorization")!.slice(7);
      const token = [...tokens, ...resolverTokens].find((entry) => entry.value === bearer)!;
      const owner = token.installation === "11" || token.installation === "44" ? "acme" : "other";
      const visible = repositories.filter((repo) => repo.full_name.startsWith(`${owner}/`) && (!token.body.repository_ids || token.body.repository_ids.includes(repo.id)));
      return Response.json({ repositories: visible });
    }
    const repo = repositories.find((entry) => `/repos/${entry.full_name}` === exchange.url.pathname);
    if (repo) return Response.json(repo);
    if (exchange.url.pathname.startsWith("/search/")) return Response.json({ items: [], total_count: 0, incomplete_results: false });
    return Response.json({ id: 1, ok: true });
  });
  vi.stubGlobal("fetch", fetchStub);
  return {
    requests, tokens, resolverTokens, fetchStub,
    repositories(value: typeof repositories) { repositories = value; },
    rename(id: number, fullName: string) {
      const repo = repositories.find((entry) => entry.id === id)!;
      redirects.set(repo.full_name, id);
      repo.full_name = fullName;
    },
    installations(value: any[]) { installations = value; },
    respond(callback: typeof respond) { respond = callback; },
  };
}
