import { keys, optionsOf } from "../../config-schema.js";
import { defineApiProvider } from "../../http/provider.js";
import { GranolaApi, authenticate, binding, errors, index, pages, probe, result, safety, verdicts } from "./api.js";
import { granolaTools } from "./tools.js";
import { skill } from "./skill.generated.js";

/** One workspace-owned Granola REST API key, managed in the encrypted vault. */
export interface GranolaOptions {
  purpose: string;
  title?: string;
  instructions?: string;
  maxResultBytes?: number;
  /** Common connector restriction; no value enables unreviewed operations or writes. */
  readOnly?: boolean;
}

export const granola = defineApiProvider<GranolaOptions>({
  name: "granola",
  title: "Granola",
  readme: "Granola",
  options: optionsOf<GranolaOptions>()(keys("purpose", "title", "instructions", "maxResultBytes", "readOnly")),
  skill,
  // The guide and vendor call meeting records notes.
  searchSynonyms: [["meeting", "note"]],
  bundle: {
    baselineGzip: 360040,
    note: "./providers/granola standalone measured 360,040 B gzip with Homebrew Node 22 on 2026-10-27. This includes the shared Effect provider kit, paid once per deployment; provider entries are reported, not capped, and standalone sizes are not additive.",
  },
  vendor: GranolaApi,
  baseUrl: () => "https://public-api.granola.ai",
  description: (options) => `Granola workspace meeting notes: ${options.purpose}`,
  authScope: () => "shared",
  maxResponseBytes: 4 * 1024 * 1024,
  timeoutMs: 30_000,
  headers: { Accept: "application/json" },
  idempotencyKey: false,
  defaultCallAdmission: {
    rules: [
      {
        maxConcurrency: 2,
        maxQueueSize: 25,
        queueTimeoutMs: 5_000,
        retryAfterMs: 1_000,
        budget: { kind: "rolling-window", maxCalls: 25, windowMs: 5_000 },
      },
    ],
  },
  credential: {
    label: "Granola workspace API key",
    description:
      "Workspace-owned key from Settings → Connectors → Workspace API keys (Business or Enterprise admin). Public notes and API-enabled spaces only; not a personal key or MCP OAuth token. Stored encrypted and sent only to public-api.granola.ai.",
    placeholder: "grn_…",
  },
  authenticate,
  errors,
  safety,
  result,
  probe,
  guide: (options) => ({
    heading: "Granola usage",
    summary: "Read workspace notes and transcripts; discover accessible spaces and folders before filtering.",
    context: [
      `Workspace purpose: ${options.purpose}`,
      "One shared workspace API key over REST. This connection exposes only reviewed reads.",
    ],
    required: true,
  }),
  hatch: {
    name: "granola",
    title: "Granola",
    index,
    verdicts,
    pages,
    pageCursor: "argument",
    binding,
    pathExample: "/v1/notes",
    notes: () => ({
      read: "Omit query.cursor initially; pass page.nextCursor unchanged as top-level cursor with the same path and query. Note/folder/space page_size defaults to 10 (maximum 30); transcripts default to 50 (maximum 100).",
    }),
  },
  tools: granolaTools,
});
