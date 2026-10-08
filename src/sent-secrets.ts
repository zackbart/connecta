// Credentials used by one call. Memory only; never part of a context's public
// shape, a failure record, storage, or a log. Web APIs only.
import { carryFailureFacts } from "./operator-record.js";
import type { ConnectorContext } from "./types.js";

const REDACTED = "[redacted]";
const encoder = new TextEncoder();
const contexts = new WeakMap<ConnectorContext, SentSecrets>();
const wrappedCredentials = new WeakSet<ConnectorContext>();

function base64(value: string): string {
  let binary = "";
  for (const byte of encoder.encode(value)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export class SentSecrets {
  private readonly values = new Set<string>();

  add(value: string): void {
    if (!value) return;
    for (const form of [value, `Bearer ${value}`, `token ${value}`]) {
      this.values.add(form);
      this.values.add(encodeURIComponent(form));
      this.values.add(encodeURI(form));
      this.values.add(new URLSearchParams({ value: form }).toString().slice(6));
      const encoded = base64(form);
      this.values.add(encoded);
      this.values.add(encoded.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));
    }
  }

  header(value: string): void {
    this.add(value);
    const framed = /^(?:Bearer|token|Basic)\s+(.+)$/i.exec(value);
    if (!framed) return;
    this.add(framed[1]!);
    if (/^Basic\s/i.test(value)) {
      try {
        const decoded = atob(framed[1]!);
        this.add(decoded);
        const colon = decoded.indexOf(":");
        if (colon !== -1) {
          this.add(decoded.slice(0, colon));
          this.add(decoded.slice(colon + 1));
        }
      } catch { /* An invalid Basic value is still registered verbatim. */ }
    }
  }

  request(input: RequestInfo | URL, init?: RequestInit): void {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    for (const [name, value] of headers) {
      if (/^(?:authorization|proxy-authorization|cookie|x-.*(?:key|token|secret))$/i.test(name)) this.header(value);
    }
    const url = new URL(input instanceof Request ? input.url : String(input));
    for (const [name, value] of url.searchParams) {
      if (/^(?:api[_-]?key|access[_-]?token|token|key|secret)$/i.test(name)) this.add(value);
    }
    // The OAuth SDK sends token requests as form data. Do not read a body
    // stream or clone a Request: registration must not consume its payload.
    if (headers.get("content-type")?.startsWith("application/x-www-form-urlencoded") &&
        (typeof init?.body === "string" || init?.body instanceof URLSearchParams)) {
      for (const [name, value] of new URLSearchParams(init.body)) {
        if (/^(?:client_secret|refresh_token|code|client_assertion|password)$/i.test(name)) this.add(value);
      }
    }
  }

  text(value: string): string {
    // Replace longer forms first so a raw token cannot leave its prefix or
    // encoded suffix behind. Literal matches only: ordinary diagnostics stay.
    const forms = new Set(this.values);
    for (const secret of this.values) {
      // Percent escapes are case insensitive on the wire.
      if (secret.includes("%")) forms.add(secret.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase()));
    }
    const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = [REDACTED, ...[...forms].sort((a, b) => b.length - a.length)].map(escape).join("|");
    // A single pass never scans a newly inserted placeholder as credential
    // text. Protect existing placeholders when another boundary runs too.
    value = value.replace(new RegExp(pattern, "g"), REDACTED);
    return value.replace(
      /(^|[\r\n])([\t ]*(?:authorization|proxy-authorization|cookie|set-cookie|x-[a-z0-9-]*(?:key|token|secret))\s*:\s*)[^\r\n]*/gi,
      `$1$2${REDACTED}`,
    );
  }

  /** Copy, including non-enumerable Error fields; never retain a raw cause. */
  redact<T>(value: T): T {
    if (this.values.size === 0) return value;
    const seen = new Map<object, object>();
    let changed = false;
    const text = (value: string): string => {
      const redacted = this.text(value);
      changed ||= redacted !== value;
      return redacted;
    };
    const visit = (item: unknown): unknown => {
      if (typeof item === "string") return text(item);
      if (item === null || typeof item !== "object") return item;
      const prior = seen.get(item);
      if (prior) return prior;
      const copy = Array.isArray(item) ? [] : item instanceof Error
        ? Object.create(Object.getPrototypeOf(item)) as object
        : {};
      seen.set(item, copy);
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(item))) {
        // V8 lazily renders Error.stack through an own accessor. Snapshot it
        // before rebuilding an error, so its diagnostic is redacted too.
        if (key === "stack" && item instanceof Error && !("value" in descriptor)) {
          Object.defineProperty(copy, key, { value: visit(item.stack), configurable: true, writable: true });
          continue;
        }
        // JSON and errors carry data properties. A downstream-authored getter
        // is not a safe way to expose a diagnostic to an agent.
        if (!("value" in descriptor)) { changed = true; continue; }
        const redactedKey = text(key);
        Object.defineProperty(copy, redactedKey, {
          ...descriptor, value: visit(descriptor.value),
          ...(redactedKey !== key ? { configurable: true } : {}),
        });
      }
      return item instanceof Error ? carryFailureFacts(item, copy) : copy;
    };
    const copy = visit(value) as T;
    return changed ? copy : value;
  }
}

export function sentSecretsFor(ctx: ConnectorContext): SentSecrets {
  let secrets = contexts.get(ctx);
  if (!secrets) { secrets = new SentSecrets(); contexts.set(ctx, secrets); }
  return secrets;
}

/** A handler context copy belongs to the same call, never to its whole request. */
export function carrySentSecrets(from: ConnectorContext, to: ConnectorContext): void {
  contexts.set(to, sentSecretsFor(from));
}

/** Slot reads cover custom handlers too, including keys put in query strings. */
export function trackCredentialReads(ctx: ConnectorContext): void {
  if (!ctx.credential || wrappedCredentials.has(ctx)) return;
  wrappedCredentials.add(ctx);
  const credential = ctx.credential;
  ctx.credential = {
    async get(field) {
      const value = await credential.get(field);
      if (value) sentSecretsFor(ctx).add(value);
      return value;
    },
    async getAll() {
      const values = await credential.getAll();
      for (const value of Object.values(values ?? {})) sentSecretsFor(ctx).add(value);
      return values;
    },
  };
}

export function redactSentSecrets<T>(ctx: ConnectorContext, value: T): T {
  return sentSecretsFor(ctx).redact(value);
}
