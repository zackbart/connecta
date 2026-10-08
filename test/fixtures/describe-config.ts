// Connecta.describeConfig(): the secret-free configuration snapshot the
// operator UI and `connecta doctor --config` read.
//
// The sentinel suite plants a distinct secret in every position that can
// carry one — header values, bearer and Clerk secrets, vault keys, OAuth
// client secrets, URL userinfo and queries, stored credentials and access
// tokens, function bodies — and asserts none survives serialization. The
// snapshot is an allowlist serializer, so a secret added to a config object
// later stays out by construction; this suite is what notices if it does not.

import { accessTokens } from "../../src/access-tokens.js";
import { activityHistory, type ActivityStore } from "../../src/activity.js";
import { artifacts, kvArtifactStore } from "../../src/artifacts.js";
import { bearerToken } from "../../src/auth/bearer.js";
import { clerkAuth } from "../../src/auth/clerk.js";
import { encryptedCredentialVault } from "../../src/credentials.js";
import {
  api,
  customExecutor,
  remoteMcp,
  type Connector,
} from "../../src/index.js";
import { basecamp } from "../../src/providers/basecamp/index.js";
import { ccb } from "../../src/providers/ccb/index.js";
import { linear } from "../../src/providers/linear/index.js";
import { stripe } from "../../src/providers/stripe/index.js";
import { memoryStorage } from "../../src/storage/memory.js";
import { operatorUi } from "../../src/ui.js";

const BASE = "https://connecta.example";
const executor = customExecutor({ execute: async () => ({ result: null }) }, { lifecycle: "self-managed" });
const publishableKey =
  "pk_test_" + Buffer.from("clerk.example.com$", "utf8").toString("base64");

/** Every planted secret, by position, so a failure names where it leaked. */
export const SECRETS = {
  headerValue: "SENTINEL-header-value",
  secondHeaderValue: "SENTINEL-second-header",
  urlPassword: "SENTINEL-url-password",
  urlQuery: "SENTINEL-url-query",
  urlFragment: "SENTINEL-url-fragment",
  cimdQuery: "SENTINEL-cimd-query",
  bearerToken: "SENTINEL-inbound-bearer",
  clerkSecretKey: "SENTINEL-clerk-secret-key",
  oauthClientId: "SENTINEL-oauth-client-id",
  oauthClientSecret: "SENTINEL-oauth-client-secret",
  oauthParam: "SENTINEL-authorization-param",
  oauthTokenHeader: "SENTINEL-token-request-header",
  oauthEndpointQuery: "SENTINEL-endpoint-query",
  providerClientSecret: "SENTINEL-provider-client-secret",
  providerHeader: "SENTINEL-provider-header",
  providerKey: "SENTINEL-provider-api-key",
  storedCredential: "SENTINEL-stored-credential",
  storedAccessToken: "cta_SENTINEL-access-token",
  functionBody: "SENTINEL-function-body",
  deploymentInfo: "SENTINEL-deployment-info",
  websiteQuery: "SENTINEL-website-query",
  publicUrlQuery: "SENTINEL-public-url-query",
  iconData: "SENTINEL-icon-data",
  loggerField: "SENTINEL-logger-field",
  activityStoreField: "SENTINEL-activity-store-field",
  storeDescribe: "SENTINEL-store-describe",
  customDescribe: "SENTINEL-custom-describe",
  productUrlPassword: "SENTINEL-product-url-password",
  productUrlQuery: "SENTINEL-product-url-query",
  productUrlFragment: "SENTINEL-product-url-fragment",
  ownerUrlPassword: "SENTINEL-owner-url-password",
  ownerUrlQuery: "SENTINEL-owner-url-query",
  ownerUrlFragment: "SENTINEL-owner-url-fragment",
  faviconPassword: "SENTINEL-favicon-password",
  faviconQuery: "SENTINEL-favicon-query",
  faviconFragment: "SENTINEL-favicon-fragment",
  providerCimdQuery: "SENTINEL-provider-cimd-query",
} as const;
/** Base64 of 32 bytes: the vault key itself is the secret. */
export const VAULT_KEY = Buffer.from("SENTINEL-vault-key-32-bytes-long").toString("base64");

export function secretBearingDeployment() {
  const storage = memoryStorage();
  const fn = (result: unknown) => () => {
    // A function's source can name a secret; it must never be stringified.
    void SECRETS.functionBody;
    return result;
  };
  // A custom store whose describe() answers free text where a kind and a
  // number belong: described as "custom", with no retention.
  const activityStore: ActivityStore & { token: string } = {
    token: SECRETS.activityStoreField,
    record() {},
    describe: () => ({ kind: SECRETS.storeDescribe, retentionDays: SECRETS.storeDescribe as never }),
  };
  // A connector whose own describe() tries to smuggle values past the
  // allowlist: unknown fields and a header *value* posing as a name list.
  const custom: Connector = {
    id: "custom_conn",
    listTools: async () => [],
    callTool: async () => null,
    describe: () => ({
      source: { kind: "custom" },
      secret: SECRETS.customDescribe,
      endpoint: { origin: `https://u:${SECRETS.customDescribe}@custom.example`, path: `/p?k=${SECRETS.customDescribe}` },
      auth: { mode: "headers", headerNames: ["X-Key"], value: SECRETS.customDescribe },
    }) as never,
  };
  const vault = encryptedCredentialVault(storage, VAULT_KEY);
  return {
    storage,
    vault,
    config: {
      storage,
      publicUrl: `${BASE}/?token=${SECRETS.publicUrlQuery}`,
      executor,
      logger: { debug() {}, info() {}, warn() {}, error() {}, token: SECRETS.loggerField },
      auth: [
        bearerToken(SECRETS.bearerToken, { subjectId: "operator" }),
        clerkAuth({ publishableKey, secretKey: SECRETS.clerkSecretKey, publicUrl: BASE }),
      ],
      accessTokens: accessTokens(storage),
      vault,
      ui: operatorUi({
        branding: {
          productUrl: `https://brand:${SECRETS.productUrlPassword}@brand.example/product` +
            `?k=${SECRETS.productUrlQuery}#${SECRETS.productUrlFragment}`,
          ownerName: "Owner",
          ownerUrl: `https://owner:${SECRETS.ownerUrlPassword}@owner.example/` +
            `?k=${SECRETS.ownerUrlQuery}#${SECRETS.ownerUrlFragment}`,
          favicon: {
            href: `https://icon:${SECRETS.faviconPassword}@cdn.example/icon.svg` +
              `?sig=${SECRETS.faviconQuery}#${SECRETS.faviconFragment}`,
          },
        },
      }),
      activity: activityHistory({ store: activityStore, deploymentId: "production" }),
      artifacts: artifacts({ store: kvArtifactStore(storage), renderCheck: fn({ ok: true }) as never }),
      identity: {
        connectorAccess: fn("all") as never,
        credentialAdministration: fn("all") as never,
      },
      pools: { support: { tools: ["static_api"], grant: fn(true) as never } },
      serverInfo: {
        websiteUrl: `https://about.example/connecta?k=${SECRETS.websiteQuery}`,
        icons: [{ src: `data:image/svg+xml,${SECRETS.iconData}` }],
      },
      deploymentInfo: { token: SECRETS.deploymentInfo },
      connectors: [
        remoteMcp("static_mcp", {
          url: `https://svc:${SECRETS.urlPassword}@mcp.example.com/mcp?token=${SECRETS.urlQuery}#${SECRETS.urlFragment}`,
          auth: {
            type: "headers",
            headers: { Authorization: `Bearer ${SECRETS.headerValue}`, "X-Api-Key": SECRETS.secondHeaderValue },
          },
          logger: { debug() {}, info() {}, warn() {}, error() {} },
        }),
        remoteMcp("oauth_mcp", {
          url: "https://oauth.example.com/mcp",
          auth: {
            type: "oauth",
            clientMetadataUrl: `https://client.example/cimd.json?k=${SECRETS.cimdQuery}`,
            scope: "read",
          },
        }),
        remoteMcp("vaulted_mcp", {
          url: "https://vaulted.example.com/mcp",
          auth: { type: "credential", credential: { label: "API key" }, header: "X-Key", scheme: null },
        }),
        api("static_api", {
          description: "Static API",
          oauth: {
            authorizationEndpoint: `https://auth.example/authorize?k=${SECRETS.oauthEndpointQuery}`,
            tokenEndpoint: "https://auth.example/token",
            clientId: SECRETS.oauthClientId,
            clientSecret: SECRETS.oauthClientSecret,
            scope: "read write",
            authorizationParams: { access_type: SECRETS.oauthParam },
            tokenRequestHeaders: { "X-Token-Auth": SECRETS.oauthTokenHeader },
            apiOrigins: ["https://api.example"],
          },
          callAdmission: {
            rules: [{ maxConcurrency: 2, budget: { kind: "rolling-window", maxCalls: 10, windowMs: 1_000 },
              partitionKey: fn("account") as never }],
          },
          tools: [{
            name: "read",
            description: "Read a thing.",
            inputSchema: { type: "object", properties: { id: { type: "string" } } },
            annotations: { readOnlyHint: true },
            handler: fn({ ok: true }) as never,
          }, {
            name: "write",
            description: "Write a thing.",
            annotations: { readOnlyHint: false },
            handler: fn({ ok: true }) as never,
          }],
        }),
        ccb("church", {
          purpose: "Pastoral care",
          environment: "production",
          mode: "system",
          clientId: "church-client",
          clientSecret: SECRETS.providerClientSecret,
        }),
        stripe("billing", {
          purpose: "Revenue questions",
          mode: "sandbox",
          auth: { type: "headers", headers: { Authorization: `Bearer ${SECRETS.providerHeader}` } },
        }),
        linear("tracker", {
          purpose: "Roadmap questions",
          access: "read-only",
          auth: { type: "headers", headers: { Authorization: SECRETS.providerKey } },
        }),
        basecamp("studio", {
          purpose: "Client projects",
          clientMetadataUrl: `https://client.example/basecamp-client?k=${SECRETS.providerCimdQuery}`,
        }),
        custom,
      ],
    },
  };
}
