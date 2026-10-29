// GitHub's finite REST complement. App JWT discovery and minting remain private
// auxiliary requests; rejected installation tokens renew on the next call only.
import { Effect, Schema } from "effect";
import { indexedVendor } from "../_shared/rest/kit.js";
import { githubIndex, GITHUB_HATCH } from "./lib/discovery.js";
import { githubSafety } from "./safety.js";
import { INTERNAL_READS, MERGE, READ_PERMISSIONS, RELEASE_PERMISSIONS } from "./lib/operations.js";
import { errorMeanings } from "../../http/errors.js";
import { ConnectorCallError } from "../../errors.js";
import { guardedClient } from "../../http/client.js";
import { captureClassifierFacts, StatusFailure, type Classified, type VendorErrors } from "../../http/errors.js";
import { resultSafety } from "../../http/safety.js";
import { connect, get, operations } from "../../http/vendor.js";

const repository = { owner: Schema.String, repo: Schema.String };
const success = Schema.Unknown;
const GitHubApi = indexedVendor("GitHub", githubIndex, [
  get("repository", "/repos/:owner/:repo", { params: repository, success }),
]);

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
function rate(input: Classified) {
  if (!rateLimited(input.status, input.retryAfterMs, input.numbers["remaining"])) return undefined;
  const wait = input.retryAfterMs ?? input.numbers["resetAfterMs"];
  return {
    code: "rate_limited" as const,
    retryable: true,
    ...(wait === undefined ? {} : { retryAfterMs: wait }),
    words: () => "GitHub rate limit reached.",
    advice: " Honor the retry timing before trying again.",
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
  facts: (body) => ({
    merged: body && typeof body === "object" && "merged" in body && body.merged === false ? false : undefined,
  }),
  factVocabulary: { merged: [false] },
  meanings: {
    unknownId: "connector_call_failed",
    provesAbsence: false,
    conflicts: [
      "HTTP 409 is a conflict; a merged:false response and the expected-SHA/same-repository preflight also refuse a merge",
    ],
  },
  classify: [
    ({ operation, facts }) =>
      operation.method === "PUT" &&
      operation.template === "/repos/{owner}/{repo}/pulls/{pull_number}/merge" &&
      facts["merged"] === false
        ? {
            code: "conflict",
            retryable: false,
            words: () =>
              "GitHub reported that the pull request was not merged. Read its current state before another attempt.",
          }
        : undefined,
    rate,
  ],
  detail: ({ status: code }) =>
    code === 401 || code === 403
      ? AUTH
      : code === 409
        ? "GitHub reported a conflict. Read the current state."
        : code === 404
          ? "GitHub returned 404; the resource may be absent or inaccessible to this installation."
          : FAILED,
  statuses: {
    401: () => ({ code: "auth_required", retryable: false }),
    403: () => ({ code: "auth_required", retryable: false }),
    404: () => ({ code: "connector_call_failed", retryable: false }),
    409: () => ({ code: "conflict", retryable: false, advice: " before resubmitting" }),
  },
  bodyFailures: {
    review:
      "GitHub failure classification uses only status and declared numeric headers; failed success reads disclose no raw cause.",
    statusOnly: [],
    readFailed: "GitHub's response body could not be read completely.",
  },
  unreadable: "GitHub returned malformed JSON; response text is withheld.",
};

export function githubConnection() {
  const safety = resultSafety({
    reviewed: {
      refusal: (op) => githubSafety.refusal(op.method, op.template),
      resolve: (method, path) => {
        const { op } = githubIndex.resolve(method, path);
        const key = `${op.method} ${op.path}`;
        if (!READ_PERMISSIONS[key] && !RELEASE_PERMISSIONS[key] && !INTERNAL_READS.has(key) && key !== MERGE)
          throw new ConnectorCallError("invalid_args", "This GitHub operation is not exposed by the connection.");
        return { method: op.method, template: op.path };
      },
      redact: (data, op) => githubSafety.redact(data, op.method, op.template),
      withholds: (op) => githubSafety.withholds(op.method, op.template),
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
    {
      errors,
      safety,
      inBandRefusals: true,
      result: (body, answer) =>
        answer.operation.method === "PUT" &&
        answer.operation.template === "/repos/{owner}/{repo}/pulls/{pull_number}/merge" &&
        body &&
        typeof body === "object" &&
        "merged" in body &&
        body.merged === false
          ? Effect.fail(
              new StatusFailure({ status: answer.status, headers: answer.headers, body, operation: answer.operation }),
            )
          : Effect.succeed(answer.bodyFormat === "empty" ? undefined : body),
    },
  );
}

export const kit = {
  operations: operations(GitHubApi),
  pageSize: { default: 30, max: 100 },
  hatch: { name: GITHUB_HATCH.name, verdicts: GITHUB_HATCH.verdicts, paging: "argument" as const },
  errors: errorMeanings(errors)!,
  idempotencyKey: false,
  refusesWithheld: true as const,
};
