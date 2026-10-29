import { OperationIndex, type Operation, type RestMethod } from "../../_shared/rest/operation-index.js";
import { githubPage } from "../../../http/hatch-paging.js";
import type { HatchDeclaration } from "../../../http/hatch.js";
import { openapi } from "../openapi.generated.js";
import { READ_PERMISSIONS, RELEASE_PERMISSIONS, INTERNAL_READS, MERGE } from "./operations.js";
import { workflowPath } from "./scope.js";
import { ConnectorCallError } from "../../../errors.js";

/** Only the documented contents path can consume several literal URL segments. */
export function contentsPath(path: string): string {
  // Preserve the shared refusal of URL suffixes and unfilled placeholders.
  if (/[?#{}]/.test(path)) return path;
  const match = /^(\/repos\/[^/]+\/[^/]+\/contents\/)(.+)$/.exec(path);
  if (!match) return path;
  let relative: string;
  try {
    relative = decodeURIComponent(match[2]!);
  } catch {
    // Keep malformed encodings for the index's standard refusal.
    return path;
  }
  workflowPath(relative);
  return match[1]! + encodeURIComponent(relative);
}

// Prefer the deployed coverage for natural queries. Explicit paths and queries
// without reviewed matches retain full-pin refusal discovery. Metadata, contract
// lookup, validation and the manifest still use the complete immutable pin.
class RepositoryIndex extends OperationIndex {
  override resolve(method: string, path: string) {
    if (method === "GET" && /^\/repos\/[^/]+\/[^/]+\/contents$/.test(path)) {
      // GitHub documents omitted path as the root directory. Reuse the pinned
      // contents contract; validate owner/repo normally, and never send this
      // placeholder. The actual resource request keeps the /contents URL.
      const match = super.resolve(method, `${path}/root`);
      return { ...match, params: { ...match.params, path: "" } };
    }
    try {
      return super.resolve(method, contentsPath(path));
    } catch (error) {
      if (
        method === "GET" &&
        error instanceof ConnectorCallError &&
        error.code === "invalid_args" &&
        error.message.includes(" operation at that path in the pinned API index ") &&
        /^\/repos\/[^/]+\/[^/]+\/(?:commits|compare)\/[^/]+\/.+/.test(path)
      )
        throw new ConnectorCallError("invalid_args", `${error.message} Encode '/' inside refs as %2F.`);
      throw error;
    }
  }

  override contract(op: Operation, only?: string) {
    const contract = super.contract(op, only);
    if (op.path === "/repos/{owner}/{repo}/contents/{path}")
      for (const param of contract.parameters)
        if (param.name === "path")
          param.description =
            "Canonical relative file or directory path; nested paths such as src/index.ts are accepted. For the root directory use /repos/{owner}/{repo}/contents without a final path.";
    if (["/repos/{owner}/{repo}/commits/{ref}", "/repos/{owner}/{repo}/compare/{basehead}"].includes(op.path))
      for (const param of contract.parameters)
        if (param.name === "ref" || param.name === "basehead")
          param.description =
            "Repository-local ref or SHA; encode a slash inside a branch name as %2F. Compare uses BASE...HEAD. Owner-prefixed refs containing a colon are refused.";
    return contract;
  }

  override search(query: string, options: { method?: RestMethod; limit: number; partial?: boolean }) {
    const all = super.search(query, { ...options, limit: this.ops.length });
    if (query.trim().startsWith("/")) return all.slice(0, options.limit);
    const preferred = all.filter((op) => {
      const key = `${op.method} ${op.path}`;
      return READ_PERMISSIONS[key] || RELEASE_PERMISSIONS[key] || INTERNAL_READS.has(key) || key === MERGE;
    });
    // The shared lexical framing drops "latest". Bare release discovery
    // therefore leads with the collection and latest read; explicit actions,
    // method filters and paths still discover every reviewed release write.
    const found =
      /^releases?$/i.test(query.trim()) && (options.method === undefined || options.method === "GET")
        ? preferred.filter(
            (op) =>
              op.method === "GET" &&
              ["/repos/{owner}/{repo}/releases", "/repos/{owner}/{repo}/releases/latest"].includes(op.path),
          )
        : preferred;
    return (found.length ? found : all).slice(0, options.limit);
  }
}
export const githubIndex = new RepositoryIndex(
  {
    ...openapi,
    ops: openapi.ops.map((row) => {
      const [method, path, id, summary, tag, ...server] = row;
      const alias =
        method === "PATCH" && path === "/repos/{owner}/{repo}/releases/{release_id}"
          ? " (Publish a release by updating draft to false)"
          : path === "/repos/{owner}/{repo}/releases/latest"
            ? " (Latest published release)"
            : path.includes("/pulls")
              ? " (PR pull request)"
              : path.includes("/contents/")
                ? " (Read file or directory contents)"
                : "";
      return [method, path, id, summary + alias, tag, ...server] as typeof row;
    }),
  },
  { vendor: "github", title: "GitHub", slashParams: ["path", "ref", "basehead"] },
);
for (const key of [...Object.keys(READ_PERMISSIONS), ...Object.keys(RELEASE_PERMISSIONS), ...INTERNAL_READS, MERGE]) {
  if (!githubIndex.ops.some((op) => `${op.method} ${op.path}` === key))
    throw new Error(`GitHub reviewed operation is absent from the pin: ${key}`);
}
export const GITHUB_VERDICTS: HatchDeclaration["verdicts"] = {
  ...Object.fromEntries(Object.keys(READ_PERMISSIONS).map((key) => [key, "read" as const])),
  ...Object.fromEntries(Object.keys(RELEASE_PERMISSIONS).map((key) => [key, "destructive" as const])),
  [MERGE]: "refuse",
  ...Object.fromEntries([...INTERNAL_READS].map((key) => [key, "refuse" as const])),
};
const GITHUB_NAMED = {
  [MERGE]: "merge_pull_request",
  "GET /installation/repositories": "list_scopes",
  "GET /search/repositories": "search_scoped",
  "GET /search/issues": "search_scoped",
  "GET /search/code": "search_scoped",
};
const adapter = githubPage("https://api.github.com");
const GITHUB_PAGES: HatchDeclaration["pages"] = Object.fromEntries(
  githubIndex.ops
    .filter((op) => {
      const key = `${op.method} ${op.path}`;
      return (
        READ_PERMISSIONS[key] && githubIndex.contract(op).parameters.some((p) => p.in === "query" && p.name === "page")
      );
    })
    .map((op) => [`${op.method} ${op.path}`, adapter]),
);
export const GITHUB_HATCH = {
  name: "github",
  title: "GitHub",
  index: githubIndex,
  verdicts: GITHUB_VERDICTS,
  named: GITHUB_NAMED,
  pages: GITHUB_PAGES,
  pageCursor: "argument" as const,
  pathExample: "/repos/alice/widget/issues",
};
