// The GitHub provider is composed: hosted remote MCP plus Connecta's REST
// complement. Only the REST complement is an api() surface, so this golden
// builds that connector directly over the provider's own App auth and scope
// policy. App JWT installation listing, installation-token minting, and the
// metadata-only repository resolution AppAuth performs are auxiliary.
import { AppAuth, type GitHubApp } from "../../../src/providers/github/auth.js";
import { restConnector } from "../../../src/providers/github/rest.js";
import { parseScopes, ScopePolicy, type GitHubScope } from "../../../src/providers/github/scope.js";
import { defineGoldenSpec, type SeenRequest, type StubResponse } from "../harness.js";

// An App JWT is recorded decoded, with its signature as a placeholder, so a
// fresh key per run leaves every golden byte unchanged.
const keys = (await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
)) as CryptoKeyPair;
const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", keys.privateKey)) as ArrayBuffer);
const PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----`;

const APP: GitHubApp = { appId: "12345", privateKey: PRIVATE_KEY };
const SCOPES: GitHubScope[] = [
  { org: "acme", access: "read-write" },
  { repo: "other/one", access: "read-write", workflows: "write" },
  { repo: "other/readonly", access: "read" },
];

const INSTALLATIONS = [
  { id: 11, account: { login: "acme", type: "Organization" }, repository_selection: "all", suspended_at: null },
  { id: 22, account: { login: "other", type: "User" }, repository_selection: "selected", suspended_at: null },
];
const REPOSITORIES: Record<string, { id: number; full_name: string; private: boolean }[]> = {
  "11": [
    { id: 101, full_name: "acme/one", private: false },
    { id: 102, full_name: "acme/two", private: true },
  ],
  "22": [
    { id: 201, full_name: "other/one", private: false },
    { id: 202, full_name: "other/readonly", private: true },
  ],
};
const EXPIRES_AT = "2026-01-02T04:04:05Z";

interface MintBody {
  permissions: Record<string, string>;
  repository_ids?: number[];
}

/** A distinct, descriptive installation token per installation, permission set and repository set. */
function tokenFor(installation: string, body: MintBody): string {
  const permissions = Object.entries(body.permissions)
    .map(([name, level]) => `${name}-${level}`)
    .join("_");
  return `ghs_golden_${installation}_${permissions}${body.repository_ids ? `_repos-${body.repository_ids.join("-")}` : ""}/+=`;
}

/** The token a search scoped to other/one sends: the one its echo fixture echoes. */
const SEARCH_TOKEN = tokenFor("22", { permissions: { metadata: "read" }, repository_ids: [201] });

const json = (request: SeenRequest): unknown => (request.body as { json?: unknown } | undefined)?.json;
const MINT = /^\/app\/installations\/(\d+)\/access_tokens$/;
/** AppAuth's resolver token: metadata-only and unbound to repositories. */
const RESOLVER = /^Bearer ghs_golden_(\d+)_metadata-read\/\+=$/;

const release = (id: number, tag: string, draft: boolean) => ({
  id,
  tag_name: tag,
  target_commitish: "main",
  name: `Release ${tag}`,
  body: "Bug fixes and performance improvements.",
  draft,
  prerelease: false,
  html_url: `https://github.com/other/one/releases/tag/${tag}`,
  author: { login: "alice", id: 1 },
});

const search = (items: unknown[]): StubResponse => ({
  body: { total_count: items.length, incomplete_results: false, items },
});

export default defineGoldenSpec({
  provider: "github",
  create: () => {
    const policy = new ScopePolicy(parseScopes(SCOPES));
    return restConnector("github", new AppAuth(APP, policy), policy);
  },
  secrets: { privateKey: PRIVATE_KEY, installationToken: SEARCH_TOKEN },
  auxiliary: [
    {
      name: "installations",
      match: (request) => request.method === "GET" && request.url.pathname === "/app/installations",
      reply: { body: INSTALLATIONS },
    },
    {
      name: "installation-token",
      match: (request) => request.method === "POST" && MINT.test(request.url.pathname),
      reply: (request) => ({
        status: 201,
        body: {
          token: tokenFor(MINT.exec(request.url.pathname)![1]!, json(request) as MintBody),
          expires_at: EXPIRES_AT,
        },
      }),
    },
    {
      name: "repository-resolution",
      match: (request) =>
        request.method === "GET" &&
        request.url.pathname === "/installation/repositories" &&
        RESOLVER.test(request.headers.authorization ?? ""),
      reply: (request) => ({
        body: { repositories: REPOSITORIES[RESOLVER.exec(request.headers.authorization!)![1]!] ?? [] },
      }),
    },
  ],
  calls: [
    { label: "list_scopes configuration", tool: "list_scopes" },
    {
      tool: "list_scopes",
      args: { owner: "other" },
      replies: [{ body: { total_count: 2, repositories: REPOSITORIES["22"] } }],
    },
    {
      tool: "search_scoped",
      args: { terms: "widget", kind: "repositories" },
      replies: (request) =>
        request.url.searchParams.get("q")?.startsWith("org:acme")
          ? search([{ id: 101, full_name: "acme/one", description: "Widget service" }])
          : search([{ id: 201, full_name: "other/one", description: "Widget client" }]),
    },
    {
      label: "search_scoped issues",
      tool: "search_scoped",
      args: { terms: "crash", kind: "issues", scopes: [{ repo: "other/one" }], per_page: 1 },
      replies: (request) =>
        request.url.pathname === "/repos/other/one"
          ? { body: REPOSITORIES["22"]![0] }
          : {
              body: {
                total_count: 3,
                incomplete_results: false,
                items: [
                  {
                    id: 9001,
                    number: 7,
                    title: "Crash on launch",
                    state: "open",
                    repository_url: "https://api.github.com/repos/other/one",
                    user: { login: "bob", id: 2 },
                  },
                ],
              },
            },
    },
    {
      tool: "create_release",
      args: { owner: "other", repo: "one", tag_name: "v1.2.0", name: "Release v1.2.0", draft: true },
      replies: [{ status: 201, body: release(501, "v1.2.0", true) }],
    },
    {
      tool: "update_release",
      args: { owner: "acme", repo: "one", release_id: 501, draft: false },
      replies: [{ body: release(501, "v1.2.0", false) }],
    },
    {
      tool: "delete_release",
      args: { owner: "other", repo: "one", release_id: 501 },
      replies: [{ status: 204 }],
    },
    {
      tool: "merge_pull_request",
      args: { owner: "other", repo: "one", pull_number: 7, sha: "6dcb09b5b57875f334f61aebed695e2e4193db5e" },
      replies: (request) =>
        request.method === "GET"
          ? {
              body: {
                number: 7,
                state: "open",
                head: { sha: "6dcb09b5b57875f334f61aebed695e2e4193db5e", repo: { full_name: "other/one" } },
                base: { ref: "main", repo: { full_name: "other/one" } },
              },
            }
          : {
              body: {
                sha: "6dcb09b5b57875f334f61aebed695e2e4193db5f",
                merged: true,
                message: "Pull Request successfully merged",
              },
            },
    },
  ],
  unsent: ["privateKey"],
  echo: {
    tool: "search_scoped",
    args: { terms: "widget", kind: "repositories", scopes: [{ repo: "other/one" }] },
    replies: (text) => (request) =>
      request.url.pathname === "/repos/other/one"
        ? { body: REPOSITORIES["22"]![0] }
        : search([{ id: 201, full_name: "other/one", description: text }]),
  },
  failures: {
    read: { tool: "search_scoped", args: { terms: "widget", kind: "repositories", scopes: [{ repo: "other/one" }] } },
    write: { tool: "create_release", args: { owner: "other", repo: "one", tag_name: "v1.2.0" } },
  },
  failureReply: (status, message) => ({
    status,
    body: {
      message,
      documentation_url: "https://docs.github.com/rest",
      status: String(status),
    },
  }),
});
