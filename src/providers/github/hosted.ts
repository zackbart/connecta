import { ConnectorCallError } from "../../errors.js";
import type { ToolClassification, ToolVerdict } from "../../types.js";
import type { Permissions } from "./auth.js";
import { ScopePolicy, target, workflowPath, type Target } from "./scope.js";

interface Route { verdict: ToolVerdict; permissions: Permissions; keys: readonly string[]; methods?: readonly string[] }

// Exact reviewed ownership map. New upstream names, arguments and methods
// require review before they can authenticate or dispatch.
export const HOSTED_ROUTES: Readonly<Record<string, Route>> = {
  get_file_contents: { verdict: "read", permissions: {"contents": "read"}, keys: ["fields", "owner", "path", "ref", "repo", "sha"] },
  get_commit: { verdict: "read", permissions: {"contents": "read"}, keys: ["detail", "owner", "page", "perPage", "repo", "sha"] },
  list_commits: { verdict: "read", permissions: {"contents": "read"}, keys: ["author", "fields", "owner", "page", "path", "perPage", "repo", "sha", "since", "until"] },
  list_branches: { verdict: "read", permissions: {"contents": "read"}, keys: ["owner", "page", "perPage", "repo"] },
  get_tag: { verdict: "read", permissions: {"contents": "read"}, keys: ["owner", "repo", "tag"] },
  list_tags: { verdict: "read", permissions: {"contents": "read"}, keys: ["owner", "page", "perPage", "repo"] },
  get_latest_release: { verdict: "read", permissions: {"contents": "read"}, keys: ["owner", "repo"] },
  get_release_by_tag: { verdict: "read", permissions: {"contents": "read"}, keys: ["owner", "repo", "tag"] },
  list_releases: { verdict: "read", permissions: {"contents": "read"}, keys: ["fields", "owner", "page", "perPage", "repo"] },
  list_issues: { verdict: "read", permissions: {"issues": "read", "pull_requests": "read"}, keys: ["after", "direction", "field_filters", "fields", "labels", "orderBy", "owner", "perPage", "repo", "since", "state"] },
  issue_read: { verdict: "read", permissions: {"issues": "read"}, keys: ["issue_number", "method", "owner", "page", "perPage", "repo"], methods: ["get", "get_comments", "get_labels"] },
  get_label: { verdict: "read", permissions: {"issues": "read"}, keys: ["name", "owner", "repo"] },
  list_pull_requests: { verdict: "read", permissions: {"pull_requests": "read"}, keys: ["base", "direction", "fields", "head", "owner", "page", "perPage", "repo", "sort", "state"] },
  pull_request_read: { verdict: "read", permissions: {"pull_requests": "read", "contents": "read", "checks": "read", "statuses": "read"}, keys: ["after", "method", "owner", "page", "perPage", "pullNumber", "repo"], methods: ["get", "get_diff", "get_status", "get_files", "get_commits", "get_review_comments", "get_reviews", "get_comments", "get_check_runs"] },
  actions_list: { verdict: "read", permissions: {"actions": "read"}, keys: ["method", "owner", "page", "perPage", "repo", "resource_id", "workflow_jobs_filter", "workflow_runs_filter"], methods: ["list_workflows", "list_workflow_runs", "list_workflow_jobs", "list_workflow_run_artifacts"] },
  actions_get: { verdict: "read", permissions: {"actions": "read"}, keys: ["method", "owner", "repo", "resource_id"], methods: ["get_workflow", "get_workflow_run", "get_workflow_run_usage", "get_workflow_job"] },
  issue_write: { verdict: "destructive", permissions: {"issues": "write", "pull_requests": "write"}, keys: ["assignees", "body", "duplicate_of", "issue_fields", "issue_number", "labels", "method", "milestone", "owner", "parent_issue_number", "parent_owner", "parent_repo", "repo", "state", "state_reason", "title", "type"], methods: ["create", "update"] },
  add_issue_comment: { verdict: "write", permissions: {"issues": "write", "pull_requests": "write"}, keys: ["body", "comment_id", "issue_number", "owner", "reaction", "repo"] },
  create_pull_request: { verdict: "write", permissions: {"pull_requests": "write"}, keys: ["base", "body", "draft", "head", "maintainer_can_modify", "owner", "repo", "reviewers", "title"] },
  update_pull_request: { verdict: "destructive", permissions: {"pull_requests": "write"}, keys: ["base", "body", "draft", "maintainer_can_modify", "owner", "pullNumber", "repo", "reviewers", "state", "title"] },
  pull_request_review_write: { verdict: "destructive", permissions: {"pull_requests": "write"}, keys: ["body", "commitID", "event", "method", "owner", "pullNumber", "repo", "threadId"], methods: ["create", "submit_pending", "delete_pending"] },
  create_branch: { verdict: "write", permissions: {"contents": "write"}, keys: ["branch", "from_branch", "owner", "repo"] },
  create_or_update_file: { verdict: "destructive", permissions: {"contents": "write"}, keys: ["allow_symlink_write", "branch", "content", "message", "owner", "path", "repo", "sha"] },
  delete_file: { verdict: "destructive", permissions: {"contents": "write"}, keys: ["branch", "message", "owner", "path", "repo"] },
  push_files: { verdict: "destructive", permissions: {"contents": "write"}, keys: ["branch", "files", "message", "owner", "repo"] },
  actions_run_trigger: { verdict: "destructive", permissions: {"actions": "write"}, keys: ["inputs", "method", "owner", "ref", "repo", "run_id", "workflow_id"], methods: ["run_workflow", "rerun_workflow_run", "rerun_failed_jobs", "cancel_workflow_run"] },
};

export const HOSTED_CLASSIFICATION: ToolClassification = {
  unlisted: "hide",
  tools: Object.fromEntries(Object.entries(HOSTED_ROUTES).map(([name, route]) => [name, route.verdict])),
};

export function hostedTarget(name: string, input: unknown, policy: ScopePolicy): { target: Target; permissions: Permissions } {
  const route = Object.hasOwn(HOSTED_ROUTES, name) ? HOSTED_ROUTES[name] : undefined;
  if (!route) throw new ConnectorCallError("invalid_args", "This GitHub tool is not in the reviewed allowlist.");
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ConnectorCallError("invalid_args", "Supply GitHub arguments as an object.");
  const args = input as Record<string, unknown>;
  const t = target(args.owner, args.repo);
  policy.scope(t, route.verdict !== "read");
  if (Object.keys(args).some((key) => !route.keys.includes(key))) throw new ConnectorCallError("invalid_args", "Unreviewed GitHub arguments are refused; use the reviewed tool schema.");
  if (route.methods && !route.methods.includes(String(args.method))) throw new ConnectorCallError("invalid_args", "This GitHub method is not in the reviewed allowlist.");
  // Secondary repositories and opaque review-thread IDs cannot choose a grant.
  if (args.parent_owner !== undefined || args.parent_repo !== undefined || args.threadId !== undefined || args.comment_id !== undefined) {
    throw new ConnectorCallError("invalid_args", "Cross-repository parent references and opaque comment/thread IDs are not supported. Use the scoped repository operation.");
  }
  if (args.allow_symlink_write === true) throw new ConnectorCallError("invalid_args", "Symlink writes cannot establish a workflow-file boundary.");
  if (name === "create_pull_request" && (typeof args.head !== "string" || args.head.includes(":"))) throw new ConnectorCallError("invalid_args", "Create pull requests from a branch in the target repository; cross-owner heads are not supported.");
  let workflows = false;
  if (["create_or_update_file", "delete_file"].includes(name)) workflows = workflowPath(args.path);
  if (name === "push_files") {
    if (!Array.isArray(args.files) || args.files.length === 0 || args.files.length > 100) throw new ConnectorCallError("invalid_args", "Supply between 1 and 100 file changes.");
    for (const file of args.files) {
      if (!file || typeof file !== "object" || Array.isArray(file) || Object.keys(file).some((key) => !["path", "content"].includes(key))) throw new ConnectorCallError("invalid_args", "Each file has only path and content fields.");
      workflows = workflowPath(file.path) || workflows;
    }
  }
  if (name === "get_file_contents" && args.path !== undefined && args.path !== "") workflowPath(args.path);
  policy.scope(t, route.verdict !== "read", workflows);
  return { target: t, permissions: { ...route.permissions, ...(workflows ? { workflows: "write" as const } : {}) } };
}
