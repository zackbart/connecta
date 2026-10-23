/** Infisical Universal Auth and a finite, reviewed REST secret-manager surface. */
import { keys, optionsOf } from "../../config-schema.js";
import { PROVIDER_COMMON, type ProviderOptions } from "../../provider.js";
import { defineApiProvider } from "../../http/provider.js";
import { bearer } from "../../http/oauth.js";
import { skill } from "./skill.generated.js";
import * as api from "./api.js";
import { infisicalTools } from "./tools.js";
export { INFISICAL_API_BASE_URL } from "./lib/constants.js";
export interface InfisicalOptions extends ProviderOptions {
  /** API base including /api; US cloud by default, EU cloud or self-hosted HTTPS allowed. */
  baseUrl?: string;
}
export const infisical = defineApiProvider<InfisicalOptions>({
  name: "infisical",
  title: "Infisical",
  readme: "Infisical",
  skill,
  options: optionsOf<InfisicalOptions>()({ ...PROVIDER_COMMON, ...keys("baseUrl") }),
  bundle: {
    baselineGzip: 27673,
    note: "./providers/infisical starts at 27,673 B gzip before its C.5 kit migration. Provider entries are reported, not capped (#899).",
  },
  description: (options) => `Infisical secrets management — ${options.purpose}`,
  vendor: api.InfisicalApi,
  baseUrl: api.baseUrl,
  maxResponseBytes: api.MAX_RESPONSE_BYTES,
  headers: { Accept: "application/json" },
  credential: api.credential,
  authenticate: bearer,
  grant: api.grant,
  writeUnauthorized: api.writeUnauthorized,
  errors: api.errors,
  safety: () => api.safety,
  result: api.result,
  probe: api.probe,
  guide: (options) => ({
    context: [`Use this Infisical machine identity at ${api.baseUrl(options)} for ${options.purpose}.`],
    summary: "Find projects and environments first; secret values are omitted from lists unless requested.",
  }),
  tools: infisicalTools,
});
