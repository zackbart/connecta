/**
 * Frame one hosted-provider credential as its Authorization header.
 *
 * Mixpanel's beta MCP service-account scheme is deliberately not ordinary
 * HTTP Basic: the provider requires `Bearer Basic <base64(user:secret)>`.
 * The other hosted providers use their ordinary bearer or Basic forms —
 * RevenueCat's API v2 secret key is a plain `Bearer sk_…`, which is what a
 * colon-free, whitespace-free value already becomes, so it needs no shaping
 * of its own.
 */
export function hostedAuthorizationHeader(provider, value) {
  const credential = value.trim();
  if (/\s/.test(credential)) return credential;
  if (credential.includes(":")) {
    const encoded = Buffer.from(credential, "utf8").toString("base64");
    return provider === "mixpanel" ? `Bearer Basic ${encoded}` : `Basic ${encoded}`;
  }
  return `Bearer ${credential}`;
}
