import { CCB_ENVIRONMENTS, CCB_MEDIA_TYPE } from "./lib/constants.js";
import { skill } from "./skill.generated.js";
import { keys, optionsOf } from "../../config-schema.js";
import { CALL_ADMISSION } from "../../connectors/option-shapes.js";
import { defineApiProvider } from "../../http/provider.js";
import { sensitiveFieldsOption } from "../_shared/sensitive-fields.js";
import type { ConnectorCallAdmissionPolicy } from "../../types.js";
import {
  getMe,
  authenticate,
  CCB_MAX_RESPONSE_BYTES,
  CCB_ADMISSION,
  CcbApi,
  ccbSafety,
  errors,
  oauth,
  resolveScopes,
  CCB_INDEX,
  CCB_VERDICTS,
  CCB_PAGES,
  CCB_NAMED,
  ccbBinding,
} from "./api.js";
import { ccbTools } from "./tools.js";
import { routingLine } from "./lib/guide.js";
export {
  CCB_ENVIRONMENTS,
  CCB_MEDIA_TYPE,
  CCB_READ_SCOPES,
  CCB_WRITE_SCOPES,
  CCB_SENSITIVE_FIELDS,
} from "./lib/constants.js";
/** How the grant acts: for the whole church, or as one signed-in person. */
export type CcbMode = "system" | "identity";

/** Which Pushpay environment the client was issued for. */
export type CcbEnvironment = keyof typeof CCB_ENVIRONMENTS;

export interface CcbOptions {
  /** Which church this connection reaches and what it is for. Required. */
  purpose: string;
  /** Human-readable display name; the default names environment, mode, and access. */
  title?: string;
  /** Church-specific conventions appended to the maintained guide. */
  instructions?: string;
  /**
   * The environment the OAuth client was issued for. Required, with no
   * default: sandbox credentials work only against the sandbox hosts and
   * production credentials only against production, and nothing in a client
   * id says which it is. A wrong guess fails at consent with CCB's opaque
   * "Error accessing page".
   */
  environment: CcbEnvironment;
  /**
   * `"system"` (System Auth): a Master Administrator, or someone who can edit
   * system-wide settings, approves the connection once for the whole church,
   * and every caller shares that one grant. `"identity"` (Identity Auth,
   * `resource_owner_auth=true`): each person signs in as themselves, CCB
   * applies that person's own permissions, and every grant is personal. Identity
   * Auth works only after the church has completed System Auth for the same
   * client. Required: the two modes reach different data for different people.
   */
  mode: CcbMode;
  /**
   * The OAuth client id Pushpay issued. Clients are issued by hand through
   * Pushpay's API access request form
   * (https://vendor.ccbchurch.com/goto/forms/15/responses/new), which also
   * fixes the scopes and the redirect URI — register
   * `<publicUrl>/oauth/callback/<id>` there, character for character.
   */
  clientId: string;
  /** The client secret, from deployment configuration. Never stored. */
  clientSecret: string;
  /**
   * `"read"` (default) requests {@link CCB_READ_SCOPES} and ships no write
   * tool; `"read-write"` adds {@link CCB_WRITE_SCOPES} and `ccb_api_write`.
   * The host may ask the user to confirm a write. Exclusive with `scopes`.
   */
  access?: "read" | "read-write";
  /**
   * The exact scope list to request, replacing `access`: narrower (drop
   * `read:individual_notes`) or wider (add `read:background_checks` for the
   * hatch). Must be a subset of what Pushpay granted the client. Any `write:`
   * or `delete:` scope ships `ccb_api_write`.
   */
  scopes?: readonly string[];
  /**
   * The church's CCB subdomain (`mychurch` for mychurch.ccbchurch.com). Sent
   * at consent so the approver skips typing it. Optional.
   */
  subdomain?: string;
  /** Default rows per page for list tools: 25 (default), 50, 75, or 100. */
  defaultPerPage?: 25 | 50 | 75 | 100;
  /**
   * Replaces the per-endpoint default admission policy. Pass your own to
   * account for other integrations spending from the same API client.
   */
  callAdmission?: ConnectorCallAdmissionPolicy;
  /** Connector-specific inline result limit; omit to inherit the deployment. */
  maxResultBytes?: number;
  /** Serve only read-classified tools on every endpoint. Defaults to false. */
  readOnly?: boolean;
  /**
   * Whether results may carry {@link CCB_SENSITIVE_FIELDS}: allergies,
   * giving numbers and dates, envelope ids, statement dates, attendance
   * prayer requests and meeting notes, and form payment details. `"drop"`
   * (default) removes them wherever they appear in every result: the named
   * tools, the named reads, `search_records`, `ccb_api_read`, and `ccb_api_write`
   * replies. `"return"` lets the hatches return those allowed fields; named projections stay narrow. Credentials and private file destinations are always withheld. Only deployment code decides; no tool argument can.
   */
  sensitiveFields?: "drop" | "return";
}

function defaultTitle(environment: CcbEnvironment, mode: CcbMode, writable: boolean): string {
  const qualifiers = [
    ...(environment === "sandbox" ? ["sandbox"] : []),
    ...(mode === "identity" ? ["per-person"] : []),
    ...(writable ? [] : ["read-only"]),
  ];
  return `Pushpay ChMS (CCB)${qualifiers.length ? ` — ${qualifiers.join(", ")}` : ""}`;
}

/** The closed options ccb() accepts; see `assertKnownOptions`. */
const CCB_OPTIONS = optionsOf<CcbOptions>()({
  ...keys(
    "purpose",
    "title",
    "instructions",
    "environment",
    "mode",
    "clientId",
    "clientSecret",
    "access",
    "scopes",
    "subdomain",
    "defaultPerPage",
    "maxResultBytes",
    "readOnly",
    "sensitiveFields",
  ),
  callAdmission: CALL_ADMISSION,
});

function validatedOrigin(options: Readonly<CcbOptions>): string {
  if (options.environment !== "production" && options.environment !== "sandbox")
    throw new Error(
      'ccb() requires environment: "production" or "sandbox" — the one the OAuth client was issued for. Credentials do not cross environments.',
    );
  if (options.mode !== "system" && options.mode !== "identity")
    throw new Error(
      'ccb() requires mode: "system" (one church-wide grant an administrator approves) or "identity" (each person signs in as themselves).',
    );
  const subdomain = options.subdomain?.trim();
  if (subdomain !== undefined && !/^[a-z0-9][a-z0-9-]{0,62}$/i.test(subdomain))
    throw new Error("ccb() subdomain must be the bare CCB subdomain, such as mychurch.");
  if (![25, 50, 75, 100].includes(options.defaultPerPage ?? 25))
    throw new Error("ccb() defaultPerPage must be 25, 50, 75, or 100 — the only page sizes CCB accepts.");
  sensitiveFieldsOption("ccb", options.sensitiveFields);
  resolveScopes(options);
  return CCB_ENVIRONMENTS[options.environment].apiOrigin;
}
const writable = (options: Readonly<CcbOptions>) => resolveScopes(options).some((scope) => !scope.startsWith("read:"));
/** A maintained Church Community Builder (Pushpay ChMS) v2 connection on the provider kit. */
export const ccb = defineApiProvider<CcbOptions>({
  name: "ccb",
  title: "Church Community Builder",
  readme: "Church Community Builder",
  bundle: {
    baselineGzip: 391649,
    note: "./providers/ccb merged GitHub/Cloudflare/CCB step-2 snapshot measures 391,649 B standalone gzip-9 before recording these bundle facts, Node 26.12.0 with zlib-ng 1.3.1; recomputed with the combined opt-in hatch support. Earlier step-2 standalone gzip snapshot at ffd64b04, CI run 40080865116 static job, Node 22.23.3, against main ce0c7492 (345,272 B). Includes the reviewed 385-operation request/response index. Shared Effect is paid once per deployment; provider entries are reported, uncapped and non-additive (#703) (#899).",
  },
  skill,
  options: CCB_OPTIONS,
  displayTitle: (options) => defaultTitle(options.environment, options.mode, writable(options)),
  description: (options) =>
    `Church Community Builder (Pushpay ChMS) — ${routingLine(options.environment, options.mode, writable(options))}: ${options.purpose}`,
  authScope: (options) => (options.mode === "identity" ? "personal" : "shared"),
  vendor: CcbApi,
  baseUrl: validatedOrigin,
  maxResponseBytes: CCB_MAX_RESPONSE_BYTES,
  headers: { Accept: CCB_MEDIA_TYPE },
  defaultCallAdmission: CCB_ADMISSION,
  authenticate,
  oauth,
  oauthWrite401: "grant",
  errors,
  safety: ccbSafety,
  probe: { operation: getMe, request: {}, describe: () => "Connected to CCB." },
  guide: (options) => ({
    context: [
      `${routingLine(options.environment, options.mode, writable(options))}: ${options.purpose}`,
      "The OAuth client is configured for this environment; use the connection's existing grant. Resolve a person's identity with get_me when needed.",
      `Sensitive fields: ${options.sensitiveFields ?? "drop"}. Named projections stay narrow; credentials and private file destinations are always withheld.`,
      `Configured scopes: ${resolveScopes(options).join(" ")}.`,
      ...(!writable(options)
        ? ["Configured scopes permit only reads: ccb_api_write is omitted and writes are refused."]
        : []),
      ...(options.readOnly ? ["This connection is read-only: every write is refused."] : []),
      ...(options.defaultPerPage !== undefined
        ? [`Named lists default to ${options.defaultPerPage} rows on this connection.`]
        : []),
    ],
    summary: `${options.environment === "sandbox" ? "Sandbox" : "Production"} CCB, ${options.mode === "identity" ? "per person" : "church-wide"}: id resolution, sensitive data, paging, rate limits, hatches.`,
    required: true,
  }),
  pageSize: { default: 25, max: 100 },
  idempotencyKey: false,
  hatch: {
    name: "ccb",
    title: "CCB",
    index: CCB_INDEX,
    verdicts: CCB_VERDICTS,
    named: CCB_NAMED,
    pages: CCB_PAGES,
    pageCursor: "argument",
    binding: ccbBinding,
    writeEnabled: writable,
    pathExample: "/individuals/42",
    notes: () => ({
      read: "Read people and individual profiles, households and families, groups and memberships, events and attendance, campuses, forms and responses, processes and queues, schedules and assignments, notes, pledges, donations, contributions and giving metrics. Discover the exact operation with ccb_api_search, then inspect ccb_api_details.",
      write:
        "Update, edit or change a person's email or phone; create people and new individual profiles, pastoral notes, group memberships and events; add person to group, change group role, record attendance and change phone number. Discover the exact operation with ccb_api_search, then inspect ccb_api_details. Use ccb_api_write for the requested change; the host may ask the user to confirm. Writes require authorized configured scopes.",
    }),
  },
  tools: ccbTools,
});
