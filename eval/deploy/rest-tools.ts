/** Classify attempts from the published providers' complete static REST catalogs. */
import { stripe } from "@zackbart/connecta/providers/stripe";
import { notion } from "@zackbart/connecta/providers/notion";
import { cloudflare } from "@zackbart/connecta/providers/cloudflare";
import { vercel } from "@zackbart/connecta/providers/vercel";
import { tithely } from "@zackbart/connecta/providers/tithely";
import { ACCOUNT_A } from "../fakes/rest.js";

const connectors = [
  stripe("stripe_sandbox", {
    purpose: "Deterministic REST acceptance grading",
    auth: { type: "apiKey" },
    mode: "sandbox",
  }),
  notion("notion_bot", {
    purpose: "Deterministic REST acceptance grading",
    auth: { type: "token" },
    defaultPageSize: 100,
  }),
  cloudflare("cloudflare_prod", {
    purpose: "Deterministic REST acceptance grading",
    auth: { type: "apiToken" },
    pin: { accountIds: [ACCOUNT_A] },
  }),
  cloudflare("cloudflare_legacy", {
    purpose: "Deterministic REST acceptance grading",
    auth: { type: "globalApiKey" },
    pin: { accountIds: [ACCOUNT_A] },
  }),
  vercel("vercel_rest", {
    purpose: "Deterministic REST acceptance grading",
    auth: { type: "token" },
    teamId: "team_fake",
  }),
  tithely("tithely", { purpose: "Deterministic REST acceptance grading", environment: "live" }),
];
export const REST_TOOL_KINDS = new Map<string, "read" | "write">(
  connectors.flatMap((connector) => {
    if (!connector.staticTools) throw new Error(`REST grading needs a complete static catalog: ${connector.id}`);
    return connector.staticTools.map(
      (tool) =>
        [
          `${connector.id}.${tool.name}`,
          tool.annotations?.readOnlyHint === true && tool.annotations?.destructiveHint !== true ? "read" : "write",
        ] as const,
    );
  }),
);
export const REST_READ_TOOLS = new Set<string>(
  [...REST_TOOL_KINDS].filter(([, kind]) => kind === "read").map(([address]) => address),
);
