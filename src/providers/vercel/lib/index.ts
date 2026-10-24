// Reviewed discovery supplements for gaps in the pinned vendor's prose.
// Paths, classifications and response properties remain the pin's; local
// record-count limits are explicitly narrowed to positive integers.
import type { OpenApiData } from "../../_shared/rest/operation-index.js";

const SUMMARIES: Readonly<Record<string, string>> = {
  "POST /api-keys": "Create an AI Gateway API key (credential minting is refused).",
  "GET /domains/records/{recordId}": "Read one DNS record by its observed record id.",
  "PUT /domains/{domain}/records": "Replace a domain's DNS records.",
  "POST /speed-insights/toggle": "Enable or disable Speed Insights for a project.",
  "POST /web/insights/toggle": "Enable or disable Web Analytics insights for a project.",
  "POST /v2/observability/query": "Query observability metrics without persisting changes.",
  "GET /v2/observability/schema": "List the observability metrics and their query schema.",
  "GET /v2/observability/schema/{metricId}": "Read the query schema for one observability metric.",
  "GET /v3/deployments/{idOrUrl}/events": "Get deployment build logs and events without following live output.",
  "GET /v1/projects/{projectId}/deployments/{deploymentId}/runtime-logs":
    "Get deployment runtime request logs through the bounded named reader.",
  "POST /v10/projects/{idOrName}/env": "Create or replace a project environment variable (env var).",
  "GET /v10/projects/{idOrName}/env":
    "List project environment variables (env vars); use the metadata-only named reader.",
  "PATCH /v9/projects/{idOrName}/env/{id}": "Update a project environment variable (env var) by id.",
  "DELETE /v9/projects/{idOrName}/env/{id}": "Delete a project environment variable (env var) by id.",
};
const PARAMETERS: Readonly<Record<string, string>> = {
  teamId:
    "Team identifier for this call; overrides the connection's routing default. Token permissions enforce access.",
  slug: "Human-readable team slug for this call; overrides the routing default when teamId is omitted.",
  domain: "Domain hostname, without a scheme or URL path.",
  tld: "Top-level domain suffix used by the registrar operation.",
  limit: "Maximum records requested in one vendor page; obey the declared integer bounds.",
  n: "Maximum records requested for this operation.",
  cursor: "Opaque vendor continuation; for paged hatch reads pass the signed page.nextCursor unchanged.",
  next: "Next-page continuation; pass the signed hatch page.nextCursor unchanged.",
  page: "Vendor page number; use the declared paging protocol when a continuation is returned.",
  per_page: "Vendor rows per page; obey the declared numeric bounds.",
  since: "Lower timestamp boundary for this list; use the operation's documented time unit.",
  startTimestamp: "Start of the requested observation interval.",
  endTimestamp: "End of the requested observation interval.",
  createdAfter: "Include records created after this timestamp.",
  createdBefore: "Include records created before this timestamp.",
  includeDisabled: "Include disabled records in the response.",
  includeArchived: "Include archived records in the response.",
  includeMetadata: "Include the operation's optional record metadata.",
  "skip-metadata": "Omit optional metadata from the response.",
  "include-guides": "Include integration guide metadata in the response.",
  metadata: "Metadata selection for the requested record.",
  updatedBy: "Filter by the identity that last updated the records.",
  actingIp: "IP address associated with the acting request for this operation.",
  actingUserAgent: "User-agent string associated with the acting request.",
  q: "Vendor search expression for this resource.",
  query: "Vendor search expression for this resource.",
  search: "Search text to match against the listed resource.",
  diff: "Select a comparison of the requested configuration versions.",
  sort_by: "Record property used for sorting.",
  sort_order: "Sorting direction, using the declared vendor values.",
  sort: "Sorting choice, using the declared vendor values.",
  connector: "Connect connector identifier, resolved from connector metadata.",
  action: "Integration resource action to perform, using the documented action name.",
  dryRun: "Validate or preview this operation without applying its requested change where supported.",
  token: "Existing token selector. Credential-returning operations remain refused.",
  edgeConfigItemKey: "Edge Config item name; stored item-value reads remain refused.",
  view: "Response view supported by this operation.",
  installationType: "Filter by the integration installation type.",
  provider: "Vendor provider choice for this resource.",
  source: "Source selection for the requested resource.",
  entityKind: "Feature-flag entity kind whose attributes are being queried.",
  attributeKey: "Feature-flag entity attribute name whose labels are being queried.",
  filter: "Vendor filter expression for this collection.",
  hosts: "Hostnames to include in the requested observations.",
  ip: "IP address to match in the requested observations.",
  isActive: "Select active or inactive records.",
  actionType: "Filter events by their action type.",
  ruleKind: "Filter rules by their documented kind.",
  untagged: "Include or select records without a tag.",
  tag: "Tag used to select records or image versions.",
  attempt: "Invocation attempt number, distinct from the invocation identifier.",
  runAttempt: "Job run attempt number.",
  taskRunAttempt: "Task run attempt number.",
  follow: "Live-follow choice; Connecta refuses following unbounded streams through the hatch.",
  repository: "Repository identifier used by this Vercel CI operation.",
  deprecated: "Include or select deprecated records.",
  status: "Filter by the record's current status.",
  conclusion: "Filter by the check's reported conclusion.",
  blocks: "Select blocking checks for this operation.",
  delimiter: "Delimiter used to group the returned resource keys.",
  builds: "Select build-related records or include build information.",
};
export function discoveryIndex(data: OpenApiData): OpenApiData {
  const details = JSON.parse(data.details) as {
    d: unknown[];
    o: Array<0 | [Array<[string, string, number, unknown, string?]>, unknown]>;
  };
  for (const row of details.o)
    if (row)
      for (const parameter of row[0]) {
        // A record-count limit is a positive whole number even where the pin
        // says only "number". Preserve a documented maximum; invent none.
        if (parameter[0] === "limit") {
          let node = parameter[3] as Record<string, unknown>;
          while (typeof node["$"] === "number") node = details.d[node["$"]] as Record<string, unknown>;
          parameter[3] = { ...node, t: "integer", l: Math.max(1, typeof node["l"] === "number" ? node["l"] : 1) };
        }
        if (parameter[4]) continue;
        const name = parameter[0];
        const description =
          PARAMETERS[name] ??
          (/(?:Id|ID|IdOrName|IdOrSlug|Slug)$/.test(name) || name === "id" || name === "idOrName"
            ? "Observed identifier (or documented name/slug) of this path's resource; resolve it from the matching collection and encode it as one URI segment."
            : undefined);
        if (!description) throw new Error(`Vercel parameter ${name} needs a reviewed discovery description.`);
        parameter[4] = description;
      }
  return {
    ...data,
    details: JSON.stringify(details),
    ops: data.ops.map((row) => {
      const summary = SUMMARIES[`${row[0]} ${row[1]}`] ?? row[3];
      if (!summary) throw new Error(`Vercel operation ${row[0]} ${row[1]} needs a reviewed summary.`);
      return row[5] === undefined
        ? ([row[0], row[1], row[2], summary, row[4]] as const)
        : ([row[0], row[1], row[2], summary, row[4], row[5]] as const);
    }),
  };
}
