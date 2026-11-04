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
import {
  captureClassifierFacts,
  StatusFailure,
  type Classified,
  type Verdict,
  type VendorErrors,
} from "../../http/errors.js";
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
const AUTH = "GitHub rejected the credential (HTTP 401). Verify the GitHub App ID, private key and installation.";
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

// GitHub's permission and scope headers are vendor-controlled text. A header
// that is not wholly the documented shape is dropped, never partly repeated,
// so nothing but a bounded permission or scope name reaches an agent.
const PERMISSION = /^[a-z][a-z0-9_]{0,63}=(?:read|write|admin)$/;
const OAUTH_SCOPE = /^[a-z][a-z0-9_]{0,31}(?::[a-z][a-z0-9_]{0,31})?$/;
const MAX_ALTERNATIVES = 4;
const MAX_NAMES = 8;

/** `a=read,b=read; c=read` lists alternative sets, each needing all its members. */
function acceptedPermissions(header: string | undefined): string | undefined {
  if (!header?.trim()) return undefined;
  const sets = header.split(";").map((set) => set.split(",").map((name) => name.trim()));
  if (
    sets.length > MAX_ALTERNATIVES ||
    sets.some((set) => set.length > MAX_NAMES || set.some((name) => !PERMISSION.test(name)))
  )
    return undefined;
  return sets.map((set) => set.join(" and ")).join(", or ");
}

function scopeNames(header: string | undefined): string[] | undefined {
  if (!header?.trim()) return undefined;
  const names = header.split(",").map((name) => name.trim());
  return names.length <= MAX_NAMES && names.every((name) => OAUTH_SCOPE.test(name)) ? names : undefined;
}

/** The accepted scopes this token does not already hold; an unreadable held list cannot subtract. */
function missingScopes(accepted: string | undefined, held: string | undefined): string | undefined {
  const needed = scopeNames(accepted);
  if (!needed) return undefined;
  const has = scopeNames(held) ?? [];
  const missing = needed.filter((name) => !has.includes(name));
  return missing.length > 0 ? missing.join(", ") : undefined;
}

const NOT_THE_KEY = "The App credential authenticated, so resetting it will not help.";

/** Both refusals keep the credential out of it: the key works and this access is what is missing. */
function refused({ headers, operation, status }: Classified): Verdict {
  const repository = operation.context?.["repository"];
  const where = repository ? `for ${repository}` : "for this resource";
  if (/^required(?:;|$)/i.test(headers["x-github-sso"] ?? ""))
    return denied(
      `GitHub refused this request ${where}: the organization enforces SAML single sign-on and this credential is not authorized for it. ${NOT_THE_KEY} An organization owner must authorize it.`,
    );
  const accepted = acceptedPermissions(headers["x-accepted-github-permissions"]);
  const scopes = accepted ? undefined : missingScopes(headers["x-accepted-oauth-scopes"], headers["x-oauth-scopes"]);
  const requested = operation.context?.["permissions"];
  const need = accepted
    ? ` GitHub requires ${accepted}.`
    : scopes
      ? ` GitHub requires the OAuth scope ${scopes}.`
      : requested
        ? ` This call requested ${requested}.`
        : "";
  // GitHub does not always mark a secondary rate limit, and its text stays withheld.
  const unmarked =
    accepted || scopes
      ? ""
      : " After a burst of requests this can also be an unmarked secondary rate limit: wait a minute before one retry.";
  return denied(
    `GitHub refused this request ${where} (HTTP ${status}).${need} ${NOT_THE_KEY} The App owner must grant this permission and the installation owner must approve it, or select this repository; other repositories may still work.${unmarked}`,
  );
}

function denied(message: string): Verdict {
  return { code: "provider_permission_denied", retryable: false, words: () => message };
}

/**
 * GitHub answers 422 when a token asks for a permission or repository the
 * installation does not hold, and 403 for a refused installation. These are the
 * failures an App without a newly reviewed permission meets first.
 */
function refusedToken({ status, operation }: Classified): Verdict | undefined {
  if ((status !== 422 && status !== 403) || !/^\/app\/installations\/\d+\/access_tokens$/.test(operation.template))
    return undefined;
  const repository = operation.context?.["repository"],
    requested = operation.context?.["permissions"];
  return denied(
    `GitHub would not issue an installation token${repository ? ` for ${repository}` : ""}${requested ? ` with ${requested}` : ""} (HTTP ${status}). The App or its installation does not hold that permission or repository. ${NOT_THE_KEY} The App owner must grant this permission and the installation owner must approve it, or select this repository; other reads may still work.`,
  );
}

export const errors: VendorErrors = {
  headers: ["x-accepted-github-permissions", "x-accepted-oauth-scopes", "x-oauth-scopes", "x-github-sso"],
  // An SSO challenge carries a long signed URL, read only as far as its keyword.
  maxHeaderChars: 512,
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
    refusedToken,
  ],
  detail: ({ status: code }) =>
    code === 401
      ? AUTH
      : code === 409
        ? "GitHub reported a conflict. Read the current state."
        : code === 404
          ? "GitHub returned 404; the resource may be absent or inaccessible to this installation."
          : FAILED,
  statuses: {
    401: () => ({ code: "auth_required", retryable: false }),
    403: refused,
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
