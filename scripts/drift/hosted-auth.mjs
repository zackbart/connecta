/**
 * Frame one hosted-provider credential as its Authorization header.
 *
 * Mixpanel's beta MCP service-account scheme is deliberately not ordinary
 * HTTP Basic: the provider requires `Bearer Basic <base64(user:secret)>`.
 * The other hosted providers use their ordinary bearer or Basic forms.
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
