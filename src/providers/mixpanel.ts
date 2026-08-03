import {
  remoteMcp,
  type RemoteMcpAuth,
} from "../connectors/remote-mcp.js";
import type {
  Connector,
  ConnectorCallAdmissionPolicy,
  ToolDef,
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
  /** Human-readable display name; defaults to "Mixpanel". */
  title?: string;
  /** Who should use this account and for what decisions. */
  purpose: string;
  /** Mixpanel data residency region. Defaults to "us". */
  region?: MixpanelRegion;
  /** OAuth by default; static headers support Mixpanel service accounts. */
  auth?: RemoteMcpAuth;
  /** Account-specific conventions appended to the maintained provider guide. */
  instructions?: string;
  /** Connector-specific inline result limit; omit to inherit the deployment. */
  maxResultBytes?: number;
}

// Budget-only: a rejection computes its own retry-after from the window, and
// declaring `retryAfterMs` here would be a queue setting without a queue —
// which the admission controller refuses at construction.
const MIXPANEL_ADMISSION: ConnectorCallAdmissionPolicy = {
  rules: [
    {
      budget: {
        kind: "rolling-window",
        maxCalls: 600,
        windowMs: 3_600_000,
      },
    },
  ],
};

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
 * Fill in what the downstream leaves unsaid; never argue with what it says.
 *
 * Silence is what a vetted classification is for, and an explicit downstream
 * annotation wins in both directions. `destructiveHint: true` or
 * `readOnlyHint: false` on an allowlisted read name is the downstream telling
 * us this release's allowlist is stale; `readOnlyHint: true` on a name no
 * release has classified says the same thing from the other side. The single
 * place a vetted verdict still overrides the downstream is a name this release
 * reviewed and filed destructive: there connecta knows what the tool does, and
 * a claim to the contrary is a downstream bug rather than news
 * ([#310](https://github.com/zackbart/connecta/issues/310)).
 */
function vettedSafety(definition: ToolDef): ToolDef {
  const downstream = definition.annotations ?? {};
  if (READ_ONLY_TOOLS.has(definition.name)) {
    if (
      downstream.destructiveHint === true ||
      downstream.readOnlyHint === false
    ) {
      return definition;
    }
    return {
      ...definition,
      annotations: {
        ...downstream,
        readOnlyHint: true,
        destructiveHint: downstream.destructiveHint ?? false,
      },
    };
  }
  if (WRITE_TOOLS.get(definition.name) === "destructive") {
    return {
      ...definition,
      annotations: {
        ...downstream,
        readOnlyHint: false,
        destructiveHint: true,
      },
    };
  }
  // Maintained additive creates and tools this release has never seen land
  // here alike. Fill-in only: a silent tool is not read-only, so drift still
  // fails closed onto `call_destructive_tool`, and neither population gets a
  // `destructiveHint` it has not earned. A tool that arrives explicitly
  // read-only keeps that annotation — on a name no release has reviewed, the
  // downstream's own word is the only evidence there is, and rewriting it
  // would be an overrule rather than a fill-in.
  return {
    ...definition,
    annotations: {
      ...downstream,
      readOnlyHint: downstream.readOnlyHint ?? false,
    },
  };
}

function usageGuide(purpose: string, instructions: string | undefined): string {
  const accountInstructions = instructions?.trim();
  return `# Mixpanel usage

Account purpose: ${purpose}

- Start with \`Get-Projects\`, then use \`Get-Business-Context\` for the selected project before interpreting its events or metrics.
- Discover names with \`Get-Events\`, \`List-Properties\`, and \`Get-Property-Values\`; do not guess event or property spelling.
- For a new analysis, fetch \`Get-Query-Schema\` before \`Run-Query\`. Reduce query results inside \`execute_code\` before returning them.
- Use \`Get-Report\` when the request names an existing saved report. Use \`Run-Query\` for a new question.
- Mixpanel limits MCP traffic to 600 requests per user per hour. Reuse discovery results within a run and avoid speculative fan-out.
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
  const connector = remoteMcp(id, {
    url: MIXPANEL_MCP_ENDPOINTS[region],
    title: options.title ?? "Mixpanel",
    description: `Mixpanel product analytics — ${purpose}`,
    auth: options.auth ?? { type: "oauth" },
    requireHttps: true,
    callAdmission: MIXPANEL_ADMISSION,
    usageGuide: usageGuide(purpose, options.instructions),
    ...(options.maxResultBytes !== undefined
      ? { maxResultBytes: options.maxResultBytes }
      : {}),
  });
  return {
    ...connector,
    async listTools(ctx) {
      return (await connector.listTools(ctx)).map(vettedSafety);
    },
  };
}
