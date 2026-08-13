import {
  remoteMcp,
  type RemoteMcpAuth,
} from "../connectors/remote-mcp.js";
import { vettedCatalog, withVettedCatalog } from "../catalog-drift.js";
import type {
  Connector,
  ConnectorCallAdmissionPolicy,
} from "../types.js";

export type MixpanelRegion = "us" | "eu" | "in";

export const MIXPANEL_MCP_ENDPOINTS: Readonly<
  Record<MixpanelRegion, string>
> = {
  us: "https://mcp.mixpanel.com/mcp",
  eu: "https://mcp-eu.mixpanel.com/mcp",
  in: "https://mcp-in.mixpanel.com/mcp",
};

export interface MixpanelOptions {
  /**
   * Human-readable display name; defaults to "Mixpanel (<region>)". The region
   * rides the title because a project lives in exactly one residency and
   * discovery shows the title before anything else.
   */
  title?: string;
  /** Who should use this account and for what decisions. */
  purpose: string;
  /**
   * Mixpanel data residency region. Defaults to `"us"`, which is where a
   * project lives unless it was explicitly created in the EU or India
   * residency — the other two are opt-in, so `"us"` is the honest default
   * rather than a convenient one.
   */
  region?: MixpanelRegion;
  /** OAuth by default; static headers support Mixpanel service accounts. */
  auth?: RemoteMcpAuth;
  /** Account-specific conventions appended to the maintained provider guide. */
  instructions?: string;
  /** Connector-specific inline result limit; omit to inherit the deployment. */
  maxResultBytes?: number;
  /**
   * Optional per-runtime call-admission policy. Deliberately not defaulted:
   * Mixpanel meters its MCP server per user per hour, and a per-runtime
   * counter cannot approximate a per-user quota — one runtime serving several
   * users under-counts, and several runtimes sharing one user over-counts.
   * A hardcoded ceiling would therefore either throttle a healthy deployment
   * or fail to protect a busy one, so the number stays with the operator who
   * knows the account.
   */
  callAdmission?: ConnectorCallAdmissionPolicy;
}

/** Tools whose official contract is observational rather than mutating. */
const READ_ONLY_TOOLS = new Set([
  "Run-Query",
  "Get-Query-Schema",
  "Get-Report",
  "Display-Query",
  "List-Dashboards",
  "Get-Dashboard",
  "Get-Business-Context",
  "Get-Projects",
  "List-Organizations",
  "Get-Events",
  "List-Properties",
  "Get-Property-Values",
  "Search-Entities",
  "Get-Issues",
  "Get-Lexicon-URL",
  "Find-Duplicate-Groups",
  "Get-Custom-Property",
  "Get-Cohort",
  "List-Cohorts",
  "Describe-Cohort-Schema",
  "Get-Lookup-Table",
  "Get-Metric",
  "List-Metrics",
  "Get-User-Replays-Data",
  "List-Experiments",
  "Get-Experiment",
  "Get-Experiment-Setup-Guidance",
  "Get-Experiment-Results-Interpretation-Guidance",
  "Explain-Experiment-Health-Check",
  "Run-Experiment-Pre-Launch-Checks",
  "Search-Prior-Experiments",
  "List-Feature-Flags",
  "Get-Feature-Flag",
  "Get-Feature-Flag-Setup-Guidance",
  "Get-Feature-Flag-Lifecycle-Guidance",
]);

/**
 * The maintained write catalog. `"destructive"` tools modify or remove state
 * that already exists; `"additive"` ones only bring something new into being.
 * Both leave the read-only path — the distinction only decides whether the
 * connection asserts `destructiveHint`, which shapes the host's approval copy.
 */
const WRITE_TOOLS: ReadonlyMap<string, "additive" | "destructive"> = new Map([
  ["Create-Dashboard", "additive"],
  ["Update-Dashboard", "destructive"],
  ["Duplicate-Dashboard", "additive"],
  ["Delete-Dashboard", "destructive"],
  ["Edit-Event", "destructive"],
  ["Edit-Property", "destructive"],
  ["Bulk-Edit-Events", "destructive"],
  ["Bulk-Edit-Properties", "destructive"],
  ["Create-Tag", "additive"],
  ["Rename-Tag", "destructive"],
  ["Delete-Tag", "destructive"],
  ["Dismiss-Issues", "destructive"],
  ["Update-Business-Context", "destructive"],
  ["Dismiss-Duplicate-Group", "destructive"],
  ["Merge-Group", "destructive"],
  ["Create-Custom-Property", "additive"],
  ["Update-Custom-Property", "destructive"],
  ["Create-Cohort", "additive"],
  ["Update-Cohort", "destructive"],
  ["Delete-Cohort", "destructive"],
  ["Create-Lookup-Table", "additive"],
  ["Update-Lookup-Table", "destructive"],
  ["Create-Metric", "additive"],
  ["Update-Metric", "destructive"],
  ["Create-Experiment", "additive"],
  ["Update-Experiment", "destructive"],
  ["Create-Feature-Flag", "additive"],
  ["Update-Feature-Flag", "destructive"],
]);

/**
 * The manifest this release reviewed: both lists in one place, which is what
 * makes the classification the connector applies and the drift check that runs
 * beside it the same fact (P13). No schema digests yet — no release has read
 * Mixpanel's live schemas and written them down, and an invented digest would
 * report a change that never happened
 * ([#351](https://github.com/zackbart/connecta/issues/351)).
 */
const VETTED_CATALOG = vettedCatalog({
  reads: READ_ONLY_TOOLS,
  writes: WRITE_TOOLS,
});

const REGION_COPY: Readonly<Record<MixpanelRegion, string>> = {
  us: "US",
  eu: "EU",
  in: "India",
};

function usageGuide(
  purpose: string,
  region: MixpanelRegion,
  instructions: string | undefined,
): string {
  const accountInstructions = instructions?.trim();
  // Leads the guide because discovery summarizes a connector by its first
  // content line. A project lives in exactly one residency, so a question
  // pointed at the wrong region does not return fewer rows — it returns
  // nothing, and reads as the project having no data.
  const regionNote = `${REGION_COPY[region]}-residency connection: bound to Mixpanel's ${region} endpoint. A project created in another residency is not reachable from here at all, so an empty result may mean wrong connector rather than no data.`;
  return `# Mixpanel usage

${regionNote}

Account purpose: ${purpose}

- Start with \`Get-Projects\`, then use \`Get-Business-Context\` for the selected project before interpreting its events or metrics.
- Resolve ids before acting; never guess one. \`Get-Projects\` yields the project id every other call is scoped by, and \`List-Dashboards\`, \`List-Cohorts\`, \`List-Metrics\`, \`List-Experiments\`, and \`List-Feature-Flags\` yield the ids their \`Get-\`, \`Update-\`, and \`Delete-\` counterparts expect.
- Discover names with \`Get-Events\`, \`List-Properties\`, and \`Get-Property-Values\`; do not guess event or property spelling.
- For a new analysis, fetch \`Get-Query-Schema\` before \`Run-Query\`. Reduce query results inside \`execute_code\` before returning them.
- Use \`Get-Report\` when the request names an existing saved report. Use \`Run-Query\` for a new question.
- This account's tool list is not a fixed set. Mixpanel gates parts of its MCP catalog by plan and beta enrollment — experiments, feature flags, session replay, and issue triage are the usual absentees — so search this connector for what it actually exposes rather than assuming a documented tool is here.
- Mixpanel meters MCP traffic per user per hour, shared with everything else that credential does. Reuse discovery results within a run and avoid speculative fan-out.
- An \`auth_required\` failure means this connector's Mixpanel authorization is missing or expired: run \`authorize_connector\` for this connector id, then retry the same call unchanged. A rejected argument or a plan restriction comes back in Mixpanel's own words instead — read it rather than re-authorizing.
- Treat every create, update, edit, merge, dismiss, duplicate, or delete operation as a write. Connecta routes the maintained write catalog through \`call_destructive_tool\`; newly added tools also fail closed until classified.
${
    accountInstructions
      ? `\n## Account instructions\n\n${accountInstructions}\n`
      : ""
  }`;
}

/** A maintained Mixpanel hosted-MCP connection. */
export function mixpanel(id: string, options: MixpanelOptions): Connector {
  const purpose = options.purpose.trim();
  if (!purpose) {
    throw new Error("mixpanel() requires a non-empty account purpose.");
  }
  const region = options.region ?? "us";
  if (!(region in MIXPANEL_MCP_ENDPOINTS)) {
    throw new Error(`mixpanel("${id}") region must be "us", "eu", or "in".`);
  }
  const connector = remoteMcp(id, {
    url: MIXPANEL_MCP_ENDPOINTS[region],
    // The region rides the title because browse-time discovery renders the
    // title and the guide summary and nothing else, and residency is the fact
    // an agent must not get wrong between two Mixpanel connections.
    title: options.title ?? `Mixpanel (${region})`,
    description: `Mixpanel product analytics (${REGION_COPY[region]} residency) — ${purpose}`,
    auth: options.auth ?? { type: "oauth" },
    requireHttps: true,
    usageGuide: {
      content: usageGuide(purpose, region, options.instructions),
      // Explicit rather than derived: the derived summary would truncate the
      // residency note mid-sentence at 120 characters
      // ([#342](https://github.com/zackbart/connecta/issues/342)).
      summary: `${REGION_COPY[region]} residency. Project scoping, id resolution, query-schema-first analysis, plan-gated catalog.`,
      // Not `required`. Mixpanel's own schemas describe each call; the guide
      // carries the project-then-context sequence, which is worth reading
      // before an analysis rather than before every call.
    },
    ...(options.callAdmission !== undefined
      ? { callAdmission: options.callAdmission }
      : {}),
    ...(options.maxResultBytes !== undefined
      ? { maxResultBytes: options.maxResultBytes }
      : {}),
  });
  return withVettedCatalog(connector, VETTED_CATALOG);
}
