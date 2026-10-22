// Pure policy shared by the Promise and Effect transports. No runtime or kit imports.

/** Statuses that instruct a client to re-send somewhere else. Never followed. */
export const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Statuses the HTTP spec defines as carrying no body at all. */
export const BODILESS_STATUSES = new Set([204, 205, 304]);

/**
 * A base URL is deployment configuration, so a bad one is a structural mistake
 * and throws where it is written rather than on the first call that uses it.
 */
export function confinementBase(provider: string, baseUrl: string): URL {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new Error(`${provider} baseUrl must be an absolute URL.`);
  }
  const loopback = base.hostname === "localhost" || base.hostname === "127.0.0.1" || base.hostname === "[::1]";
  if (base.protocol !== "https:" && !(base.protocol === "http:" && loopback)) {
    throw new Error(`${provider} baseUrl must be https (http is allowed only for a loopback proxy or test double).`);
  }
  if (base.username || base.password) {
    throw new Error(`${provider} baseUrl must not embed URL credentials; authentication belongs in headers.`);
  }
  if (base.search || base.hash) {
    throw new Error(`${provider} baseUrl must not carry a query or fragment.`);
  }
  return base;
}

/** Parse delta-seconds or an HTTP-date into a non-negative wait window. */
export function retryAfterMs(headers: Headers): number | undefined {
  const raw = headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw.trim());
  if (Number.isFinite(seconds)) {
    return seconds < 0 ? undefined : Math.trunc(seconds * 1000);
  }
  // Require the HTTP-date shape, so Date.parse cannot reinterpret "-1" as
  // a calendar date on runtimes that accept loose date strings.
  if (!/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(raw.trim())) return undefined;
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}
