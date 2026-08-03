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

const MIXPANEL_ADMISSION: ConnectorCallAdmissionPolicy = {
  rules: [
    {
      budget: {
        kind: "rolling-window",
        maxCalls: 600,
        windowMs: 3_600_000,
      },
      retryAfterMs: 60_000,
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

const WRITE_TOOLS = new Set([
  "Create-Dashboard",
  "Update-Dashboard",
  "Duplicate-Dashboard",
  "Delete-Dashboard",
  "Edit-Event",
  "Edit-Property",
  "Bulk-Edit-Events",
  "Bulk-Edit-Properties",
  "Create-Tag",
  "Rename-Tag",
  "Delete-Tag",
  "Dismiss-Issues",
  "Update-Business-Context",
  "Dismiss-Duplicate-Group",
  "Merge-Group",
  "Create-Custom-Property",
  "Update-Custom-Property",
  "Create-Cohort",
  "Update-Cohort",
  "Delete-Cohort",
  "Create-Lookup-Table",
  "Update-Lookup-Table",
  "Create-Metric",
  "Update-Metric",
  "Create-Experiment",
  "Update-Experiment",
  "Create-Feature-Flag",
  "Update-Feature-Flag",
]);

function vettedSafety(definition: ToolDef): ToolDef {
  if (READ_ONLY_TOOLS.has(definition.name)) {
    return {
      ...definition,
      annotations: {
        ...definition.annotations,
        readOnlyHint: true,
        destructiveHint: false,
      },
    };
  }
  if (WRITE_TOOLS.has(definition.name)) {
    return {
      ...definition,
      annotations: {
        ...definition.annotations,
        readOnlyHint: false,
        destructiveHint: true,
      },
    };
  }
  // A newly introduced downstream tool earns a classification in a Connecta
  // release. Until then the ordinary fail-closed path keeps it approval-visible.
  return {
    ...definition,
    annotations: {
      ...definition.annotations,
      readOnlyHint: false,
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
      ? `\n+## Account instructions\n+\n+${accountInstructions}\n`
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
    redirects: "none",
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
