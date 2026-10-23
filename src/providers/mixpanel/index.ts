import { keys, optionsOf, variants } from "../../config-schema.js";
import { apiConnector } from "../../connectors/api-connector.js";
import { PROVIDER_COMMON } from "../../connectors/option-shapes.js";
import { tracksEveryRequest } from "../../provider-call.js";
import { defineProvider, type ProviderContext } from "../../provider.js";
import type { Connector, ConnectorCallAdmissionPolicy } from "../../types.js";
import { removedHostedMcp } from "../_shared/rest/dispatch.js";
import { MIXPANEL_API_ADMISSION, mixpanelRest } from "./rest.js";
import { skill } from "./skill.generated.js";

export type MixpanelRegion = "us" | "eu" | "in";

interface MixpanelCommonOptions {
  /**
   * Human-readable display name; defaults to "Mixpanel (<region>)". The region
   * rides the title because a project lives in exactly one residency and
   * discovery shows the title before anything else.
   */
  title?: string;
  /** Downstream auth ownership. Defaults to one shared deployment grant. */
  authScope?: "shared" | "personal";
  /** Who should use this account and for what decisions. */
  purpose: string;
  /**
   * Data residency region, selecting the matching official endpoint. A wrong
   * region answers empty rather than wrong, which reads as an empty project.
   */
  region?: MixpanelRegion;
  /** Account-specific conventions appended to the maintained provider guide. */
  instructions?: string;
  /** Connector-specific inline result limit; omit to inherit the deployment. */
  maxResultBytes?: number;
  /** Serve only read-classified tools on every endpoint. Defaults to false. */
  readOnly?: boolean;
  /**
   * Optional per-runtime policy. API mode defaults to 60 calls/hour and five
   * concurrent calls across all tools and projects.
   */
  callAdmission?: ConnectorCallAdmissionPolicy;
}

/** REST APIs using an operator-managed username:secret service account. */
export interface MixpanelApiOptions extends MixpanelCommonOptions {
  via: "api";
  auth: { type: "credential" };
  /** Fills an omitted project_id. Explicit ids still reach other granted projects. */
  defaultProjectId?: number;
}

export type MixpanelOptions = MixpanelApiOptions;

const REGION_COPY: Readonly<Record<MixpanelRegion, string>> = {
  us: "US",
  eu: "EU",
  in: "India",
};

/** The closed options mixpanel() accepts; see `assertKnownOptions`. */
const MIXPANEL_OPTIONS = variants(
  "via",
  {
    mcp: { ...PROVIDER_COMMON, ...keys("via", "region", "auth") },
    api: optionsOf<MixpanelApiOptions>()({
      ...PROVIDER_COMMON,
      ...keys("region", "via", "defaultProjectId"),
      auth: variants("type", { credential: optionsOf<MixpanelApiOptions["auth"]>()(keys("type")).shape }),
    }).shape,
  },
  "mcp",
);

/** Mixpanel service-account REST; via: "api" is required. */
export const mixpanel = defineProvider<MixpanelOptions>({
  name: "mixpanel",
  title: "Mixpanel",
  kind: "api",
  readme: "Mixpanel",
  bundle: {
    baselineGzip: 205500,
    note: "./providers/mixpanel (#823) adds the REST connector, guarded transport, shared operation index and value-safety engine alongside the unchanged hosted MCP client. The nine-operation reviewed subset was shrunk to depth 3 without descriptions before remeasuring: operations.ts is 1355 B gzip. The provider remeasures at about 205500 B gzip, compared with the 131378 B MCP-only baseline; reported against this baseline, not capped (#899). No new runtime dependencies.",
  },
  skill,
  options: MIXPANEL_OPTIONS,
  create: (id, options, provider) => {
    const region = options.region ?? "us";
    if (!["us", "eu", "in"].includes(region)) {
      throw new Error('region must be "us", "eu", or "in".');
    }
    if (options.via !== "api") return removedHostedMcp();
    return mixpanelApi(id, options, provider);
  },
});

function mixpanelApi(id: string, options: MixpanelApiOptions, provider: ProviderContext): Connector {
  if (options.auth?.type !== "credential") throw new Error('via: "api" requires auth: { type: "credential" }.');
  if (
    options.defaultProjectId !== undefined &&
    (!Number.isSafeInteger(options.defaultProjectId) || options.defaultProjectId < 1)
  ) {
    throw new Error("defaultProjectId must be a positive safe integer.");
  }
  const region = options.region ?? "us";
  const rest = mixpanelRest(region, options.defaultProjectId);
  const instructions = options.instructions?.trim();
  return tracksEveryRequest(
    apiConnector(id, {
      ...provider.connectorOptions,
      title: options.title ?? `Mixpanel API (${region})`,
      description: `Mixpanel service-account REST APIs (${region} residency): ${options.purpose}`,
      credential: {
        label: "Mixpanel service account",
        description:
          "username:secret from Mixpanel organization settings. Import requires Owner or Admin on the target project.",
        placeholder: "username:secret",
      },
      testCredential: rest.testCredential,
      callAdmission: options.callAdmission === undefined ? MIXPANEL_API_ADMISSION : options.callAdmission,
      usageGuide: {
        content: `# Mixpanel API usage\n\nService-account REST, ${region} residency. Account purpose: ${options.purpose}\n\nDefault project: ${options.defaultProjectId ?? "none; supply project_id"}.${skill.fragments.api}${instructions ? `\n## ${skill.instructionsHeading}\n\n${instructions}\n` : ""}`,
        summary: `${REGION_COPY[region]} residency, service-account REST. Raw export, user activity, profiles, reports and event import.`,
        required: true,
      },
      tools: rest.tools,
    }),
  );
}
