export const REPO = "example-org/agent-skills";
const API = "https://api.github.com";
const encoder = new TextEncoder();

export type FixtureFile = string | Uint8Array | { symlink: string } | { submodule: true };
type GitObject =
  | { type: "blob"; bytes: Uint8Array }
  | { type: "tree"; entries: { name: string; mode: string; type: string; sha: string; size?: number }[] };

export interface Exchange {
  url: URL;
  headers: Headers;
}

const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");

async function gitSha(type: string, bytes: Uint8Array): Promise<string> {
  const header = encoder.encode(`${type} ${bytes.length}\0`);
  const framed = new Uint8Array(header.length + bytes.length);
  framed.set(header);
  framed.set(bytes, header.length);
  return hex(await crypto.subtle.digest("SHA-1", framed));
}

/**
 * A GitHub REST API fixture over an in-memory repository: commits by ref,
 * commit objects, trees (recursive or not) and raw blobs. Every request is
 * recorded with its headers; `intercept` answers a request before the fixture
 * does, to inject failures.
 */
export function githubSkillsApi() {
  const objects = new Map<string, GitObject>();
  const refs = new Map<string, string>();
  const commits = new Map<string, string>();
  const truncated = new Set<string>();
  const exchanges: Exchange[] = [];
  let commitCounter = 0;
  let intercept: ((url: URL) => Response | undefined | Promise<Response | undefined>) | undefined;

  async function writeTree(files: Record<string, FixtureFile>, prefix: string): Promise<string> {
    const children = new Map<string, Record<string, FixtureFile>>();
    const entries: { name: string; mode: string; type: string; sha: string; size?: number }[] = [];
    for (const [path, content] of Object.entries(files)) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash !== -1) {
        const name = rest.slice(0, slash);
        if (!children.has(name)) children.set(name, {});
        continue;
      }
      if (typeof content === "object" && "submodule" in content) {
        entries.push({ name: rest, mode: "160000", type: "commit", sha: "c".repeat(40) });
        continue;
      }
      const bytes =
        typeof content === "string"
          ? encoder.encode(content)
          : content instanceof Uint8Array
            ? content
            : encoder.encode(content.symlink);
      const sha = await gitSha("blob", bytes);
      objects.set(sha, { type: "blob", bytes });
      entries.push({
        name: rest,
        mode: typeof content === "object" && "symlink" in content ? "120000" : "100644",
        type: "blob",
        sha,
        size: bytes.length,
      });
    }
    for (const name of children.keys())
      entries.push({ name, mode: "040000", type: "tree", sha: await writeTree(files, `${prefix}${name}/`) });
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    const sha = await gitSha("tree", encoder.encode(JSON.stringify(entries)));
    objects.set(sha, { type: "tree", entries });
    return sha;
  }

  function flatten(sha: string, prefix: string): object[] {
    const tree = objects.get(sha) as Extract<GitObject, { type: "tree" }>;
    return tree.entries.flatMap((entry) => {
      const path = `${prefix}${entry.name}`;
      const row = { path, mode: entry.mode, type: entry.type, sha: entry.sha, ...(entry.size === undefined ? {} : { size: entry.size }), url: `${API}/x` };
      return entry.type === "tree" ? [row, ...flatten(entry.sha, `${path}/`)] : [row];
    });
  }

  async function route(url: URL): Promise<Response> {
    const base = `/repos/${REPO}/`;
    if (!url.pathname.startsWith(base)) return new Response("{}", { status: 404 });
    const rest = url.pathname.slice(base.length);
    if (rest.startsWith("commits/")) {
      const sha = refs.get(decodeURIComponent(rest.slice("commits/".length)));
      return sha ? new Response(sha, { status: 200 }) : new Response("{}", { status: 404 });
    }
    const [kind, sha] = rest.split("/").slice(1);
    if (rest.startsWith("git/commits/")) {
      const tree = commits.get(sha!);
      return tree ? Response.json({ sha, tree: { sha: tree, url: `${API}/x` } }) : new Response("{}", { status: 404 });
    }
    const object = objects.get(sha!);
    if (kind === "trees" && object?.type === "tree") {
      const tree = url.searchParams.has("recursive")
        ? flatten(sha!, "")
        : object.entries.map((entry) => ({ path: entry.name, mode: entry.mode, type: entry.type, sha: entry.sha, ...(entry.size === undefined ? {} : { size: entry.size }), url: `${API}/x` }));
      return Response.json({ sha, url: `${API}/x`, tree, truncated: truncated.has(sha!) });
    }
    if (kind === "blobs" && object?.type === "blob") return new Response(object.bytes.slice(), { status: 200 });
    return new Response("{}", { status: 404 });
  }

  return {
    exchanges,
    /** Commits `files` as the whole repository on `ref` and returns the commit SHA. */
    async commit(files: Record<string, FixtureFile>, ref = "main"): Promise<string> {
      const tree = await writeTree(files, "");
      const sha = hex(await crypto.subtle.digest("SHA-1", encoder.encode(`${tree}:${++commitCounter}`)));
      commits.set(sha, tree);
      refs.set(ref, sha);
      return sha;
    },
    /** The tree SHA at `path` on `ref`. */
    treeAt(path: string, ref = "main"): string {
      let sha = commits.get(refs.get(ref)!)!;
      for (const segment of path ? path.split("/") : []) {
        const tree = objects.get(sha) as Extract<GitObject, { type: "tree" }>;
        sha = tree.entries.find((entry) => entry.name === segment)!.sha;
      }
      return sha;
    },
    truncate(treeSha: string) {
      truncated.add(treeSha);
    },
    intercept(handler: typeof intercept) {
      intercept = handler;
    },
    /** Request paths, with `?recursive=1` kept, after the repository prefix. */
    paths(): string[] {
      return exchanges.map((exchange) => exchange.url.pathname.replace(`/repos/${REPO}/`, "") + exchange.url.search);
    },
    reset() {
      exchanges.length = 0;
    },
    fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      exchanges.push({ url, headers: new Headers(init?.headers) });
      if (init?.signal?.aborted) throw init.signal.reason;
      const injected = await intercept?.(url);
      if (injected) return injected;
      if (url.origin !== API) return new Response("off-host", { status: 200 });
      return route(url);
    },
  };
}
