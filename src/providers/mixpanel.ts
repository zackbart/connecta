import {
  remoteMcp,
  withCredentialDefaults,
  type RemoteMcpAuth,
} from "../connectors/remote-mcp.js";
import { vettedCatalog, withVettedCatalog } from "../catalog-drift.js";
import { defined } from "../connectors/api.js";
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
  /** Downstream auth ownership. Defaults to one shared deployment grant. */
  authScope?: "shared" | "personal";
  /** Who should use this account and for what decisions. */
  purpose: string;
  /** Data residency region; see `documentation/mixpanel.md`. */
  region?: MixpanelRegion;
  /**
   * OAuth by default; static headers support Mixpanel service accounts, and
   * `{ type: "credential" }` takes the same service account as an
   * operator-managed `username:secret` that Connecta frames for the endpoint.
   */
  auth?: RemoteMcpAuth;
  /** Account-specific conventions appended to the maintained provider guide. */
  instructions?: string;
  /** Connector-specific inline result limit; omit to inherit the deployment. */
  maxResultBytes?: number;
  /** Optional per-runtime policy; see `documentation/mixpanel.md#rate-limits`. */
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

/** Reviewed writes; see provider convention P5. */
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
  ["Fill-Event-Metadata", "destructive"],
]);

/** Live US hosted-MCP schemas reviewed read-only on 2026-08-30 (#395, #512). */
const MIXPANEL_SCHEMA_DIGESTS = {
  "Bulk-Edit-Events": "sha256:94512138df153de95436371f5a313e32b97faffebda3be6c0c69d09d1ff2b340",
  "Bulk-Edit-Properties": "sha256:93481eb896ded45b623c678612e2156439efbaad5b4d660da1f2b087e7409ee3",
  "Create-Cohort": "sha256:ea687f4bc607f8bfb5b1949e060239d6f7d629d3ec80fb0b72eae6cc6156ed03",
  "Create-Custom-Property": "sha256:d22818b812f3fd0e785a5bbbee26cf099eaa911d5b6f383f94cf458a2ed26294",
  "Create-Dashboard": "sha256:bd3b6e5134d27dafb04ccdf04d19e54dd23e6e2dc16989e418006e484268037b",
  "Create-Experiment": "sha256:1cfc2edeb2ac2d329a531d2095671a0653ab5b94b9e233b34268ff29a48c5ac5",
  "Create-Feature-Flag": "sha256:3460d11d726727349cac62db5c19915ab589b7f1d8387042f0a3783356b252c4",
  "Create-Lookup-Table": "sha256:c2fefa33a4f19fc65f394fecdc7126cab0ae874f7c97018cf003d8462a049e4c",
  "Create-Metric": "sha256:315766d0c197d87bb44aedd16732f6e69fbfc93661d1fcfc177cadc1751f26ce",
  "Create-Tag": "sha256:f99b6faad422aa6142d20d0aa4bdec1074e96a8ec45e35573e86d84b01df1d3b",
  "Delete-Cohort": "sha256:e18c500459edd9c2b6a614a3f6c97b668786be9abf72929a0a50086bdadb1dae",
  "Delete-Dashboard": "sha256:3a04594218b491743240e6970f677ed8ed132237d933efe30e97bdc41eb1ab6f",
  "Delete-Tag": "sha256:5f6cc58ada5d2796f124e15883fe05061d03f9129414f4c8e10a0ec463f17807",
  "Describe-Cohort-Schema": "sha256:775dbb8bb71ad3fa39ba35ca3a2683dfd88120f7af84a968531609c5a12de537",
  "Dismiss-Duplicate-Group": "sha256:4e39c6f9bb83ed54020097f6cf34507a5288de2c1ce333456c84682bb5986bc4",
  "Dismiss-Issues": "sha256:9c1f4901eca53f58d16feee126868d23c6ed1f5fad72344f86ea9965385b8644",
  "Display-Query": "sha256:d0776167b8a20898c1ff580ca9517da8dea6b827c64e10b9fa01ae1a3c2db95f",
  "Duplicate-Dashboard": "sha256:9738db7495d29034df966423df3c9d4b16ac3a8254c8473bf1e85a467fe9cf4e",
  "Edit-Event": "sha256:28c47da0b56f57da0f11eb11435441a39ecd5175600f854442744c66a379ef93",
  "Edit-Property": "sha256:11975587d2a566edc468db7cb24df70167d12068f30c1fe52c84f543cf4e2399",
  "Explain-Experiment-Health-Check": "sha256:a50b1263247012dc78521bf6c1dd18584a7b08d46221a444b1ca49c81d3286e5",
  "Fill-Event-Metadata": "sha256:53accc988f216bdd5d7a259d731f6df82549e4e6146b191f1815a0d1a72a1abe",
  "Find-Duplicate-Groups": "sha256:8f944cef9a147eab3c51bfcf1b873cef1409e5a6c21565d34e7ed20d23dcebb7",
  "Get-Business-Context": "sha256:309f5ba864c90132061096b4f0ebc1e78544a6486bac3a45bd661d16bcab2b6c",
  "Get-Cohort": "sha256:e18c500459edd9c2b6a614a3f6c97b668786be9abf72929a0a50086bdadb1dae",
  "Get-Custom-Property": "sha256:d1cbce906cee66d422846c8ef1a745bbeac2c058ecad6b1ee8dcdd2120fa86be",
  "Get-Dashboard": "sha256:56659fa3277723b75e24f3b4ca142ac9cd62120fb97e6c9252c221d00cdf8509",
  "Get-Events": "sha256:d206fe30ab47d64bf6090bffdb4d119a80cfc2a35963bbe7fd52d56060090ded",
  "Get-Experiment": "sha256:ab685aa985aa2ec36d9cbeb1b3c1ef298b020e552e8fdce12e75abbeb4706f2b",
  "Get-Experiment-Results-Interpretation-Guidance": "sha256:e517d9759f66f4a7ad15b0b67ffaabfb605e80949afcf41d007dfafd8f3e9574",
  "Get-Experiment-Setup-Guidance": "sha256:e517d9759f66f4a7ad15b0b67ffaabfb605e80949afcf41d007dfafd8f3e9574",
  "Get-Feature-Flag": "sha256:129de58b379ffba272bdbcee2b5759262e586dd415edc2067a69e9844d4d0877",
  "Get-Feature-Flag-Lifecycle-Guidance": "sha256:e517d9759f66f4a7ad15b0b67ffaabfb605e80949afcf41d007dfafd8f3e9574",
  "Get-Feature-Flag-Setup-Guidance": "sha256:e517d9759f66f4a7ad15b0b67ffaabfb605e80949afcf41d007dfafd8f3e9574",
  "Get-Issues": "sha256:cf172ef18f37504a758c825c7bd4bc23fd98c3421655754dccd8e5ee2d700a10",
  "Get-Lexicon-URL": "sha256:c6456d5c4a38ba069a2caa6cdac651be9d86d47bc6efb3316a893c7336d0e2bc",
  "Get-Lookup-Table": "sha256:061602b283461f083bbd74348c264f802cb21c4fe6d961241c7090895a8334ac",
  "Get-Metric": "sha256:eef10dd9ca25a63a63775565cbc4f2261b289dec526aa33df0f318eefbc96c46",
  "Get-Projects": "sha256:d23d07a777441f04b128f08a2c30a6e8a1573d203f8a1ad7788bc1fd57a9cbbf",
  "Get-Property-Values": "sha256:0cd487c9b92a187b21f456de3c785bb631aa30cba702785c9ff158608883a6bb",
  "Get-Query-Schema": "sha256:8fea929d2ad4f8fed6c47116ff0eaa6f964b3ddd4685e482b68a8dac0231af73",
  "Get-Report": "sha256:a99ba2af1ab57c1d5a606dbd7701968aa430ab23f5969f356a4c41f345dba041",
  "Get-User-Replays-Data": "sha256:5df287735478a67489075b0c7c9d8c07097abe67408d06743c7fb9be43c6e024",
  "List-Cohorts": "sha256:fd04778d60a027cfd777b40f36fbb037ba070661e149b2fce35a14865cada2db",
  "List-Dashboards": "sha256:994c1c9fc87a4f1f00a677b856a44bad028252d283bd8e647ae157683fc89ea2",
  "List-Experiments": "sha256:26a3f3e0b4e52135d74335dd769103303071fc48c15b1df40efd2dfa5a353848",
  "List-Feature-Flags": "sha256:75fc1ff14f3d3faedb8e00c6563d151de397d584429764fd0c332f6a84f6993c",
  "List-Metrics": "sha256:341710bebabb82112e80eb521d9d5cdb3bca024699b3aa795874d3549a315042",
  "List-Organizations": "sha256:e4c23f123dde073e00038d92ebd53f45157c83a4d3a2ff686ab1b66c859f4a11",
  "List-Properties": "sha256:52b38861df076119dfefe0128cf9819868336bf60e090f63c80da734877a69fe",
  "Merge-Group": "sha256:a3b215a5be70305c2f02439513bee76ae3947da14e2a9e5b6ff0afb9ad3d4dcd",
  "Rename-Tag": "sha256:a7e20e79ecd6ca7edca104fa1030e059ffae8962bf084d4a384c012ac9bbf087",
  "Run-Experiment-Pre-Launch-Checks": "sha256:f6b5d85f75450b76fda9c7ef441f190fd45fcaeaff4cc3c30a6d1bee76e4c706",
  "Run-Query": "sha256:0eb7d52343f6137275a02c2d7bb02dafdbfd25bd6f9067395eb689492d835466",
  "Search-Entities": "sha256:86cfa1d3bf7f17a70ad07264d7b1d16c83480e40996e8d847911fe8bde13e35e",
  "Search-Prior-Experiments": "sha256:847d1dcefaf6dc5e7ea967476f464a4d678a06b5e7d437dfb11ad4af2e56620f",
  "Update-Business-Context": "sha256:0d21290053b6d532386c3c83d60cd78013a7109492c02ba2e7822716f2cde027",
  "Update-Cohort": "sha256:ebe0d5afcc00e23eef55f079cd1816c851c2c647dff9565b7045f1f1615663f2",
  "Update-Custom-Property": "sha256:781aaaab41c1ab5958062dc393d02b1df2ef2a09a28d3c4f21ae3177f4f53c86",
  "Update-Dashboard": "sha256:2cc179ba75eda476ba7488f01503d947f023a4460aa98c4806ef0ab10c3b3ce8",
  "Update-Experiment": "sha256:3ea3902555c146f45127fc563b36ffb7ff04b7594765dac9ae98cc09dc432808",
  "Update-Feature-Flag": "sha256:9b34b19164168938d08a75d268c9becf8d189c85a1789a45061ae304041faf7c",
  "Update-Lookup-Table": "sha256:ef28f1ec9c9484a7a53b5e2b6659e70f79a8e71e55bda17025aa4ab3c23b6a63",
  "Update-Metric": "sha256:739bb6abdab19282afd4a6644a96183daabe9098a5322c44a77b840608a5ee9d",
} as const;

/** Release-reviewed manifest; see provider conventions P5 and P13. */
export const MIXPANEL_VETTED_CATALOG = vettedCatalog({
  reads: READ_ONLY_TOOLS,
  writes: WRITE_TOOLS,
  schemaDigests: MIXPANEL_SCHEMA_DIGESTS,
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
- \`Get-Business-Context\` requires either \`project_id\` or \`organization_id\`. Its schema marks both optional, but the hosted tool rejects a call with neither.
- \`Get-Property-Values\` requires \`properties\` or the deprecated \`property\` alias. Event property values also require \`event\`; prefer \`properties\` and never send both property forms with conflicting values.
- \`List-Properties\` accepts \`names\` or \`query\`, never both. Use exact \`names\` for known properties and \`query\` for substring discovery.
- One analysis is one \`execute_code\` program: fetch \`Get-Query-Schema\` once, run every \`Run-Query\` of the analysis in that program, and return the reduced table. The schema is tens of kilobytes and the same for every report type, so re-fetching it per query buys nothing. Never return raw \`Run-Query\` output.
- Insights, funnels, and retention answer aggregate questions. A per-user ordered event timeline, or a sequence question such as "event A with no later event B", is not answerable with \`Run-Query\` in a reasonable number of calls, and this hosted catalog has no per-\`distinct_id\` event timeline — \`Get-User-Replays-Data\` covers one user's replays with their events only where session replay is enabled and present. If the deployment exposes a Mixpanel export or activity-feed connector, use that; if it does not, tell the user the question is out of reach here rather than approximating it with hourly buckets and hundreds of empty rows.
- \`false\` on a boolean property may be an absent property: Mixpanel renders a missing value as \`false\` in boolean breakdowns, and server-imported events often lack client-side properties entirely. Confirm the property is present with \`List-Properties\` or \`Get-Property-Values\` before treating \`false\` as a signal, and say when a conclusion rests on that ambiguity.
- Breakdown responses nest \`$overall\` and per-segment series objects. Flatten to one row per complete breakdown combination inside \`execute_code\` before returning, and drop \`$overall\` unless the question asks for the total.
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
    ...(options.authScope ? { authScope: options.authScope } : {}),
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
    ...defined({
      callAdmission: options.callAdmission,
      maxResultBytes: options.maxResultBytes,
    }),
  });
  return withVettedCatalog(connector, MIXPANEL_VETTED_CATALOG);
}
