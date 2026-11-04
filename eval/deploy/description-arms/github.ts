import { hatchDiscovery, type ProviderTable } from "./types.js";

const READ_RULES =
  "In commits/{ref} and compare/{basehead}, encode branch-name slashes as %2F. Owner-prefixed object refs are refused; PR-list head filters require login:branch. Pass page.nextCursor as cursor; raw page numbers, diffs and log downloads are refused.";

export const GITHUB: ProviderTable = {
  tools: {
    ...hatchDiscovery(
      "GitHub",
      '{"query":"list releases"}',
      '{"method":"POST","path":"/repos/{owner}/{repo}/releases"}',
      "github",
    ),
    github_api_read: {
      terse: `Read reviewed GitHub repository operations. ${READ_RULES}`,
      disambiguation: `Read one known repository record or file, such as /repos/alice/widget/contents/src/index.ts; search_scoped finds records. ${READ_RULES}`,
      example: `Read reviewed GitHub repository operations. Example: {"path":"/repos/alice/widget/contents/src/index.ts","query":{"ref":"main"}}. ${READ_RULES}`,
    },
    github_api_write: {
      terse: "Create, update or delete a GitHub release; nothing else. Use merge_pull_request for merges.",
      disambiguation:
        "Create, update or delete a GitHub release after github_api_details gives its body; nothing else. Use merge_pull_request for merges.",
      example:
        'Create, update or delete a GitHub release; nothing else. Example: {"method":"POST","path":"/repos/alice/widget/releases","body":{"tag_name":"v1.0.0","draft":true}}. Use merge_pull_request for merges.',
    },
    list_scopes: {
      terse: "List configured GitHub grants, or verified reachable repositories for one owner.",
      disambiguation:
        "List what this connection may reach: local grants without owner, verified repositories with one. Use search_scoped to find records.",
      example: 'List GitHub grants, or verified repositories for one owner. Example: {"owner":"alice","limit":100}.',
    },
    search_scoped: {
      terse: "Search GitHub repositories, issues, pull requests or code within configured scopes.",
      disambiguation:
        "Search repositories, issues, pull requests or code within configured scopes; github_api_read reads one known record.",
      example:
        'Search GitHub repositories, issues, pull requests or code within scopes. Example: {"terms":"login bug","kind":"issues","scopes":[{"repo":"alice/widget"}]}.',
    },
    merge_pull_request: {
      terse:
        "Merge a same-repository pull request once, guarded by expected head SHA and workflow-write scope. A failed preflight sends no merge.",
      disambiguation:
        "Merge a same-repository pull request once; github_api_write cannot. Guarded by expected head SHA and workflow-write scope; a failed preflight sends no merge.",
      example:
        'Merge a same-repository pull request once, guarded by head SHA and workflow-write scope; a failed preflight sends no merge. Example: {"owner":"alice","repo":"widget","pull_number":7,"sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","merge_method":"squash"}.',
    },
  },
};
