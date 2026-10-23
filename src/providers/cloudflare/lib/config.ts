/** Cloudflare's v4 REST base. Override only for a proxy or a test double. */
export const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";

/** The two key schemes Cloudflare's v4 API accepts. */
export type CloudflareKeyAuth = "apiToken" | "globalApiKey";

/** Accounts and zones a connector may touch; everything else is refused. */
export interface CloudflarePin {
  accountIds?: readonly string[];
  zoneIds?: readonly string[];
}

export interface CloudflareRestOptions {
  auth: CloudflareKeyAuth;
  baseUrl: string;
  accountId: string | undefined;
  zoneId: string | undefined;
  pin: CloudflarePin | undefined;
}
