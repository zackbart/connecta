/** Classify attempts from the published providers' complete static REST catalogs. */
import { ccb } from "@zackbart/connecta/providers/ccb";
import { stripe } from "@zackbart/connecta/providers/stripe";
import { cloudflare } from "@zackbart/connecta/providers/cloudflare";
import { vercel } from "@zackbart/connecta/providers/vercel";
import { breeze } from "@zackbart/connecta/providers/breeze";
import { tithely } from "@zackbart/connecta/providers/tithely";
import { ACCOUNT_A } from "../fakes/rest.js";

const connectors = [
  ccb("ccb", {
    purpose: "Deterministic CCB acceptance grading",
    environment: "production",
    mode: "system",
    access: "read-write",
    clientId: "50cd5d6a-1943-4fb8-a24a-4e138851df2b",
    clientSecret: "3c841e51-c2a4-496a-8800-8d23875c0193",
  }),
  breeze("breeze", { purpose: "Deterministic Breeze acceptance grading", subdomain: "church" }),
  stripe("stripe_sandbox", {
    purpose: "Deterministic REST acceptance grading",
    auth: { type: "apiKey" },
    mode: "sandbox",
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
