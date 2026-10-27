import { keys, optionsOf } from "../../config-schema.js";
import { PROVIDER_COMMON } from "../../connectors/option-shapes.js";
import { defineApiProvider } from "../../http/provider.js";
import type { ProviderOptions } from "../../provider.js";
import { bearer } from "../../http/oauth.js";
import {
  apiOrigin,
  companyInfo,
  errors,
  oauth,
  QuickBooksApi,
  QUICKBOOKS_INDEX,
  QUICKBOOKS_NAMED,
  QUICKBOOKS_VERDICTS,
  quickbooksBinding,
  result,
} from "./api.js";
import { quickbooksSafety } from "./safety.js";
import { quickbooksTools } from "./tools.js";
import { skill } from "./skill.generated.js";

/** One fixed QuickBooks Online company, using the deployment's own Intuit app. */
export interface QuickBooksOptions extends ProviderOptions {
  realmId: string;
  environment: "sandbox" | "production";
  clientId: string;
  clientSecret: string;
  /** Default rows per search: 25, at most 100. */
  defaultPageSize?: number;
}

const OPTIONS = optionsOf<QuickBooksOptions>()({
  ...PROVIDER_COMMON,
  ...keys("realmId", "environment", "clientId", "clientSecret", "defaultPageSize"),
});

function baseUrl(options: Readonly<QuickBooksOptions>): string {
  if (
    typeof options.realmId !== "string" ||
    options.realmId.trim() !== options.realmId ||
    !/^[1-9]\d{0,30}$/.test(options.realmId)
  )
    throw new Error("quickbooks() realmId must be the fixed numeric company id.");
  if (options.environment !== "sandbox" && options.environment !== "production")
    throw new Error('quickbooks() requires environment: "sandbox" or "production".');
  for (const key of ["clientId", "clientSecret"] as const) {
    if (typeof options[key] !== "string" || !options[key].trim() || /[\r\n]/.test(options[key]))
      throw new Error(`quickbooks() requires ${key}.`);
  }
  return `${apiOrigin(options)}/v3/company/${options.realmId}`;
}

export const quickbooks = defineApiProvider<QuickBooksOptions>({
  name: "quickbooks",
  title: "QuickBooks Online",
  readme: "QuickBooks Online",
  bundle: {
    baselineGzip: 357549,
    note: "./providers/quickbooks initial read surface measures 357,549 B standalone gzip-9 before recording these bundle facts (Node 26.12.0, neutral workerd/worker/browser/import conditions, esbuild). Shared Effect is paid once per deployment; this provider baseline is reported, not capped (#1079).",
  },
  skill,
  options: OPTIONS,
  displayTitle: (options) => `QuickBooks Online (${options.environment})`,
  description: (options) =>
    `QuickBooks Online accounting reads, company ${options.realmId} (${options.environment}): ${options.purpose}`,
  vendor: QuickBooksApi,
  baseUrl,
  maxResponseBytes: 4 * 1024 * 1024,
  headers: { Accept: "application/json" },
  pageSize: { default: 25, max: 100 },
  idempotencyKey: false,
  authenticate: bearer,
  oauth,
  errors,
  result,
  safety: quickbooksSafety,
  probe: {
    operation: companyInfo,
    request: (options: Readonly<QuickBooksOptions>) => ({
      params: { id: options.realmId },
      query: { minorversion: "75" },
    }),
    describe: () => "Connected to the configured QuickBooks Online company.",
  },
  guide: (options) => ({
    context: [
      `Company ${options.realmId}, ${options.environment}: ${options.purpose}`,
      "Only reviewed accounting reads are exposed. Intuit's accounting consent scope also permits writes outside this connector.",
      "Contact details, bank/card/tax identifiers, credentials and private links are withheld on every read.",
    ],
    summary:
      "QuickBooks Online accounting reads: company identity, record joins, decimal money and hierarchical reports.",
    required: true,
  }),
  hatch: {
    name: "quickbooks",
    title: "QuickBooks Online",
    index: QUICKBOOKS_INDEX,
    verdicts: QUICKBOOKS_VERDICTS,
    named: QUICKBOOKS_NAMED,
    pathExample: "/invoice/42",
    binding: quickbooksBinding,
    notes: () => ({
      read: "Only reviewed record, company and report reads. Use search_records for bounded structured queries; raw SQL is refused.",
    }),
  },
  tools: quickbooksTools,
});
