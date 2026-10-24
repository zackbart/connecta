import { OperationIndex, type RestMethod } from "../../_shared/rest/operation-index.js";
import { githubPage } from "../../../http/hatch-paging.js";
import type { HatchDeclaration } from "../../../http/hatch.js";
import { openapi } from "../openapi.generated.js";
import { READ_PERMISSIONS, RELEASE_PERMISSIONS, INTERNAL_READS, MERGE } from "./operations.js";

// Prefer the deployed coverage for natural queries. Explicit paths and queries
// without reviewed matches retain full-pin refusal discovery. Metadata, contract
// lookup, validation and the manifest still use the complete immutable pin.
class RepositoryIndex extends OperationIndex {
  override search(query: string, options: { method?: RestMethod; limit: number; partial?: boolean }) {
    const all = super.search(query, { ...options, limit: this.ops.length });
    if (query.trim().startsWith("/")) return all.slice(0, options.limit);
    const preferred = all.filter((op) => {
      const key = `${op.method} ${op.path}`;
      return READ_PERMISSIONS[key] || RELEASE_PERMISSIONS[key] || INTERNAL_READS.has(key) || key === MERGE;
    });
    return (preferred.length ? preferred : all).slice(0, options.limit);
  }
}
export const githubIndex = new RepositoryIndex(
  {
    ...openapi,
    ops: openapi.ops.map((row) => {
      const [method, path, id, summary, tag, ...server] = row;
      const alias = path.includes("/pulls")
        ? " (PR pull request)"
        : path.includes("/contents/")
          ? " (Read file or directory contents)"
          : "";
      return [method, path, id, summary + alias, tag, ...server] as typeof row;
    }),
  },
  { vendor: "github", title: "GitHub", slashParams: ["path"] },
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
export const GITHUB_NAMED = {
  [MERGE]: "merge_pull_request",
  "GET /installation/repositories": "list_scopes",
  "GET /search/repositories": "search_scoped",
  "GET /search/issues": "search_scoped",
  "GET /search/code": "search_scoped",
};
const adapter = githubPage("https://api.github.com");
export const GITHUB_PAGES: HatchDeclaration["pages"] = Object.fromEntries(
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
