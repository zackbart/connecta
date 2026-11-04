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

const WITHHELD = "its reason is withheld";
const WAIT = "After a burst of requests, wait a minute before one retry.";
const ALL_REFUSED =
  "If every GitHub call through this connection is refused, verify the App ID, private key and installation.";
const OTHER_CAUSES =
  "An unmarked secondary rate limit, an IP allow list or a repository or organization policy can also refuse a request with sufficient permissions, and repeated invalid credentials can lock out authentication with a 403.";
const REMEDIES =
  "A rate limit or lockout clears with time; a confirmed permission or repository gap needs the App owner and installation owner; a confirmed policy or IP restriction needs an administrator.";

/**
 * A 403 establishes a refusal and not its cause: classification never reads
 * GitHub's prose, and the permission headers describe the endpoint rather than
 * this token. Each message says what is known, what is likely, then what to do.
 */
function refused({ headers, operation, status }: Classified): Verdict {
  // Only the App's own JWT is in play here, so no repository grant can explain it.
  if (operation.template === "/app/installations")
    return {
      code: "auth_required",
      retryable: false,
      words: () =>
        `GitHub refused the App's own request to list its installations (HTTP ${status}), before any repository permission applied; ${WITHHELD}. A lockout after repeated invalid credentials is likely, and an unmarked secondary rate limit, IP allow list or policy is possible. ${WAIT} If it persists, verify the GitHub App ID and private key.`,
    };
  const repository = operation.context?.["repository"];
  const where = repository ? `for ${repository}` : "for this resource";
  if (/^required(?:;|$)/i.test(headers["x-github-sso"] ?? ""))
    return denied(
      `GitHub refused this request ${where}: the organization enforces SAML single sign-on and this credential is not authorized for it. An organization owner must authorize it; replacing the key will not change this.`,
    );
  const accepted = acceptedPermissions(headers["x-accepted-github-permissions"]);
  const scopes = accepted ? undefined : missingScopes(headers["x-accepted-oauth-scopes"], headers["x-oauth-scopes"]);
  const requested = operation.context?.["permissions"];
  const need = accepted
    ? ` This endpoint accepts ${accepted}.`
    : scopes
      ? ` This endpoint lists the OAuth scope ${scopes}, which this token does not report.`
      : requested
        ? ` This call requested ${requested}.`
        : "";
  return denied(
    `GitHub refused this request ${where} (HTTP ${status}); ${WITHHELD}.${need} The likely cause is access the App or its installation does not hold. ${OTHER_CAUSES} Report this as an access gap and continue with other repositories; do not reset the credential or switch tools on this result alone. ${WAIT} ${REMEDIES} ${ALL_REFUSED}`,
  );
}

function denied(message: string): Verdict {
  return { code: "provider_permission_denied", retryable: false, words: () => message };
}

/**
 * GitHub documents a mint's 422 as a validation failure or spam protection, so
 * the status alone never establishes a permission gap. `missing` is the positive
 * evidence: requested permissions absent from GitHub's own installation record.
 */
function refusedToken({ status, operation }: Classified): Verdict | undefined {
  if ((status !== 422 && status !== 403) || !/^\/app\/installations\/\d+\/access_tokens$/.test(operation.template))
    return undefined;
  const repository = operation.context?.["repository"],
    requested = operation.context?.["permissions"],
    missing = operation.context?.["missing"];
  const asked = `GitHub would not issue an installation token${repository ? ` for ${repository}` : ""}${requested ? ` with ${requested}` : ""} (HTTP ${status})`;
  if (missing)
    return denied(
      `${asked}. The installation does not hold ${missing}. Report this as an access gap; other reads may still work. The App owner must grant that permission and the installation owner must approve it; replacing the key will not add it.`,
    );
  if (status === 422)
    return {
      code: "connector_call_failed",
      retryable: false,
      words: () =>
        `${asked}; ${WITHHELD}. GitHub documents this status for validation failures and spam protection, so a missing permission or repository is possible but not established. Report this failure; other reads may still work. Wait before one retry, and if it persists check the permissions and repositories granted to this installation.`,
    };
  return denied(
    `${asked}; ${WITHHELD}. A suspended installation, an IP allow list or policy, an unmarked secondary rate limit or a lockout after repeated invalid credentials can each cause this. Report this failure; other repositories may still work. ${WAIT} ${ALL_REFUSED}`,
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
  hatch: { name: GITHUB_HATCH.name, verdicts: GITHUB_HATCH.verdicts },
  errors: errorMeanings(errors)!,
  idempotencyKey: false,
};
