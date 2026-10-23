import { keys, optionsOf, variants } from "../../config-schema.js";
import { defineApiProvider } from "../../http/provider.js";
import { PROVIDER_COMMON } from "../../connectors/option-shapes.js";
import type { ConnectorCallAdmissionPolicy } from "../../types.js";
import {
  MIXPANEL_API_ADMISSION,
  MixpanelApi,
  settings,
  MAX_RESPONSE_BYTES,
  READ_CAP_MS,
  authenticate,
  safety,
  mixpanelErrors,
  result,
  getAccount,
  usageGuide,
} from "./api.js";
import { mixpanelTools } from "./tools.js";
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
export const mixpanel = defineApiProvider<MixpanelOptions>({
  name: "mixpanel",
  title: "Mixpanel",
  readme: "Mixpanel",
  bundle: {
    baselineGzip: 337658,
    note: "./providers/mixpanel measures 337,658 B gzip in CI in C.6 (#703). The nine-operation reviewed subset now runs on the Effect provider kit, with fixed regional connections, bounded JSONL export, and unchanged Basic authentication, value safety, catalogs and guide. This replaces the historical 205,500 B baseline that included the hosted MCP half removed by C.0c. Provider entries are reported, not capped (#899); no runtime dependency was added.",
  },
  skill,
  options: MIXPANEL_OPTIONS,
  vendor: MixpanelApi,
  baseUrl: (options) => settings(options).query,
  displayTitle: (options) => `Mixpanel API (${options.region ?? "us"})`,
  description: (options) =>
    `Mixpanel service-account REST APIs (${options.region ?? "us"} residency): ${options.purpose}`,
  maxResponseBytes: MAX_RESPONSE_BYTES,
  timeoutMs: READ_CAP_MS,
  credential: {
    label: "Mixpanel service account",
    description:
      "username:secret from Mixpanel organization settings. Import requires Owner or Admin on the target project.",
    placeholder: "username:secret",
  },
  defaultCallAdmission: MIXPANEL_API_ADMISSION,
  authenticate,
  safety,
  errors: mixpanelErrors,
  result,
  probe: {
    operation: getAccount,
    request: {},
    describe: () => "Authenticated Mixpanel service account; list_projects returns its reachable project metadata.",
  },
  guide: usageGuide,
  tools: mixpanelTools,
});
