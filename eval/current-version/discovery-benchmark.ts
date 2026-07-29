import { encodingForModel } from "js-tiktoken";

import { rankTools } from "../../src/catalog.js";
import type { ToolDef } from "../../src/types.js";

type CatalogTool = ToolDef & {
  address: string;
  connector: string;
};

type BenchmarkQuery = {
  category: "direct" | "conversational" | "multi-intent" | "negative";
  query: string;
  relevant: string[];
};

type SearchResult = {
  mode?: "partial";
  total: number;
  tools: CatalogTool[];
};

type Variant = {
  name: string;
  search(query: string): SearchResult;
};

const connectorDescriptions: Record<string, string> = {
  npm: "npm registry package metadata and download analytics",
  github: "GitHub repositories, issues, pull requests, commits, and releases",
  calendar: "Calendar events, availability, and scheduling",
  drive: "Cloud file storage, folders, and sharing",
  notion: "Notion pages, databases, and blocks",
  slack: "Slack messages, channels, and users",
  cloudflare: "Cloudflare Workers, DNS, zones, and analytics",
  billing: "Billing invoices, subscriptions, plans, and customers",
  stripe: "Stripe payments, charges, refunds, and customers",
  linear: "Linear issues, projects, teams, and roadmaps",
};

const definitions: Record<
  string,
  Array<[name: string, description: string]>
> = {
  npm: [
    ["search_packages", "Search the npm registry for packages by keywords."],
    [
      "get_package",
      "Get exact npm package metadata including versions, dependencies, license, and maintainers.",
    ],
    [
      "get_download_counts",
      "Read daily, weekly, or monthly npm download counts for a package.",
    ],
    ["list_maintainers", "List the maintainers of an npm package."],
    ["get_dist_tags", "Get npm distribution tags such as latest and next."],
    ["get_package_versions", "List all published versions of an npm package."],
  ],
  github: [
    [
      "get_repository",
      "Get a GitHub repository including stars, forks, owner, and open issue count.",
    ],
    ["search_repositories", "Search GitHub repositories by keyword or topic."],
    ["list_issues", "List repository issues filtered by state and labels."],
    ["get_issue", "Get one GitHub issue by repository and issue number."],
    ["list_pull_requests", "List open or closed pull requests in a repository."],
    ["get_pull_request", "Get one pull request with merge and review details."],
    ["list_releases", "List repository releases and version tags."],
    ["compare_commits", "Compare two commits, branches, or tags."],
    ["list_workflow_runs", "List GitHub Actions workflow runs and CI status."],
  ],
  calendar: [
    ["list_events", "List calendar events in a date range."],
    ["get_event", "Get one calendar event by identifier."],
    [
      "find_free_time",
      "Find mutual free time and availability across calendars.",
    ],
    ["create_event", "Create a calendar event and invite attendees."],
    ["update_event", "Update an existing calendar event."],
    ["delete_event", "Delete or cancel a calendar event."],
  ],
  drive: [
    ["search_files", "Search cloud drive files by name, type, or full text."],
    ["get_file", "Get or download a file and its metadata from cloud drive."],
    ["list_folder", "List files and child folders in a drive folder."],
    ["create_folder", "Create a folder in cloud drive."],
    ["upload_file", "Upload a new file to cloud drive."],
    ["share_file", "Create or update sharing permissions for a drive file."],
  ],
  notion: [
    ["search_pages", "Search Notion pages and databases by title."],
    ["fetch_page", "Fetch a Notion page with its properties and content."],
    ["query_database", "Query and filter rows in a Notion database."],
    ["create_page", "Create a page in a Notion workspace or database."],
    ["update_page", "Update Notion page properties or archive the page."],
    ["append_blocks", "Append content blocks to a Notion page."],
  ],
  slack: [
    ["search_messages", "Search Slack messages across channels."],
    ["list_channels", "List Slack channels visible to the user."],
    ["get_thread", "Get a Slack message thread and its replies."],
    ["post_message", "Post a message to a Slack channel."],
    ["add_reaction", "Add an emoji reaction to a Slack message."],
    ["get_user", "Get a Slack user profile and contact information."],
  ],
  cloudflare: [
    ["list_workers", "List deployed Cloudflare Worker scripts."],
    ["get_worker", "Get a Cloudflare Worker script and configuration."],
    ["tail_worker_logs", "Read recent runtime logs and errors for a Worker."],
    ["list_dns_records", "List DNS records for a Cloudflare zone."],
    ["create_dns_record", "Create a DNS record in a Cloudflare zone."],
    ["query_analytics", "Query request, bandwidth, and cache analytics."],
    ["list_zones", "List Cloudflare zones and their status."],
  ],
  billing: [
    ["list_invoices", "List invoices filtered by paid, open, or overdue status."],
    ["get_invoice", "Get an invoice with line items and balance."],
    ["list_subscriptions", "List customer subscriptions and renewal state."],
    ["get_plan", "Get billing plan pricing and limits."],
    ["list_customers", "List billing customer accounts."],
    ["get_usage", "Get metered product usage for a billing period."],
  ],
  stripe: [
    ["search_customers", "Search Stripe customers by email or name."],
    ["list_payments", "List Stripe payment intents and their status."],
    ["get_charge", "Get one Stripe charge and payment details."],
    ["create_refund", "Refund a Stripe charge or payment."],
    ["list_disputes", "List disputed Stripe payments and evidence deadlines."],
    ["get_balance", "Get the available and pending Stripe account balance."],
  ],
  linear: [
    ["search_issues", "Search Linear issues by text, team, or status."],
    ["get_issue", "Get one Linear issue by identifier."],
    ["list_projects", "List Linear projects and milestones."],
    ["get_project", "Get one Linear project and its progress."],
    ["create_issue", "Create a Linear issue in a team."],
    ["update_issue", "Update Linear issue status, assignee, or priority."],
  ],
};

const catalog: CatalogTool[] = Object.entries(definitions).flatMap(
  ([connector, tools]) =>
    tools.map(([name, description]) => ({
      connector,
      address: `${connector}.${name}`,
      name,
      description,
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: `Input for ${name}`,
          },
        },
      },
    })),
);

const queries: BenchmarkQuery[] = [
  {
    category: "direct",
    query: "npm package weekly downloads",
    relevant: ["npm.get_download_counts"],
  },
  {
    category: "direct",
    query: "exact npm package metadata dependencies",
    relevant: ["npm.get_package"],
  },
  {
    category: "direct",
    query: "search npm registry packages",
    relevant: ["npm.search_packages"],
  },
  {
    category: "direct",
    query: "npm dist tags latest",
    relevant: ["npm.get_dist_tags"],
  },
  {
    category: "direct",
    query: "GitHub repository stars forks",
    relevant: ["github.get_repository"],
  },
  {
    category: "direct",
    query: "GitHub issue 177",
    relevant: ["github.get_issue"],
  },
  {
    category: "direct",
    query: "open pull requests repository",
    relevant: ["github.list_pull_requests"],
  },
  {
    category: "direct",
    query: "repository release tags",
    relevant: ["github.list_releases"],
  },
  {
    category: "direct",
    query: "GitHub Actions CI status",
    relevant: ["github.list_workflow_runs"],
  },
  {
    category: "direct",
    query: "mutual calendar availability",
    relevant: ["calendar.find_free_time"],
  },
  {
    category: "direct",
    query: "calendar events date range",
    relevant: ["calendar.list_events"],
  },
  {
    category: "direct",
    query: "download drive file",
    relevant: ["drive.get_file"],
  },
  {
    category: "direct",
    query: "sharing permissions drive",
    relevant: ["drive.share_file"],
  },
  {
    category: "direct",
    query: "filter Notion database rows",
    relevant: ["notion.query_database"],
  },
  {
    category: "direct",
    query: "Slack thread replies",
    relevant: ["slack.get_thread"],
  },
  {
    category: "direct",
    query: "Worker runtime error logs",
    relevant: ["cloudflare.tail_worker_logs"],
  },
  {
    category: "direct",
    query: "DNS records zone",
    relevant: ["cloudflare.list_dns_records"],
  },
  {
    category: "direct",
    query: "overdue unpaid invoices",
    relevant: ["billing.list_invoices"],
  },
  {
    category: "direct",
    query: "metered billing usage period",
    relevant: ["billing.get_usage"],
  },
  {
    category: "direct",
    query: "refund Stripe charge",
    relevant: ["stripe.create_refund"],
  },
  {
    category: "direct",
    query: "Stripe pending balance",
    relevant: ["stripe.get_balance"],
  },
  {
    category: "direct",
    query: "Linear project progress",
    relevant: ["linear.get_project"],
  },
  {
    category: "conversational",
    query: "can you find me the weekly download count for this npm package",
    relevant: ["npm.get_download_counts"],
  },
  {
    category: "conversational",
    query: "show me all of the current open PRs in our GitHub repo please",
    relevant: ["github.list_pull_requests"],
  },
  {
    category: "conversational",
    query: "I want to look up the details for issue 177 on GitHub",
    relevant: ["github.get_issue"],
  },
  {
    category: "conversational",
    query: "could you find a time when everyone is free on the calendar",
    relevant: ["calendar.find_free_time"],
  },
  {
    category: "conversational",
    query: "please show me the latest releases for our repository",
    relevant: ["github.list_releases"],
  },
  {
    category: "conversational",
    query: "find the file in drive and let me download it",
    relevant: ["drive.search_files", "drive.get_file"],
  },
  {
    category: "conversational",
    query: "can you pull up the Notion page content for me",
    relevant: ["notion.fetch_page"],
  },
  {
    category: "conversational",
    query: "show the recent errors from our deployed worker",
    relevant: ["cloudflare.tail_worker_logs"],
  },
  {
    category: "conversational",
    query: "which invoices are still open and overdue right now",
    relevant: ["billing.list_invoices"],
  },
  {
    category: "conversational",
    query: "I need to send that payment back to the customer",
    relevant: ["stripe.create_refund"],
  },
  {
    category: "multi-intent",
    query: "npm download counts and package metadata",
    relevant: ["npm.get_download_counts", "npm.get_package"],
  },
  {
    category: "multi-intent",
    query: "GitHub repository details releases and open issues",
    relevant: [
      "github.get_repository",
      "github.list_releases",
      "github.list_issues",
    ],
  },
  {
    category: "multi-intent",
    query: "find a drive file and share it",
    relevant: ["drive.search_files", "drive.share_file"],
  },
  {
    category: "multi-intent",
    query: "search Slack messages and fetch the matching thread",
    relevant: ["slack.search_messages", "slack.get_thread"],
  },
  {
    category: "multi-intent",
    query: "get Cloudflare zones DNS records and request analytics",
    relevant: [
      "cloudflare.list_zones",
      "cloudflare.list_dns_records",
      "cloudflare.query_analytics",
    ],
  },
  {
    category: "multi-intent",
    query: "find the Linear issue and its project progress",
    relevant: ["linear.get_issue", "linear.get_project"],
  },
  {
    category: "multi-intent",
    query: "customer subscription invoices and billing usage",
    relevant: [
      "billing.list_subscriptions",
      "billing.list_invoices",
      "billing.get_usage",
    ],
  },
  {
    category: "multi-intent",
    query: "npm downloads GitHub repository and release tags",
    relevant: [
      "npm.get_download_counts",
      "github.get_repository",
      "github.list_releases",
    ],
  },
  {
    category: "negative",
    query: "Kubernetes pod restart policy",
    relevant: [],
  },
  {
    category: "negative",
    query: "weather radar and rain forecast",
    relevant: [],
  },
  {
    category: "negative",
    query: "edit the photo background and crop it",
    relevant: [],
  },
  {
    category: "negative",
    query: "book a restaurant table",
    relevant: [],
  },
];

const normalize = (text: string): string =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const rawTerms = (text: string): string[] =>
  normalize(text).split(/\s+/).filter(Boolean);

const stopwords = new Set([
  "a",
  "all",
  "an",
  "and",
  "are",
  "can",
  "could",
  "current",
  "for",
  "from",
  "i",
  "in",
  "into",
  "it",
  "latest",
  "let",
  "me",
  "most",
  "of",
  "on",
  "our",
  "please",
  "right",
  "show",
  "that",
  "the",
  "this",
  "to",
  "up",
  "want",
  "when",
  "which",
  "with",
  "you",
]);

const contentTerms = (text: string): string[] => {
  const filtered = rawTerms(text).filter((term) => !stopwords.has(term));
  return filtered.length > 0 ? [...new Set(filtered)] : rawTerms(text);
};

const baselineSearch = (query: string): SearchResult => {
  let ranked = rankTools(catalog, query, "all");
  let mode: "partial" | undefined;
  if (query.trim() && ranked.length === 0) {
    ranked = rankTools(catalog, query, "partial");
    if (ranked.length > 0) mode = "partial";
  }
  ranked.sort((a, b) => b.score - a.score || a.order - b.order);
  return {
    ...(mode ? { mode } : {}),
    total: ranked.length,
    tools: ranked.slice(0, 25).map((entry) => entry.tool as CatalogTool),
  };
};

const cleanedBaselineSearch = (
  query: string,
  options: { minCoverage?: number; relativeCutoff?: number; cap?: number } = {},
): SearchResult => {
  const terms = contentTerms(query);
  const cleaned = terms.join(" ");
  let ranked = rankTools(catalog, cleaned, "all");
  let mode: "partial" | undefined;
  if (cleaned && ranked.length === 0) {
    ranked = rankTools(catalog, cleaned, "partial");
    if (ranked.length > 0) mode = "partial";
  }
  ranked.sort((a, b) => b.score - a.score || a.order - b.order);
  if (mode && ranked.length > 0) {
    const best = ranked[0]?.score ?? 0;
    ranked = ranked.filter((entry) => {
      const haystack = normalize(
        `${entry.tool.name} ${entry.tool.description ?? ""}`,
      );
      const coverage =
        terms.filter((term) => haystack.includes(term)).length / terms.length;
      return (
        coverage >= (options.minCoverage ?? 0) &&
        entry.score >= best * (options.relativeCutoff ?? 0)
      );
    });
  }
  return {
    ...(mode && ranked.length > 0 ? { mode } : {}),
    total: ranked.length,
    tools: ranked.slice(0, options.cap ?? 25).map((entry) => entry.tool as CatalogTool),
  };
};

const stem = (term: string): string => {
  if (term.length > 4 && term.endsWith("ies")) return `${term.slice(0, -3)}y`;
  if (term.length > 4 && term.endsWith("s")) return term.slice(0, -1);
  return term;
};

const documentTokens = catalog.map((tool) => {
  const nameParts = rawTerms(tool.name).map(stem);
  const suffixAcronyms = nameParts
    .slice(1)
    .map((_, index) =>
      nameParts
        .slice(index + 1)
        .map((term) => term[0])
        .join(""),
    )
    .filter((term) => term.length >= 2);
  const name = new Set([...nameParts, ...suffixAcronyms]);
  const description = new Set(
    rawTerms(
      `${tool.description ?? ""} ${tool.connector} ${
        connectorDescriptions[tool.connector] ?? ""
      }`,
    ).map(stem),
  );
  return { tool, name, description };
});

const documentFrequency = new Map<string, number>();
for (const document of documentTokens) {
  for (const term of new Set([...document.name, ...document.description])) {
    documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  }
}

const idf = (term: string): number =>
  Math.log((catalog.length + 1) / ((documentFrequency.get(term) ?? 0) + 1)) + 1;

const tokenSetMatches = (tokens: Set<string>, queryTerm: string): boolean =>
  tokens.has(queryTerm) ||
  (queryTerm.length >= 4 &&
    [...tokens].some((token) => token.startsWith(queryTerm)));

const boundarySearch = (
  query: string,
  options: { cap: number },
): SearchResult => {
  const terms = contentTerms(query).map(stem);
  const scored = documentTokens
    .map((document, order) => {
      const matched = terms.filter(
        (term) =>
          tokenSetMatches(document.name, term) ||
          tokenSetMatches(document.description, term),
      );
      if (matched.length === 0) return null;
      const nameMatches = matched.filter((term) =>
        tokenSetMatches(document.name, term),
      ).length;
      return {
        ...document,
        matched: matched.length,
        score: matched.length * 1_000 + nameMatches,
        order,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  const allMode = scored.some((entry) => entry.matched === terms.length);
  const candidates = (allMode
    ? scored.filter((entry) => entry.matched === terms.length)
    : scored
  ).sort((a, b) => b.score - a.score || a.order - b.order);
  return {
    ...(!allMode && candidates.length > 0
      ? { mode: "partial" as const }
      : {}),
    total: candidates.length,
    tools: candidates.slice(0, options.cap).map((entry) => entry.tool),
  };
};

const weightedSearch = (
  query: string,
  options: { relativeCutoff: number; cap: number },
): SearchResult => {
  const phrase = normalize(query);
  const terms = contentTerms(query).map(stem);
  const scored = documentTokens
    .map((document, order) => {
      const matched = terms.filter(
        (term) =>
          document.name.has(term) || document.description.has(term),
      );
      if (matched.length === 0) return null;
      const coverage = matched.length / terms.length;
      const nameCoverage =
        matched.filter((term) => document.name.has(term)).length / terms.length;
      let score = matched.reduce(
        (sum, term) =>
          sum +
          idf(term) *
            (document.name.has(term) ? 4 : 1),
        0,
      );
      const normalizedName = normalize(document.tool.name);
      if (normalizedName === phrase) score += 25;
      else if (normalizedName.includes(phrase)) score += 12;
      score += coverage * 4 + nameCoverage * 3;
      return { ...document, matched: matched.length, coverage, score, order };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    .sort((a, b) => b.score - a.score || a.order - b.order);

  if (scored.length === 0) return { total: 0, tools: [] };
  const allMode = scored.some((entry) => entry.matched === terms.length);
  const candidates = allMode
    ? scored.filter((entry) => entry.matched === terms.length)
    : scored;
  const best = candidates[0]?.score ?? 0;
  const minimumMatches = terms.length >= 4 ? 2 : 1;
  const selected = candidates.filter(
    (entry) =>
      entry.matched >= minimumMatches &&
      entry.score >= best * options.relativeCutoff,
  );
  return {
    ...(!allMode && selected.length > 0 ? { mode: "partial" as const } : {}),
    total: selected.length,
    tools: selected.slice(0, options.cap).map((entry) => entry.tool),
  };
};

const variants: Variant[] = [
  { name: "current", search: baselineSearch },
  {
    name: "stopwords",
    search: (query) => cleanedBaselineSearch(query),
  },
  {
    name: "stopwords+cap8",
    search: (query) => cleanedBaselineSearch(query, { cap: 8 }),
  },
  {
    name: "stopwords+cap5",
    search: (query) => cleanedBaselineSearch(query, { cap: 5 }),
  },
  {
    name: "token-boundary+connector+cap8",
    search: (query) => boundarySearch(query, { cap: 8 }),
  },
  {
    name: "stopwords+coverage40",
    search: (query) =>
      cleanedBaselineSearch(query, { minCoverage: 0.4 }),
  },
  {
    name: "stopwords+coverage40+cutoff50",
    search: (query) =>
      cleanedBaselineSearch(query, {
        minCoverage: 0.4,
        relativeCutoff: 0.5,
        cap: 8,
      }),
  },
  {
    name: "idf+cutoff40",
    search: (query) =>
      weightedSearch(query, { relativeCutoff: 0.4, cap: 8 }),
  },
  {
    name: "idf+cutoff55",
    search: (query) =>
      weightedSearch(query, { relativeCutoff: 0.55, cap: 8 }),
  },
  {
    name: "idf+cutoff70",
    search: (query) =>
      weightedSearch(query, { relativeCutoff: 0.7, cap: 5 }),
  },
];

const encoder = encodingForModel("gpt-4o");

const renderResponse = (result: SearchResult): string => {
  const groups = new Map<
    string,
    {
      id: string;
      description: string;
      tools: Array<{ name: string; address: string; description?: string }>;
    }
  >();
  for (const tool of result.tools) {
    let group = groups.get(tool.connector);
    if (!group) {
      group = {
        id: tool.connector,
        description: connectorDescriptions[tool.connector] ?? "",
        tools: [],
      };
      groups.set(tool.connector, group);
    }
    group.tools.push({
      name: tool.name,
      address: tool.address,
      ...(tool.description ? { description: tool.description } : {}),
    });
  }
  return JSON.stringify({
    connectors: [...groups.values()],
    total: result.total,
    offset: 0,
    limit: 25,
    hasMore: result.tools.length < result.total,
    ...(result.tools.length < result.total
      ? { nextOffset: result.tools.length }
      : {}),
    ...(result.mode ? { matchMode: result.mode } : {}),
  });
};

const round = (value: number): number => Math.round(value * 1_000) / 1_000;

const evaluate = (variant: Variant) => {
  const cases = queries.map((item) => {
    const result = variant.search(item.query);
    const addresses = result.tools.map((tool) => tool.address);
    const expected = new Set(item.relevant);
    const relevantReturned = addresses.filter((address) =>
      expected.has(address),
    );
    const firstRelevant = addresses.findIndex((address) =>
      expected.has(address),
    );
    const positive = item.relevant.length > 0;
    return {
      ...item,
      addresses,
      returned: addresses.length,
      relevantReturned: relevantReturned.length,
      irrelevant: addresses.length - relevantReturned.length,
      top1: positive && expected.has(addresses[0] ?? "") ? 1 : 0,
      reciprocalRank:
        positive && firstRelevant >= 0 ? 1 / (firstRelevant + 1) : 0,
      recall: positive
        ? relevantReturned.length / item.relevant.length
        : addresses.length === 0
          ? 1
          : 0,
      precision:
        addresses.length > 0
          ? relevantReturned.length / addresses.length
          : positive
            ? 0
            : 1,
      responseTokens: encoder.encode(renderResponse(result)).length,
      mode: result.mode ?? "all",
    };
  });
  const positives = cases.filter((item) => item.relevant.length > 0);
  const negatives = cases.filter((item) => item.relevant.length === 0);
  const sum = (select: (item: (typeof cases)[number]) => number): number =>
    cases.reduce((total, item) => total + select(item), 0);
  const sumPositive = (
    select: (item: (typeof positives)[number]) => number,
  ): number => positives.reduce((total, item) => total + select(item), 0);
  const categorySummary = Object.fromEntries(
    [...new Set(cases.map((item) => item.category))].map((category) => {
      const selected = cases.filter((item) => item.category === category);
      const selectedPositive = selected.filter(
        (item) => item.relevant.length > 0,
      );
      const selectedSum = (
        select: (item: (typeof selected)[number]) => number,
      ): number => selected.reduce((total, item) => total + select(item), 0);
      return [
        category,
        {
          queries: selected.length,
          top1Accuracy:
            selectedPositive.length > 0
              ? round(
                  selectedPositive.reduce(
                    (total, item) => total + item.top1,
                    0,
                  ) / selectedPositive.length,
                )
              : undefined,
          meanRecall: round(
            selectedSum((item) => item.recall) / selected.length,
          ),
          meanPrecision: round(
            selectedSum((item) => item.precision) / selected.length,
          ),
          meanReturned: round(
            selectedSum((item) => item.returned) / selected.length,
          ),
          meanResponseTokens: round(
            selectedSum((item) => item.responseTokens) / selected.length,
          ),
        },
      ];
    }),
  );
  return {
    name: variant.name,
    summary: {
      top1Accuracy: round(sumPositive((item) => item.top1) / positives.length),
      mrr: round(sumPositive((item) => item.reciprocalRank) / positives.length),
      positiveMeanRecall: round(
        sumPositive((item) => item.recall) / positives.length,
      ),
      meanRecall: round(sum((item) => item.recall) / cases.length),
      meanPrecision: round(sum((item) => item.precision) / cases.length),
      meanReturned: round(sum((item) => item.returned) / cases.length),
      meanIrrelevant: round(sum((item) => item.irrelevant) / cases.length),
      meanResponseTokens: round(
        sum((item) => item.responseTokens) / cases.length,
      ),
      totalResponseTokens: sum((item) => item.responseTokens),
      negativeFalsePositiveRate: round(
        negatives.filter((item) => item.returned > 0).length / negatives.length,
      ),
      partialQueries: cases.filter((item) => item.mode === "partial").length,
    },
    categorySummary,
    cases,
  };
};

const evaluations = variants.map(evaluate);
const baseline = evaluations[0];
if (!baseline) throw new Error("Missing baseline evaluation");

const summaries = evaluations.map((evaluation) => ({
  variant: evaluation.name,
  ...evaluation.summary,
  tokenChangeVsCurrent: round(
    (evaluation.summary.totalResponseTokens -
      baseline.summary.totalResponseTokens) /
      baseline.summary.totalResponseTokens,
  ),
}));

const selectedCandidate = evaluations.find(
  (evaluation) => evaluation.name === "stopwords+cap8",
);
if (!selectedCandidate) throw new Error("Missing selected candidate");

const changedCases = queries
  .map((item, index) => {
    const before = baseline.cases[index];
    const after = selectedCandidate.cases[index];
    if (!before || !after) throw new Error("Evaluation case mismatch");
    return {
      category: item.category,
      query: item.query,
      relevant: item.relevant,
      current: before.addresses,
      candidate: after.addresses,
      currentRecall: round(before.recall),
      candidateRecall: round(after.recall),
      currentPrecision: round(before.precision),
      candidatePrecision: round(after.precision),
      currentTokens: before.responseTokens,
      candidateTokens: after.responseTokens,
    };
  })
  .filter(
    (item) =>
      JSON.stringify(item.current) !== JSON.stringify(item.candidate),
  );

console.log(
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      currentCommit: process.env.CONNECTA_COMMIT ?? "working-tree",
      catalogTools: catalog.length,
      queryCount: queries.length,
      categoryCounts: Object.fromEntries(
        [...new Set(queries.map((item) => item.category))].map((category) => [
          category,
          queries.filter((item) => item.category === category).length,
        ]),
      ),
      metrics: {
        top1Accuracy: "First returned tool is relevant; positive queries only.",
        mrr: "Mean reciprocal rank of first relevant tool; positive queries only.",
        meanRecall: "Relevant tools returned / labeled relevant tools; negative queries score 1 only when empty.",
        meanPrecision: "Relevant tools / returned tools; empty negative results score 1.",
        tokenCount:
          "o200k_base-compatible gpt-4o tokenizer over simulated grouped search_tools JSON.",
      },
      summaries,
      selectedCandidate: {
        name: selectedCandidate.name,
        categorySummary: selectedCandidate.categorySummary,
      },
      currentCategorySummary: baseline.categorySummary,
      changedCases,
    },
    null,
    2,
  ),
);
