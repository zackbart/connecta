import { valueSafety, safe, redact, refuse, type ValueSafetyTable } from "../_shared/rest/value-safety.js";
import { githubIndex } from "./lib/discovery.js";
import { READ_PERMISSIONS, RELEASE_PERMISSIONS, INTERNAL_READS, MERGE } from "./lib/operations.js";

// Reviewed pinned success paths. Temporary clone tokens and upload destinations
// stay withheld; security-feature settings and public commit signatures carry
// no authentication material. No vendor-wide credential-name exemption.
const RESPONSE_PATHS: Readonly<
  Record<string, { readonly redact: readonly string[]; readonly keep: readonly string[] }>
> = {
  "GET /installation/repositories": {
    "redact": ["repositories[].temp_clone_token"],
    "keep": [],
  },
  "GET /repos/{owner}/{repo}": {
    "redact": [
      "parent.temp_clone_token",
      "source.temp_clone_token",
      "temp_clone_token",
      "template_repository.temp_clone_token",
    ],
    "keep": [
      "security_and_analysis.advanced_security",
      "security_and_analysis.secret_scanning",
      "security_and_analysis.secret_scanning_ai_detection",
      "security_and_analysis.secret_scanning_delegated_alert_dismissal",
      "security_and_analysis.secret_scanning_delegated_bypass",
      "security_and_analysis.secret_scanning_delegated_bypass_options",
      "security_and_analysis.secret_scanning_delegated_bypass_options.reviewers",
      "security_and_analysis.secret_scanning_non_provider_patterns",
    ],
  },
  "GET /repos/{owner}/{repo}/actions/runs": {
    "redact": ["workflow_runs[].head_repository.temp_clone_token", "workflow_runs[].repository.temp_clone_token"],
    "keep": [
      "workflow_runs[].head_repository.security_and_analysis.advanced_security",
      "workflow_runs[].head_repository.security_and_analysis.secret_scanning",
      "workflow_runs[].head_repository.security_and_analysis.secret_scanning_ai_detection",
      "workflow_runs[].head_repository.security_and_analysis.secret_scanning_delegated_alert_dismissal",
      "workflow_runs[].head_repository.security_and_analysis.secret_scanning_delegated_bypass",
      "workflow_runs[].head_repository.security_and_analysis.secret_scanning_delegated_bypass_options",
      "workflow_runs[].head_repository.security_and_analysis.secret_scanning_delegated_bypass_options.reviewers",
      "workflow_runs[].head_repository.security_and_analysis.secret_scanning_non_provider_patterns",
      "workflow_runs[].repository.security_and_analysis.advanced_security",
      "workflow_runs[].repository.security_and_analysis.secret_scanning",
      "workflow_runs[].repository.security_and_analysis.secret_scanning_ai_detection",
      "workflow_runs[].repository.security_and_analysis.secret_scanning_delegated_alert_dismissal",
      "workflow_runs[].repository.security_and_analysis.secret_scanning_delegated_bypass",
      "workflow_runs[].repository.security_and_analysis.secret_scanning_delegated_bypass_options",
      "workflow_runs[].repository.security_and_analysis.secret_scanning_delegated_bypass_options.reviewers",
      "workflow_runs[].repository.security_and_analysis.secret_scanning_non_provider_patterns",
    ],
  },
  "GET /repos/{owner}/{repo}/actions/runs/{run_id}": {
    "redact": ["head_repository.temp_clone_token", "repository.temp_clone_token"],
    "keep": [
      "head_repository.security_and_analysis.advanced_security",
      "head_repository.security_and_analysis.secret_scanning",
      "head_repository.security_and_analysis.secret_scanning_ai_detection",
      "head_repository.security_and_analysis.secret_scanning_delegated_alert_dismissal",
      "head_repository.security_and_analysis.secret_scanning_delegated_bypass",
      "head_repository.security_and_analysis.secret_scanning_delegated_bypass_options",
      "head_repository.security_and_analysis.secret_scanning_delegated_bypass_options.reviewers",
      "head_repository.security_and_analysis.secret_scanning_non_provider_patterns",
      "repository.security_and_analysis.advanced_security",
      "repository.security_and_analysis.secret_scanning",
      "repository.security_and_analysis.secret_scanning_ai_detection",
      "repository.security_and_analysis.secret_scanning_delegated_alert_dismissal",
      "repository.security_and_analysis.secret_scanning_delegated_bypass",
      "repository.security_and_analysis.secret_scanning_delegated_bypass_options",
      "repository.security_and_analysis.secret_scanning_delegated_bypass_options.reviewers",
      "repository.security_and_analysis.secret_scanning_non_provider_patterns",
    ],
  },
  "GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs": {
    "redact": ["workflow_runs[].head_repository.temp_clone_token", "workflow_runs[].repository.temp_clone_token"],
    "keep": [
      "workflow_runs[].head_repository.security_and_analysis.advanced_security",
      "workflow_runs[].head_repository.security_and_analysis.secret_scanning",
      "workflow_runs[].head_repository.security_and_analysis.secret_scanning_ai_detection",
      "workflow_runs[].head_repository.security_and_analysis.secret_scanning_delegated_alert_dismissal",
      "workflow_runs[].head_repository.security_and_analysis.secret_scanning_delegated_bypass",
      "workflow_runs[].head_repository.security_and_analysis.secret_scanning_delegated_bypass_options",
      "workflow_runs[].head_repository.security_and_analysis.secret_scanning_delegated_bypass_options.reviewers",
      "workflow_runs[].head_repository.security_and_analysis.secret_scanning_non_provider_patterns",
      "workflow_runs[].repository.security_and_analysis.advanced_security",
      "workflow_runs[].repository.security_and_analysis.secret_scanning",
      "workflow_runs[].repository.security_and_analysis.secret_scanning_ai_detection",
      "workflow_runs[].repository.security_and_analysis.secret_scanning_delegated_alert_dismissal",
      "workflow_runs[].repository.security_and_analysis.secret_scanning_delegated_bypass",
      "workflow_runs[].repository.security_and_analysis.secret_scanning_delegated_bypass_options",
      "workflow_runs[].repository.security_and_analysis.secret_scanning_delegated_bypass_options.reviewers",
      "workflow_runs[].repository.security_and_analysis.secret_scanning_non_provider_patterns",
    ],
  },
  "GET /repos/{owner}/{repo}/commits": {
    "redact": [],
    "keep": ["[].commit.verification.signature"],
  },
  "GET /repos/{owner}/{repo}/commits/{ref}": {
    "redact": [],
    "keep": ["commit.verification.signature"],
  },
  "GET /repos/{owner}/{repo}/compare/{basehead}": {
    "redact": [],
    "keep": [
      "base_commit.commit.verification.signature",
      "commits[].commit.verification.signature",
      "merge_base_commit.commit.verification.signature",
    ],
  },
  "GET /repos/{owner}/{repo}/issues": {
    "redact": ["[].repository.temp_clone_token"],
    "keep": [],
  },
  "GET /repos/{owner}/{repo}/issues/{issue_number}": {
    "redact": ["repository.temp_clone_token"],
    "keep": [],
  },
  "GET /repos/{owner}/{repo}/pulls": {
    "redact": ["[].base.repo.temp_clone_token", "[].head.repo.temp_clone_token"],
    "keep": [],
  },
  "GET /repos/{owner}/{repo}/pulls/{pull_number}": {
    "redact": ["base.repo.temp_clone_token", "head.repo.temp_clone_token"],
    "keep": [],
  },
  "GET /repos/{owner}/{repo}/pulls/{pull_number}/commits": {
    "redact": [],
    "keep": ["[].commit.verification.signature"],
  },
  "GET /repos/{owner}/{repo}/releases": {
    "redact": ["[].upload_url"],
    "keep": [],
  },
  "POST /repos/{owner}/{repo}/releases": {
    "redact": ["upload_url"],
    "keep": [],
  },
  "GET /repos/{owner}/{repo}/releases/latest": {
    "redact": ["upload_url"],
    "keep": [],
  },
  "GET /repos/{owner}/{repo}/releases/tags/{tag}": {
    "redact": ["upload_url"],
    "keep": [],
  },
  "GET /repos/{owner}/{repo}/releases/{release_id}": {
    "redact": ["upload_url"],
    "keep": [],
  },
  "PATCH /repos/{owner}/{repo}/releases/{release_id}": {
    "redact": ["upload_url"],
    "keep": [],
  },
  "GET /search/code": {
    "redact": ["items[].repository.temp_clone_token"],
    "keep": [
      "items[].repository.security_and_analysis.advanced_security",
      "items[].repository.security_and_analysis.secret_scanning",
      "items[].repository.security_and_analysis.secret_scanning_ai_detection",
      "items[].repository.security_and_analysis.secret_scanning_delegated_alert_dismissal",
      "items[].repository.security_and_analysis.secret_scanning_delegated_bypass",
      "items[].repository.security_and_analysis.secret_scanning_delegated_bypass_options",
      "items[].repository.security_and_analysis.secret_scanning_delegated_bypass_options.reviewers",
      "items[].repository.security_and_analysis.secret_scanning_non_provider_patterns",
    ],
  },
  "GET /search/issues": {
    "redact": ["items[].repository.temp_clone_token"],
    "keep": [],
  },
  "GET /search/repositories": {
    "redact": ["items[].temp_clone_token"],
    "keep": [],
  },
};

export const SAFETY: ValueSafetyTable = {
  title: "GitHub",
  embeddedUrls: {
    operations: Object.fromEntries(
      githubIndex.ops
        .filter((op) => READ_PERMISSIONS[`${op.method} ${op.path}`] || RELEASE_PERMISSIONS[`${op.method} ${op.path}`])
        .map((op) => [
          `${op.method} ${op.path}`,
          githubIndex
            .fields(op)
            .filter((f) => f.in === "response" && /(?:^|\.)(?:body|patch|download_url)$/.test(f.path))
            .map((f) => f.path),
        ]),
    ),
  },
  operations: Object.fromEntries(
    githubIndex.ops.map((op) => {
      const key = `${op.method} ${op.path}`,
        reviewed = RESPONSE_PATHS[key];
      return [
        key,
        READ_PERMISSIONS[key] || RELEASE_PERMISSIONS[key] || INTERNAL_READS.has(key) || key === MERGE
          ? reviewed?.redact.length
            ? redact(
                "Temporary repository clone tokens and upload destinations are withheld; security-feature settings and public commit signatures are metadata.",
                reviewed.redact,
                reviewed.keep,
              )
            : safe(
                "Reviewed repository metadata, authored content or release/merge record; public verification signatures contain no private key.",
                reviewed?.keep,
              )
          : refuse(
              "Outside the reviewed repository resource allowlist; credential, signing, administrative and download operations are unavailable.",
            ),
      ];
    }),
  ),
  fields: {
    token: { verdict: "redact", reason: "Tokens never leave private authentication." },
    key: { verdict: "redact", reason: "Deploy-key material is permanently withheld." },
    private_key: { verdict: "redact", reason: "Private key material is never returned." },
    secret: { verdict: "redact", reason: "Stored secrets are never returned." },
    download_url: {
      verdict: "redact",
      reason: "File download URLs can expire or carry a private credential; use inline content.",
    },
  },
};
export const githubSafety = valueSafety(SAFETY, () => githubIndex);
