// Closed option shapes shared by the built-in connector factories: `api()`,
// `remoteMcp()`, and every maintained provider. Each factory walks its options
// against its shape with `assertKnownOptions` before reading a value, so a
// misspelled `maxResultByte` or `requireHTTPs` throws at construction with its
// path instead of silently doing nothing (INV-11). Values stay the factory's
// to validate; handlers, schemas, and loggers pass through as `opaque()`.

import { array, keys, optionsOf, strings, variants } from "../config-schema.js";
import type {
  ConnectorCredentialConfig,
  ConnectorCredentialFieldConfig,
  ConnectorUsageGuide,
} from "../types.js";
export { CALL_ADMISSION, PROVIDER_COMMON } from "../provider.js";
import type { RemoteMcpAuth } from "./remote-mcp.js";

type AuthCase<T extends RemoteMcpAuth["type"]> = Extract<RemoteMcpAuth, { type: T }>;

export const CREDENTIAL = optionsOf<ConnectorCredentialConfig>()({
  ...keys("label", "description", "placeholder"),
  fields: array(
    optionsOf<ConnectorCredentialFieldConfig>()(
      keys("name", "label", "description", "placeholder", "inputType"),
    ),
  ),
});

/** The structured form; a string guide has no keys to check. */
export const USAGE_GUIDE = optionsOf<ConnectorUsageGuide>()(keys("content", "summary", "required"));

/** `remoteMcp()`'s `auth`, closed per `type`. */
export const REMOTE_MCP_AUTH = variants("type", {
  headers: optionsOf<AuthCase<"headers">>()({ ...keys("type"), headers: strings() }).shape,
  credential: optionsOf<AuthCase<"credential">>()({
    ...keys("type", "header", "scheme"),
    credential: CREDENTIAL,
  }).shape,
  oauth: optionsOf<AuthCase<"oauth">>()(keys("type", "clientMetadataUrl", "scope")).shape,
});
