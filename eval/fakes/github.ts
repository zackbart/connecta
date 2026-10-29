/** Isolated App/installation REST fake; no real GitHub credential or request. */
import { generateKeyPairSync, randomInt, randomUUID } from "node:crypto";
import { serveFetch, type Served } from "../support/serve.js";
import type { Ledger, CallRecord } from "./service.js";
import { registerFakeRoute, unregisterFakeRoute } from "./rest.js";

type Row = Record<string, any>;
export const HEAD_SHA = "a".repeat(40);
export function githubState() {
  return {
    repositories: Array.from({ length: 137 }, (_, i) => ({
      id: 1001 + i,
      full_name: `alice/${i === 0 ? "widget" : `repo${String(i).padStart(3, "0")}`}`,
      default_branch: i === 0 ? "main" : "trunk",
      archived: false,
    })),
    releases: [] as Row[],
    merges: [] as Row[],
    faulted: false,
  };
}
export type GitHubState = ReturnType<typeof githubState>;
export class FakeGitHub {
  readonly vendor = "github" as const;
  readonly appId = String(randomInt(1_000_000_000, 9_000_000_000));
  readonly privateKey = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  }).privateKey;
  readonly credential = randomUUID();
  private served?: Served;
  private tokens = new Map<string, { installation: string; ids?: number[]; permissions: Row }>();
  constructor(
    readonly name: string,
    private readonly ledger: Ledger,
    readonly state: GitHubState,
    private readonly fault?: "search-503",
  ) {}
  get url() {
    if (!this.served) throw new Error("GitHub fake not started");
    return this.served.url;
  }
  async start() {
    this.served = await serveFetch((r) => this.handle(r));
    registerFakeRoute(`iss:${this.appId}`, this.url, ["api.github.com"]);
  }
  async stop() {
    unregisterFakeRoute(`iss:${this.appId}`);
    for (const token of this.tokens.keys()) unregisterFakeRoute(token);
    await this.served?.close();
  }
  private async handle(request: Request) {
    const url = new URL(request.url),
      path = url.pathname,
      query = Object.fromEntries(url.searchParams);
    const body = ["POST", "PUT", "PATCH"].includes(request.method) ? ((await request.json()) as Row) : undefined;
    const bearer = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    const token = this.tokens.get(bearer);
    let app = false;
    try {
      app = String(JSON.parse(Buffer.from(bearer.split(".")[1] ?? "", "base64url").toString()).iss) === this.appId;
    } catch {
      /* not an App JWT */
    }
    const privateCall = path.startsWith("/app/");
    const record: CallRecord = {
      seq: this.ledger.next(),
      at: Date.now(),
      service: this.name,
      tool: `${request.method} ${path}`,
      kind: request.method === "GET" || privateCall ? "read" : "write",
      args: {
        method: request.method,
        path,
        query,
        ...(body ? { body } : {}),
        privateCall,
        tokenOrdinal: token ? [...this.tokens.keys()].indexOf(bearer) + 1 : 0,
      },
      outcome: "ok",
      resultBytes: 0,
    };
    this.ledger.calls.push(record);
    const respond = (value: unknown, status = 200, headers: Record<string, string> = {}) => {
      if (status >= 400) {
        record.outcome = "tool_error";
        record.error = `HTTP ${status}`;
      }
      const text = JSON.stringify(value);
      record.resultBytes = Buffer.byteLength(text);
      return new Response(text, { status, headers: { "content-type": "application/json", ...headers } });
    };
    const page = (rows: unknown[], wrap?: string) => {
      const at = Number(query.page ?? 1),
        count = Number(query.per_page ?? 30);
      const items = rows.slice((at - 1) * count, at * count);
      const headers: Record<string, string> = {};
      if (at * count < rows.length) {
        const next = new URL(`https://api.github.com${path}${url.search}`);
        next.searchParams.set("page", String(at + 1));
        headers.link = `<${next}>; rel="next"`;
      }
      return respond(
        wrap ? { [wrap]: items, total_count: rows.length, incomplete_results: false } : items,
        200,
        headers,
      );
    };
    if (path === "/app/installations" && app)
      return respond([
        { id: 11, account: { login: "alice", type: "Organization" }, repository_selection: "all", suspended_at: null },
        { id: 22, account: { login: "bob", type: "User" }, repository_selection: "selected", suspended_at: null },
      ]);
    const mint = /^\/app\/installations\/(11|22)\/access_tokens$/.exec(path);
    if (mint && app) {
      const value = randomUUID();
      this.tokens.set(value, {
        installation: mint[1]!,
        ids: body?.repository_ids,
        permissions: body?.permissions ?? {},
      });
      registerFakeRoute(value, this.url, ["api.github.com"]);
      return respond({ token: value, expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    }
    if (!token) return respond({ message: "Bad credentials" }, 401);
    const repos =
      token.installation === "11"
        ? this.state.repositories
        : [{ id: 2001, full_name: "bob/one", default_branch: "release", archived: true }];
    const visible = repos.filter((r) => !token.ids || token.ids.includes(r.id));
    if (path === "/installation/repositories") return page(visible, "repositories");
    const repo = visible.find((r) => `/repos/${r.full_name}` === path);
    if (repo) return respond(repo);
    if (path.startsWith("/search/")) {
      if (this.fault && !this.state.faulted) {
        this.state.faulted = true;
        return respond({ message: "Unavailable" }, 503);
      }
      const q = query.q ?? "";
      const selected = visible.filter(
        (r) => q.includes(`org:${r.full_name.split("/")[0]}`) || q.includes(`repo:${r.full_name}`),
      );
      if (path === "/search/repositories")
        return page(
          selected.filter((r) => r.full_name.endsWith("/widget") || r.full_name === "bob/one"),
          "items",
        );
      const found = selected
        .filter((r) => r.full_name === "alice/widget")
        .flatMap((r) => [
          {
            id: 501,
            number: 1,
            title: "bug login",
            state: "open",
            labels: [{ name: "priority" }],
            repository_url: `https://api.github.com/repos/${r.full_name}`,
            html_url: `https://github.com/${r.full_name}/issues/1`,
          },
          {
            id: 502,
            number: 2,
            title: "bug old",
            state: "closed",
            labels: [{ name: "priority" }],
            repository_url: `https://api.github.com/repos/${r.full_name}`,
            html_url: `https://github.com/${r.full_name}/issues/2`,
          },
          {
            id: 7007,
            number: 7,
            title: "bug refactor",
            state: "open",
            pull_request: { url: `https://api.github.com/repos/${r.full_name}/pulls/7` },
            repository_url: `https://api.github.com/repos/${r.full_name}`,
            html_url: `https://github.com/${r.full_name}/pull/7`,
          },
        ])
        .filter((r) =>
          q.includes("is:pr") ? Boolean(r.pull_request) : q.includes("is:issue") ? !r.pull_request : true,
        );
      return page(found, "items");
    }
    if (!visible.some((r) => r.full_name === "alice/widget") || !path.startsWith("/repos/alice/widget/"))
      return respond({ message: "Not found" }, 404);
    if (path === "/repos/alice/widget/pulls/7")
      return respond({
        id: 7007,
        number: 7,
        state: "open",
        head: { sha: HEAD_SHA, repo: { full_name: "alice/widget" } },
        base: { sha: "b".repeat(40), ref: "main", repo: { full_name: "alice/widget" } },
      });
    if (path === "/repos/alice/widget/contents/settings.json")
      return respond({
        name: "settings.json",
        path: "settings.json",
        sha: "c".repeat(40),
        type: "file",
        encoding: "base64",
        content: Buffer.from('{"region":"north","retryLimit":7}\n').toString("base64"),
        size: 34,
      });
    if (path === "/repos/alice/widget/releases" && request.method === "POST") {
      const release = { id: 9001, ...body };
      this.state.releases.push(release);
      return respond(release, 201);
    }
    if (path === "/repos/alice/widget/releases" && request.method === "GET") return page(this.state.releases);
    if (path === "/repos/alice/widget/pulls/7/merge" && request.method === "PUT") {
      if (body?.sha !== HEAD_SHA) return respond({ message: "Head changed" }, 409);
      this.state.merges.push(body);
      return respond({ merged: true, sha: "d".repeat(40), message: "Pull request merged" });
    }
    return respond({ message: "Not found" }, 404);
  }
}
