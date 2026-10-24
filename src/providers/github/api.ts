// GitHub's finite REST complement. App JWT discovery and minting remain private
// auxiliary requests; rejected installation tokens renew on the next call only.
import { Effect, Schema } from "effect";
import { ConnectorCallError } from "../../errors.js";
import { guardedClient } from "../../http/client.js";
import { captureClassifierFacts, type Classified, type VendorErrors } from "../../http/errors.js";
import { resultSafety } from "../../http/safety.js";
import { connect, del, get, patch, post, put, vendor, operations } from "../../http/vendor.js";

const repository = { owner: Schema.String, repo: Schema.String };
const success = Schema.Unknown;
export const GitHubApi = vendor(
  "GitHub",
  get("installations", "/app/installations", { success }),
  post("installationToken", "/app/installations/:installation_id/access_tokens", {
    params: { installation_id: Schema.String },
    success,
  }),
  get("repositories", "/installation/repositories", { success }),
  get("repository", "/repos/:owner/:repo", { params: repository, success }),
  get("searchRepositories", "/search/repositories", { success }),
  get("searchIssues", "/search/issues", { success }),
  get("searchCode", "/search/code", { success }),
  get("pullRequest", "/repos/:owner/:repo/pulls/:pull_number", {
    params: { ...repository, pull_number: Schema.String },
    success,
  }),
  post("createRelease", "/repos/:owner/:repo/releases", { params: repository, success }),
  patch("updateRelease", "/repos/:owner/:repo/releases/:release_id", {
    params: { ...repository, release_id: Schema.String },
    success,
  }),
  del("deleteRelease", "/repos/:owner/:repo/releases/:release_id", {
    params: { ...repository, release_id: Schema.String },
    success,
  }),
  put("mergePullRequest", "/repos/:owner/:repo/pulls/:pull_number/merge", {
    params: { ...repository, pull_number: Schema.String },
    success,
  }),
);
export const kit = { operations: operations(GitHubApi) };

function rateLimited(status: number, retry: number | undefined, remaining: number | undefined): boolean {
  return status === 429 || (status === 403 && (retry !== undefined || remaining === 0));
}
export function rejectedToken(status: number, headers: Headers): boolean {
  if (status !== 403) return status === 401;
  const numbers = captureClassifierFacts(undefined, errors, headers)?.numbers;
  return !rateLimited(status, numbers?.["retryAfterMs"], numbers?.["remaining"]);
}
const AUTH = "Verify the GitHub App key, installation, repository selection and required permissions.";
const FAILED = "The GitHub API request failed; downstream error text is withheld.";
function status(input: Classified) {
  const rate = rateLimited(input.status, input.retryAfterMs, input.numbers["remaining"]);
  const wait = input.retryAfterMs ?? input.numbers["resetAfterMs"];
  return {
    code: rate
      ? ("rate_limited" as const)
      : input.status === 401 || input.status === 403
        ? ("auth_required" as const)
        : input.status === 409
          ? ("conflict" as const)
          : input.status >= 500
            ? ("unavailable" as const)
            : ("connector_call_failed" as const),
    retryable: rate || input.status >= 500,
    ...(rate && wait !== undefined ? { retryAfterMs: wait } : {}),
    ...(rate ? { words: () => "GitHub rate limit reached." } : {}),
    ...(rate
      ? { advice: " Honor the retry timing before trying again." }
      : input.status === 409
        ? { advice: " before resubmitting" }
        : {}),
  };
}
export const errors: VendorErrors = {
  numericFacts: {
    retryAfterMs: {
      header: "retry-after",
      format: "retry-after",
      review: "HTTP Retry-After delay for failure recovery.",
    },
    remaining: {
      header: "x-ratelimit-remaining",
      review: "GitHub classifies a 403 with no remaining requests as rate limited.",
    },
    resetAfterMs: {
      header: "x-ratelimit-reset",
      format: "epoch-seconds",
      review: "GitHub rate-limit reset time in epoch seconds.",
    },
  },
  provider: "GitHub",
  facts: () => ({}),
  classify: [status],
  detail: ({ status: code }) =>
    code === 401 || code === 403
      ? AUTH
      : code === 409
        ? "GitHub rejected a stale version. Read the current state."
        : code === 404
          ? "GitHub returned 404; the resource may be absent or inaccessible to this installation."
          : FAILED,
  statuses: { 401: status, 403: status, 404: status },
  unreadable: "GitHub returned malformed JSON; response text is withheld.",
};

export function githubConnection() {
  // App discovery and token minting use AppAuth's private transport.
  // Installation repository enumeration also serves the list_scopes resource.
  const templates = kit.operations
    .map((operation) => {
      const [method, path] = operation.split(" ") as [string, string];
      return { method, path, pattern: new RegExp(`^${path.replace(/\{[^}]+\}/g, "[^/]+")}$`) };
    })
    .filter(
      ({ path }) => path === "/installation/repositories" || path.startsWith("/repos/") || path.startsWith("/search/"),
    );
  const safety = resultSafety({
    reviewed: {
      resolve: (method, path) => {
        const found = templates.find((entry) => entry.method === method && entry.pattern.test(path));
        if (!found)
          throw new ConnectorCallError("invalid_args", "This GitHub operation is not exposed by the connection.");
        return { method, template: found.path };
      },
      // No arbitrary API hatch or credential/secret operation is exposed.
      // App token replies never enter this resource connection.
      redact: (data) => data,
      withholdsErrors: () => true,
    },
    sensitiveFields: { names: [], choice: "drop" },
  });
  return connect(
    GitHubApi,
    guardedClient({
      provider: "GitHub",
      baseUrl: "https://api.github.com",
      maxResponseBytes: 4 * 1024 * 1024,
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "connecta",
      },
      authenticate: Effect.succeed({}),
    }),
    { errors, safety, result: (body, answer) => Effect.succeed(answer.bodyFormat === "empty" ? undefined : body) },
  );
}
