import { skill } from "./skill.generated.js";
import { remoteMcp, withCredentialDefaults, type RemoteMcpAuth } from "../../connectors/remote-mcp.js";
import { reviewedCatalog } from "../../catalog-drift.js";
import type { Connector, ToolClassification, ConnectorCallAdmissionPolicy } from "../../types.js";
import { keys, optionsOf, variants } from "../../config-schema.js";
import { PROVIDER_COMMON, REMOTE_MCP_AUTH } from "../../connectors/option-shapes.js";
import { defineProvider, type ProviderContext } from "../../provider.js";
import { apiConnector } from "../../connectors/api-connector.js";
import { mixpanelRest, MIXPANEL_API_ADMISSION } from "./rest.js";

export type MixpanelRegion = "us" | "eu" | "in";

export const MIXPANEL_MCP_ENDPOINTS: Readonly<Record<MixpanelRegion, string>> = {
  us: "https://mcp.mixpanel.com/mcp",
  eu: "https://mcp-eu.mixpanel.com/mcp",
  in: "https://mcp-in.mixpanel.com/mcp",
};

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
   * concurrent calls across all tools and projects. MCP mode has no default:
   * its per-user hourly quota cannot be modeled by one per-runtime counter.
   */
  callAdmission?: ConnectorCallAdmissionPolicy;
}

/** The default hosted MCP connection. Existing auth configurations still work. */
export interface MixpanelMcpOptions extends MixpanelCommonOptions {
  via?: "mcp";
  /**
   * OAuth by default; static headers support Mixpanel service accounts, and
   * `{ type: "credential" }` takes the same service account as an
   * operator-managed `username:secret` that Connecta frames for the endpoint.
   */
  auth?: RemoteMcpAuth;
  defaultProjectId?: never;
}

/** REST APIs using an operator-managed username:secret service account. */
export interface MixpanelApiOptions extends MixpanelCommonOptions {
  via: "api";
  auth: { type: "credential" };
  /** Fills an omitted project_id. Explicit ids still reach other granted projects. */
  defaultProjectId?: number;
}

export type MixpanelOptions = MixpanelMcpOptions | MixpanelApiOptions;

/**
 * Reviewed against https://docs.mixpanel.com/docs/mcp and the 2026-10-19 live
 * US describe schemas (#343, #703). Eleven of the 64 previously pinned tools
 * changed since the 2026-08-30 review (#395, #512); unchanged pins are retained.
 * Get-Audit-Log is documented beta-only: no live schema digest is claimed.
 */
const MIXPANEL_CLASSIFICATION: ToolClassification = {
  tools: {
    "Run-Query": {
      "verdict": "read",
      "reason": "Runs an observational analytics query; saved reports and dashboard edits use separate write tools.",
      "schemaDigest": "sha256:0eb7d52343f6137275a02c2d7bb02dafdbfd25bd6f9067395eb689492d835466",
    },
    "Get-Query-Schema": {
      "verdict": "read",
      "reason": "Retrieves Mixpanel query schema information without changing vendor state.",
      "schemaDigest": "sha256:8fea929d2ad4f8fed6c47116ff0eaa6f964b3ddd4685e482b68a8dac0231af73",
    },
    "Get-Report": {
      "verdict": "read",
      "reason": "Retrieves Mixpanel report information without changing vendor state.",
      "schemaDigest": "sha256:a99ba2af1ab57c1d5a606dbd7701968aa430ab23f5969f356a4c41f345dba041",
    },
    "Display-Query": {
      "verdict": "read",
      "reason": "Displays existing query results without editing a dashboard or saved report.",
      "schemaDigest": "sha256:d0776167b8a20898c1ff580ca9517da8dea6b827c64e10b9fa01ae1a3c2db95f",
    },
    "List-Dashboards": {
      "verdict": "read",
      "reason": "Retrieves Mixpanel dashboards information without changing vendor state.",
      "schemaDigest": "sha256:994c1c9fc87a4f1f00a677b856a44bad028252d283bd8e647ae157683fc89ea2",
    },
    "Get-Dashboard": {
      "verdict": "read",
      "reason": "Retrieves Mixpanel dashboard information without changing vendor state.",
      "schemaDigest": "sha256:0af78ab95566a20eeba08af6922f2017d98503e2b14dcbe8d7e2ac54eef870d7",
    },
    "Get-Business-Context": {
      "verdict": "read",
      "reason": "Reads existing business context for a project or organization; updates use a separate tool.",
      "schemaDigest": "sha256:309f5ba864c90132061096b4f0ebc1e78544a6486bac3a45bd661d16bcab2b6c",
    },
    "Get-Projects": {
      "verdict": "read",
      "reason": "Retrieves Mixpanel projects information without changing vendor state.",
      "schemaDigest": "sha256:d23d07a777441f04b128f08a2c30a6e8a1573d203f8a1ad7788bc1fd57a9cbbf",
    },
    "List-Organizations": {
      "verdict": "read",
      "reason": "Retrieves Mixpanel organizations information without changing vendor state.",
      "schemaDigest": "sha256:e4c23f123dde073e00038d92ebd53f45157c83a4d3a2ff686ab1b66c859f4a11",
    },
    "Get-Audit-Log": {
      "verdict": "read",
      "reason":
        "Queries existing organization audit history; limited-access beta requiring organization admin or owner access.",
    },
    "Get-Events": {
      "verdict": "read",
      "reason": "Retrieves Mixpanel events information without changing vendor state.",
      "schemaDigest": "sha256:09d7874b0c60cf790944b8998ee943f200912eac4349dfa80d0f2ae82a7a7998",
    },
    "List-Properties": {
      "verdict": "read",
      "reason": "Retrieves Mixpanel properties information without changing vendor state.",
      "schemaDigest": "sha256:52b38861df076119dfefe0128cf9819868336bf60e090f63c80da734877a69fe",
    },
    "Get-Property-Values": {
      "verdict": "read",
      "reason": "Retrieves Mixpanel property values information without changing vendor state.",
      "schemaDigest": "sha256:0cd487c9b92a187b21f456de3c785bb631aa30cba702785c9ff158608883a6bb",
    },
    "Search-Entities": {
      "verdict": "read",
      "reason": "Retrieves Mixpanel entities information without changing vendor state.",
      "schemaDigest": "sha256:86cfa1d3bf7f17a70ad07264d7b1d16c83480e40996e8d847911fe8bde13e35e",
    },
    "Get-Issues": {
      "verdict": "read",
      "reason": "Retrieves Mixpanel issues information without changing vendor state.",
      "schemaDigest": "sha256:cf172ef18f37504a758c825c7bd4bc23fd98c3421655754dccd8e5ee2d700a10",
    },
    "Get-Lexicon-URL": {
      "verdict": "read",
      "reason": "Retrieves Mixpanel lexicon url information without changing vendor state.",
      "schemaDigest": "sha256:c6456d5c4a38ba069a2caa6cdac651be9d86d47bc6efb3316a893c7336d0e2bc",
    },
    "Find-Duplicate-Groups": {
      "verdict": "read",
      "reason": "Retrieves Mixpanel find duplicate groups information without changing vendor state.",
      "schemaDigest": "sha256:8f944cef9a147eab3c51bfcf1b873cef1409e5a6c21565d34e7ed20d23dcebb7",
    },
    "Get-Custom-Property": {
      "verdict": "read",
      "reason": "Retrieves Mixpanel custom property information without changing vendor state.",
      "schemaDigest": "sha256:d1cbce906cee66d422846c8ef1a745bbeac2c058ecad6b1ee8dcdd2120fa86be",
    },
    "Get-Cohort": {
      "verdict": "read",
      "reason": "Retrieves Mixpanel cohort information without changing vendor state.",
      "schemaDigest": "sha256:e18c500459edd9c2b6a614a3f6c97b668786be9abf72929a0a50086bdadb1dae",
    },
    "List-Cohorts": {
      "verdict": "read",
      "reason": "Retrieves Mixpanel cohorts information without changing vendor state.",
      "schemaDigest": "sha256:505ff07f668186b670bcce28aa339076140b85896eb4f64afad78d963018297a",
    },
    "Describe-Cohort-Schema": {
      "verdict": "read",
      "reason": "Retrieves Mixpanel describe cohort schema information without changing vendor state.",
      "schemaDigest": "sha256:775dbb8bb71ad3fa39ba35ca3a2683dfd88120f7af84a968531609c5a12de537",
    },
    "Get-Lookup-Table": {
      "verdict": "read",
      "reason": "Retrieves Mixpanel lookup table information without changing vendor state.",
      "schemaDigest": "sha256:061602b283461f083bbd74348c264f802cb21c4fe6d961241c7090895a8334ac",
    },
    "Get-Metric": {
      "verdict": "read",
      "reason": "Retrieves Mixpanel metric information without changing vendor state.",
      "schemaDigest": "sha256:451e867abd1162f25bec96f76cb1b1d1d84eb33c04fe4d804e729810d93d26d7",
    },
    "List-Metrics": {
      "verdict": "read",
      "reason": "Retrieves Mixpanel metrics information without changing vendor state.",
      "schemaDigest": "sha256:341710bebabb82112e80eb521d9d5cdb3bca024699b3aa795874d3549a315042",
    },
    "Get-User-Replays-Data": {
      "verdict": "read",
      "reason": "Retrieves Mixpanel user replays data information without changing vendor state.",
      "schemaDigest": "sha256:5df287735478a67489075b0c7c9d8c07097abe67408d06743c7fb9be43c6e024",
    },
    "List-Experiments": {
      "verdict": "read",
      "reason": "Retrieves Mixpanel experiments information without changing vendor state.",
      "schemaDigest": "sha256:26a3f3e0b4e52135d74335dd769103303071fc48c15b1df40efd2dfa5a353848",
    },
    "Get-Experiment": {
      "verdict": "destructive",
      "reason":
        "Optional compute flags persist refreshed result caches and may auto-conclude an experiment; the full tool can modify existing state.",
      "schemaDigest": "sha256:aebe329b5c5f3a9a465d40f12af1d6336d1304cc949c291eea752a5dd532e6fa",
    },
    "Get-Experiment-Setup-Guidance": {
      "verdict": "read",
      "reason": "Retrieves Mixpanel experiment setup guidance information without changing vendor state.",
      "schemaDigest": "sha256:e517d9759f66f4a7ad15b0b67ffaabfb605e80949afcf41d007dfafd8f3e9574",
    },
    "Get-Experiment-Results-Interpretation-Guidance": {
      "verdict": "read",
      "reason":
        "Retrieves Mixpanel experiment results interpretation guidance information without changing vendor state.",
      "schemaDigest": "sha256:e517d9759f66f4a7ad15b0b67ffaabfb605e80949afcf41d007dfafd8f3e9574",
    },
    "Explain-Experiment-Health-Check": {
      "verdict": "read",
      "reason": "Retrieves Mixpanel explain experiment health check information without changing vendor state.",
      "schemaDigest": "sha256:a50b1263247012dc78521bf6c1dd18584a7b08d46221a444b1ca49c81d3286e5",
    },
    "Run-Experiment-Pre-Launch-Checks": {
      "verdict": "read",
      "reason": "Retrieves Mixpanel run experiment pre launch checks information without changing vendor state.",
      "schemaDigest": "sha256:f6b5d85f75450b76fda9c7ef441f190fd45fcaeaff4cc3c30a6d1bee76e4c706",
    },
    "Search-Prior-Experiments": {
      "verdict": "read",
      "reason": "Retrieves Mixpanel prior experiments information without changing vendor state.",
      "schemaDigest": "sha256:847d1dcefaf6dc5e7ea967476f464a4d678a06b5e7d437dfb11ad4af2e56620f",
    },
    "List-Feature-Flags": {
      "verdict": "read",
      "reason": "Retrieves Mixpanel feature flags information without changing vendor state.",
      "schemaDigest": "sha256:75fc1ff14f3d3faedb8e00c6563d151de397d584429764fd0c332f6a84f6993c",
    },
    "Get-Feature-Flag": {
      "verdict": "read",
      "reason": "Retrieves Mixpanel feature flag information without changing vendor state.",
      "schemaDigest": "sha256:129de58b379ffba272bdbcee2b5759262e586dd415edc2067a69e9844d4d0877",
    },
    "Get-Feature-Flag-Setup-Guidance": {
      "verdict": "read",
      "reason": "Retrieves Mixpanel feature flag setup guidance information without changing vendor state.",
      "schemaDigest": "sha256:e517d9759f66f4a7ad15b0b67ffaabfb605e80949afcf41d007dfafd8f3e9574",
    },
    "Get-Feature-Flag-Lifecycle-Guidance": {
      "verdict": "read",
      "reason": "Retrieves Mixpanel feature flag lifecycle guidance information without changing vendor state.",
      "schemaDigest": "sha256:e517d9759f66f4a7ad15b0b67ffaabfb605e80949afcf41d007dfafd8f3e9574",
    },
    "Create-Dashboard": {
      "verdict": "write",
      "reason": "Create Dashboard creates or appends Mixpanel state; it has side effects.",
      "schemaDigest": "sha256:59fbe58cc8b69b31adfa7015e541d495abc566f56b1320e10ad77288ff9facf0",
    },
    "Update-Dashboard": {
      "verdict": "destructive",
      "reason": "Update Dashboard changes existing Mixpanel state or removes it.",
      "schemaDigest": "sha256:6f2f11e94a13667848bdcb30531a7ff478a8c53460a5e0859f8241b64d0008da",
    },
    "Duplicate-Dashboard": {
      "verdict": "write",
      "reason": "Duplicate Dashboard creates or appends Mixpanel state; it has side effects.",
      "schemaDigest": "sha256:9738db7495d29034df966423df3c9d4b16ac3a8254c8473bf1e85a467fe9cf4e",
    },
    "Delete-Dashboard": {
      "verdict": "destructive",
      "reason": "Delete Dashboard changes existing Mixpanel state or removes it.",
      "schemaDigest": "sha256:3a04594218b491743240e6970f677ed8ed132237d933efe30e97bdc41eb1ab6f",
    },
    "Edit-Event": {
      "verdict": "destructive",
      "reason": "Edit Event changes existing Mixpanel state or removes it.",
      "schemaDigest": "sha256:28c47da0b56f57da0f11eb11435441a39ecd5175600f854442744c66a379ef93",
    },
    "Edit-Property": {
      "verdict": "destructive",
      "reason": "Edit Property changes existing Mixpanel state or removes it.",
      "schemaDigest": "sha256:11975587d2a566edc468db7cb24df70167d12068f30c1fe52c84f543cf4e2399",
    },
    "Bulk-Edit-Events": {
      "verdict": "destructive",
      "reason": "Bulk Edit Events changes existing Mixpanel state or removes it.",
      "schemaDigest": "sha256:94512138df153de95436371f5a313e32b97faffebda3be6c0c69d09d1ff2b340",
    },
    "Bulk-Edit-Properties": {
      "verdict": "destructive",
      "reason": "Bulk Edit Properties changes existing Mixpanel state or removes it.",
      "schemaDigest": "sha256:93481eb896ded45b623c678612e2156439efbaad5b4d660da1f2b087e7409ee3",
    },
    "Create-Tag": {
      "verdict": "write",
      "reason": "Create Tag creates or appends Mixpanel state; it has side effects.",
      "schemaDigest": "sha256:f99b6faad422aa6142d20d0aa4bdec1074e96a8ec45e35573e86d84b01df1d3b",
    },
    "Rename-Tag": {
      "verdict": "destructive",
      "reason": "Rename Tag changes existing Mixpanel state or removes it.",
      "schemaDigest": "sha256:a7e20e79ecd6ca7edca104fa1030e059ffae8962bf084d4a384c012ac9bbf087",
    },
    "Delete-Tag": {
      "verdict": "destructive",
      "reason": "Delete Tag changes existing Mixpanel state or removes it.",
      "schemaDigest": "sha256:5f6cc58ada5d2796f124e15883fe05061d03f9129414f4c8e10a0ec463f17807",
    },
    "Dismiss-Issues": {
      "verdict": "destructive",
      "reason": "Dismiss Issues changes existing Mixpanel state or removes it.",
      "schemaDigest": "sha256:9c1f4901eca53f58d16feee126868d23c6ed1f5fad72344f86ea9965385b8644",
    },
    "Update-Business-Context": {
      "verdict": "destructive",
      "reason": "Update Business Context changes existing Mixpanel state or removes it.",
      "schemaDigest": "sha256:0d21290053b6d532386c3c83d60cd78013a7109492c02ba2e7822716f2cde027",
    },
    "Dismiss-Duplicate-Group": {
      "verdict": "destructive",
      "reason": "Dismiss Duplicate Group changes existing Mixpanel state or removes it.",
      "schemaDigest": "sha256:4e39c6f9bb83ed54020097f6cf34507a5288de2c1ce333456c84682bb5986bc4",
    },
    "Merge-Group": {
      "verdict": "destructive",
      "reason": "Merge Group changes existing Mixpanel state or removes it.",
      "schemaDigest": "sha256:a3b215a5be70305c2f02439513bee76ae3947da14e2a9e5b6ff0afb9ad3d4dcd",
    },
    "Create-Custom-Property": {
      "verdict": "write",
      "reason": "Create Custom Property creates or appends Mixpanel state; it has side effects.",
      "schemaDigest": "sha256:d22818b812f3fd0e785a5bbbee26cf099eaa911d5b6f383f94cf458a2ed26294",
    },
    "Update-Custom-Property": {
      "verdict": "destructive",
      "reason": "Update Custom Property changes existing Mixpanel state or removes it.",
      "schemaDigest": "sha256:781aaaab41c1ab5958062dc393d02b1df2ef2a09a28d3c4f21ae3177f4f53c86",
    },
    "Create-Cohort": {
      "verdict": "write",
      "reason": "Create Cohort creates or appends Mixpanel state; it has side effects.",
      "schemaDigest": "sha256:ea687f4bc607f8bfb5b1949e060239d6f7d629d3ec80fb0b72eae6cc6156ed03",
    },
    "Update-Cohort": {
      "verdict": "destructive",
      "reason": "Update Cohort changes existing Mixpanel state or removes it.",
      "schemaDigest": "sha256:ebe0d5afcc00e23eef55f079cd1816c851c2c647dff9565b7045f1f1615663f2",
    },
    "Delete-Cohort": {
      "verdict": "destructive",
      "reason": "Delete Cohort changes existing Mixpanel state or removes it.",
      "schemaDigest": "sha256:e18c500459edd9c2b6a614a3f6c97b668786be9abf72929a0a50086bdadb1dae",
    },
    "Create-Lookup-Table": {
      "verdict": "write",
      "reason": "Create Lookup Table creates or appends Mixpanel state; it has side effects.",
      "schemaDigest": "sha256:c2fefa33a4f19fc65f394fecdc7126cab0ae874f7c97018cf003d8462a049e4c",
    },
    "Update-Lookup-Table": {
      "verdict": "destructive",
      "reason": "Update Lookup Table changes existing Mixpanel state or removes it.",
      "schemaDigest": "sha256:ef28f1ec9c9484a7a53b5e2b6659e70f79a8e71e55bda17025aa4ab3c23b6a63",
    },
    "Create-Metric": {
      "verdict": "write",
      "reason": "Create Metric creates or appends Mixpanel state; it has side effects.",
      "schemaDigest": "sha256:c10bc660e0664a9aba6450a45b50fb1fbea6a4fac809fd5390616416f72e04d6",
    },
    "Update-Metric": {
      "verdict": "destructive",
      "reason": "Update Metric changes existing Mixpanel state or removes it.",
      "schemaDigest": "sha256:ca03823ea995d0ae53807a60b1dd0d47f1667b28cfd24cdab52a9fc66f0c2834",
    },
    "Create-Experiment": {
      "verdict": "write",
      "reason": "Create Experiment creates or appends Mixpanel state; it has side effects.",
      "schemaDigest": "sha256:ce64eafec7f2490fa3c76030c75340bf5dd282a9d0bfb0c5353bcdc3b50f602d",
    },
    "Update-Experiment": {
      "verdict": "destructive",
      "reason": "Update Experiment changes existing Mixpanel state or removes it.",
      "schemaDigest": "sha256:27c0e2b58fbb1468dda938c4112560e9481f58bc4ddafd4a94bad56666c5b12c",
    },
    "Create-Feature-Flag": {
      "verdict": "write",
      "reason": "Create Feature Flag creates or appends Mixpanel state; it has side effects.",
      "schemaDigest": "sha256:3460d11d726727349cac62db5c19915ab589b7f1d8387042f0a3783356b252c4",
    },
    "Update-Feature-Flag": {
      "verdict": "destructive",
      "reason": "Update Feature Flag changes existing Mixpanel state or removes it.",
      "schemaDigest": "sha256:9b34b19164168938d08a75d268c9becf8d189c85a1789a45061ae304041faf7c",
    },
    "Fill-Event-Metadata": {
      "verdict": "destructive",
      "reason": "Applies generated names and descriptions to existing Lexicon events.",
      "schemaDigest": "sha256:53accc988f216bdd5d7a259d731f6df82549e4e6146b191f1815a0d1a72a1abe",
    },
  },
};

const REGION_COPY: Readonly<Record<MixpanelRegion, string>> = {
  us: "US",
  eu: "EU",
  in: "India",
};

function usageGuide(purpose: string, region: MixpanelRegion, instructions: string | undefined): string {
  const accountInstructions = instructions?.trim();
  // Leads the guide because discovery summarizes a connector by its first
  // content line. A project lives in exactly one residency, so a question
  // pointed at the wrong region does not return fewer rows — it returns
  // nothing, and reads as the project having no data.
  const regionNote = `${REGION_COPY[region]}-residency connection: bound to Mixpanel's ${region}${skill.fragments.guide_0}`;
  return `# Mixpanel usage

${regionNote}

Account purpose: ${purpose}${skill.fragments.guide_1}${
    accountInstructions ? `\n## ${skill.instructionsHeading}\n\n${accountInstructions}\n` : ""
  }`;
}

/** The closed options mixpanel() accepts; see `assertKnownOptions`. */
const MIXPANEL_OPTIONS = variants(
  "via",
  {
    mcp: optionsOf<Omit<MixpanelMcpOptions, "defaultProjectId">>()({
      ...PROVIDER_COMMON,
      ...keys("region", "via"),
      auth: REMOTE_MCP_AUTH,
    }).shape,
    api: optionsOf<MixpanelApiOptions>()({
      ...PROVIDER_COMMON,
      ...keys("region", "via", "defaultProjectId"),
      auth: variants("type", { credential: optionsOf<MixpanelApiOptions["auth"]>()(keys("type")).shape }),
    }).shape,
  },
  "mcp",
);

/** Mixpanel hosted MCP by default, or service-account REST with via: "api". */
export const mixpanel = defineProvider<MixpanelOptions>({
  name: "mixpanel",
  title: "Mixpanel",
  kind: "dual",
  readme: "Mixpanel",
  bundle: {
    baselineGzip: 205500,
    note: "./providers/mixpanel (#823) adds the REST connector, guarded transport, shared operation index and value-safety engine alongside the unchanged hosted MCP client. The nine-operation reviewed subset was shrunk to depth 3 without descriptions before remeasuring: operations.ts is 1355 B gzip. The provider remeasures at about 205500 B gzip, compared with the 131378 B MCP-only baseline; reported against this baseline, not capped (#899). No new runtime dependencies.",
  },
  skill,
  options: MIXPANEL_OPTIONS,
  classify: MIXPANEL_CLASSIFICATION,
  create: (id, options, provider) => {
    const region = options.region ?? "us";
    if (!Object.hasOwn(MIXPANEL_MCP_ENDPOINTS, region)) {
      throw new Error('region must be "us", "eu", or "in".');
    }
    return options.via === "api" ? mixpanelApi(id, options, provider) : mixpanelConnector(id, options, provider);
  },
});

function mixpanelConnector(id: string, options: MixpanelMcpOptions, provider: ProviderContext): Connector {
  const purpose = options.purpose.trim();
  const region = options.region ?? "us";
  if (!(region in MIXPANEL_MCP_ENDPOINTS)) {
    throw new Error(`mixpanel("${id}") region must be "us", "eu", or "in".`);
  }
  const connector = remoteMcp(id, {
    url: MIXPANEL_MCP_ENDPOINTS[region],
    ...provider.connectorOptions,
    // The region rides the title because browse-time discovery renders the
    // title and the guide summary and nothing else, and residency is the fact
    // an agent must not get wrong between two Mixpanel connections.
    title: options.title ?? `Mixpanel (${region})`,
    description: `Mixpanel product analytics (${REGION_COPY[region]} residency) — ${purpose}`,
    // Mixpanel's beta service-account scheme is deliberately not ordinary HTTP
    // Basic: the endpoint wants `Bearer Basic <base64(user:secret)>`. The
    // operator therefore pastes the pair, not an encoded blob, and Connecta
    // does the framing — the same shaping the maintainer drift check applies.
    auth: withCredentialDefaults(options.auth ?? { type: "oauth" }, {
      credential: {
        label: "Service account",
        description:
          "A Mixpanel service account as `username:secret`. Connecta encodes and frames it the way the hosted endpoint requires; it is stored encrypted and never displayed.",
        placeholder: "username:secret",
      },
      scheme: "Bearer Basic",
    }),
    requireHttps: true,
    classify: provider.classify,
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
  });
  return connector;
}

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
  return apiConnector(id, {
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
  });
}

/** @deprecated Read `mixpanel.definition.classify` instead. Kept for existing imports. */
export const MIXPANEL_VETTED_CATALOG = reviewedCatalog(mixpanel.definition.classify!, 'defineProvider("mixpanel")');
