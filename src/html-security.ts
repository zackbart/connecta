/** Common headers for HTML, including script-free status and error pages. */
export function htmlSecurityHeaders(
  initial: HeadersInit,
  options: { clerkOrigin?: string; frameSelf?: boolean; nonce?: string } = {},
): Headers {
  const headers = new Headers(initial);
  const { clerkOrigin, frameSelf, nonce } = options;
  // Clerk's CAPTCHA host is exact and only admitted with a validated loader
  // origin. No wildcard or general HTTPS script permission is needed.
  const scripts = `${nonce ? `'nonce-${nonce}' ` : ""}'self'` +
    (clerkOrigin ? ` ${clerkOrigin} https://challenges.cloudflare.com` : "");
  if (!headers.has("Content-Security-Policy")) {
    headers.set("Content-Security-Policy",
      `script-src ${scripts}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'` +
      (clerkOrigin
        ? `; connect-src 'self' ${clerkOrigin}; img-src 'self' https://img.clerk.com; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'`
        : "") +
      (clerkOrigin || frameSelf ? `; frame-src ${frameSelf ? "'self' " : ""}${clerkOrigin ? "https://challenges.cloudflare.com" : ""}`.trimEnd() : ""));
  }
  // Sandboxed artifact documents retain their own framing and script policy.
  if (headers.get("Content-Security-Policy")!.includes("frame-ancestors 'none'")) {
    headers.set("X-Frame-Options", "DENY");
  }
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", "no-store");
  return headers;
}
