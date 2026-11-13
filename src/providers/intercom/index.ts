import { readOnlyNotice } from "../_shared/guide.js";
import { tagCallerIdentity } from "../../connector-caller.js";
import { keys, optionsOf } from "../../config-schema.js";
import { CALL_ADMISSION, MEMBERS, READ_ONLY } from "../../connectors/option-shapes.js";
import { defineApiProvider } from "../../http/provider.js";
import type { ProviderOptions } from "../../provider.js";
import type { ConnectorCallAdmissionPolicy } from "../../types.js";
import {
  IntercomApi,
  authenticate,
  binding,
  errors,
  index,
  named,
  pages,
  probe,
  result,
  safety,
  verdicts,
} from "./api.js";
import { adminOption, type IntercomAdmin } from "./lib/admin.js";
import { INTERCOM_BASE_URLS, INTERCOM_REGION_NAMES, regionOf, type IntercomRegion } from "./lib/config.js";
import { intercomTools } from "./tools.js";
import { skill } from "./skill.generated.js";
export type { IntercomAdmin, IntercomAdminContext } from "./lib/admin.js";
export type { IntercomRegion } from "./lib/config.js";

/**
 * Connecta's REST connector to one Intercom workspace with one operator-managed
 * access token, pasted into the connection in the operator UI.
 */
export interface IntercomOptions {
  /** Which workspace and support purpose this connection serves. */
  purpose: string;
  /** The workspace's data-hosting region. Defaults to `"us"`. */
  region?: IntercomRegion;
  /**
   * The Intercom teammate every write acts as: a fixed admin id, or a
   * function from the admitted identity to one. Writes fill every `admin_id`
   * from it, and a call can never supply one. Required unless `readOnly`.
   */
  admin?: IntercomAdmin;
  /** Human-readable display name; defaults to "Intercom". */
  title?: string;
  /** Workspace-specific conventions appended to the maintained provider guide. */
  instructions?: string;
  /** Connector-specific inline result limit; omit to inherit the deployment. */
  maxResultBytes?: number;
  /** Serve only read-classified tools on every endpoint. Defaults to false. */
  readOnly?: boolean;
  /** Who may see this connector; see `Connector.members`. Omit for everyone its endpoints admit. */
  members?: NonNullable<ProviderOptions["members"]>;
  /** Per-runtime downstream call-admission policy; replaces the default below Intercom's documented limit. */
  callAdmission?: ConnectorCallAdmissionPolicy;
  /** Removed with the hosted MCP preset; connect Intercom's hosted MCP server through `remoteMcp()`. */
  auth?: never;
}

const INTERCOM_OPTIONS = optionsOf<IntercomOptions>()({
  ...keys("purpose", "region", "admin", "title", "instructions", "maxResultBytes", "auth"),
  readOnly: READ_ONLY,
  members: MEMBERS,
  callAdmission: CALL_ADMISSION,
});

const INTERCOM_ADMISSION: ConnectorCallAdmissionPolicy = {
  rules: [
    {
      maxConcurrency: 8,
      queueTimeoutMs: 5_000,
      retryAfterMs: 1_000,
      budget: { kind: "rolling-window", maxCalls: 1_667, windowMs: 10_000 },
    },
  ],
};

export const intercom = defineApiProvider<IntercomOptions>({
  name: "intercom",
  title: "Intercom",
  readme: "Intercom",
  options: INTERCOM_OPTIONS,
  skill,
  blocks: { keys: ["writes"], select: (options) => (options.readOnly ? [] : ["writes"]) },
  searchSynonyms: [["teammate", "admin"]],
  bundle: {
    baselineGzip: 405055,
    note: "./providers/intercom measures 405,055 B gzip standalone in CI's build (package) job, Node 22.23.4, on the PR merge with main 7be07115 (#1408). This includes the shared Effect provider kit and the compiled 277-operation index, paid once per deployment; provider entries are reported, not capped, and standalone sizes are not additive.",
  },
  vendor: IntercomApi,
  baseUrl: (options) => {
    if (options.auth !== undefined)
      throw new Error(
        "intercom() is the REST provider and takes no auth. Connect Intercom's hosted MCP server with remoteMcp() at https://mcp.intercom.com/mcp (https://mcp.eu.intercom.com/mcp in Europe), under a distinct id beside this connector.",
      );
    adminOption(options.admin, options.readOnly === true);
    return INTERCOM_BASE_URLS[regionOf(options.region)];
  },
  description: (options) => `Intercom support conversations, contacts and tickets: ${options.purpose}`,
  authScope: () => "shared",
  maxResponseBytes: 8 * 1024 * 1024,
  timeoutMs: 30_000,
  headers: { Accept: "application/json", "Intercom-Version": index.version },
  idempotencyKey: false,
  defaultCallAdmission: INTERCOM_ADMISSION,
  credential: (options) => ({
    label: "Intercom access token",
    description: `The access token of a private Intercom app (Developer Hub → your app → Configure → Authentication). Its reads are limited by the installing teammate's conversation access. Stored encrypted and sent only to ${new URL(INTERCOM_BASE_URLS[regionOf(options.region)]).host}.`,
    placeholder: "Paste Intercom access token",
  }),
  authenticate,
  errors,
  safety,
  result,
  probe,
  guide: (options) => {
    const admin = adminOption(options.admin, options.readOnly === true);
    return {
      heading: "Intercom usage",
      summary: "Load for Intercom conversations, contacts and tickets; replies reach customers, notes stay internal.",
      context: [
        `Workspace purpose: ${options.purpose}`,
        `Region: ${INTERCOM_REGION_NAMES[regionOf(options.region)]}. One shared access token over REST.`,
        ...(admin === undefined
          ? []
          : [
              typeof admin === "string"
                ? "Writes act as one teammate the deployment configured; no call chooses the acting admin."
                : "Writes act as the caller's own teammate, mapped by the deployment; no call chooses the acting admin.",
            ]),
        ...readOnlyNotice(options.readOnly === true),
      ],
      required: true,
    };
  },
  hatch: {
    name: "intercom",
    title: "Intercom",
    index,
    verdicts,
    named,
    pages,
    pageCursor: "argument",
    binding,
    pathExample: "/conversations/123456789",
    notes: () => ({
      read: "Search endpoints are POST bodies with a query object; pass pages.next.starting_after back as pagination.starting_after. GET lists that page with starting_after return page.nextCursor. A conversation read without query.page holds only its 500 newest parts; send query.page 1 to page every part oldest first.",
    }),
  },
  tools: ({ connection, options }) =>
    intercomTools({ connection, admin: adminOption(options.admin, options.readOnly === true) }),
  tagConnector: (connector, options) => {
    if (typeof options.admin === "function") tagCallerIdentity(connector);
  },
});
