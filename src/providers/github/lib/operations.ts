/** GitHub's documented fine-grained repository permission, selected once per operation.
 * Evidence URLs and the per-operation audit are in evidence/review.md. No method inference. */
export const READ_PERMISSIONS: Readonly<Record<string, Readonly<Record<string, "read">>>> = {
  "GET /repos/{owner}/{repo}": { metadata: "read" },
  "GET /repos/{owner}/{repo}/issues": { issues: "read" },
  "GET /repos/{owner}/{repo}/issues/{issue_number}": { issues: "read" },
  "GET /repos/{owner}/{repo}/issues/{issue_number}/comments": { issues: "read" },
  "GET /repos/{owner}/{repo}/issues/comments/{comment_id}": { issues: "read" },
  "GET /repos/{owner}/{repo}/labels": { issues: "read" },
  "GET /repos/{owner}/{repo}/labels/{name}": { issues: "read" },
  "GET /repos/{owner}/{repo}/issues/{issue_number}/labels": { issues: "read" },
  "GET /repos/{owner}/{repo}/pulls": { pull_requests: "read" },
  "GET /repos/{owner}/{repo}/pulls/{pull_number}": { pull_requests: "read" },
  "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews": { pull_requests: "read" },
  "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}": { pull_requests: "read" },
  "GET /repos/{owner}/{repo}/pulls/{pull_number}/comments": { pull_requests: "read" },
  "GET /repos/{owner}/{repo}/pulls/comments/{comment_id}": { pull_requests: "read" },
  "GET /repos/{owner}/{repo}/pulls/{pull_number}/files": { pull_requests: "read" },
  "GET /repos/{owner}/{repo}/pulls/{pull_number}/commits": { pull_requests: "read" },
  "GET /repos/{owner}/{repo}/commits": { contents: "read" },
  "GET /repos/{owner}/{repo}/commits/{ref}": { contents: "read" },
  "GET /repos/{owner}/{repo}/compare/{basehead}": { contents: "read" },
  "GET /repos/{owner}/{repo}/contents/{path}": { contents: "read" },
  "GET /repos/{owner}/{repo}/releases": { contents: "read" },
  "GET /repos/{owner}/{repo}/releases/{release_id}": { contents: "read" },
  "GET /repos/{owner}/{repo}/releases/latest": { contents: "read" },
  "GET /repos/{owner}/{repo}/releases/tags/{tag}": { contents: "read" },
  "GET /repos/{owner}/{repo}/actions/workflows": { actions: "read" },
  "GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}": { actions: "read" },
  "GET /repos/{owner}/{repo}/actions/runs": { actions: "read" },
  "GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs": { actions: "read" },
  "GET /repos/{owner}/{repo}/actions/runs/{run_id}": { actions: "read" },
  "GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs": { actions: "read" },
  "GET /repos/{owner}/{repo}/actions/jobs/{job_id}": { actions: "read" },
};
export const RELEASE_PERMISSIONS: Readonly<Record<string, Readonly<Record<string, "write">>>> = {
  "POST /repos/{owner}/{repo}/releases": { contents: "write" },
  "PATCH /repos/{owner}/{repo}/releases/{release_id}": { contents: "write" },
  "DELETE /repos/{owner}/{repo}/releases/{release_id}": { contents: "write" },
};
export const MERGE = "PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge";
export const INTERNAL_READS = new Set([
  "GET /installation/repositories",
  "GET /search/repositories",
  "GET /search/issues",
  "GET /search/code",
]);
export function hatchRefusal(key: string): string | undefined {
  if (key === MERGE) return "Use merge_pull_request for the expected-SHA, same-repository and workflow-write checks.";
  if (INTERNAL_READS.has(key))
    return key.includes("/search/")
      ? "Use search_scoped for installation-confined literal-term data search."
      : "Use list_scopes with a configured owner for installation repository discovery.";
  if (!READ_PERMISSIONS[key] && !RELEASE_PERMISSIONS[key])
    return "This operation is outside GitHub's reviewed repository read and release-write allowlist. Secrets, admin operations, raw diffs, log downloads, archives and uploads are refused.";
  return undefined;
}
