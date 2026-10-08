// Credentials used by one call. Memory only; never part of a context's public
// shape, a failure record, storage, or a log. Web APIs only.
import { carryFailureFacts } from "./operator-record.js";
import type { ConnectorContext } from "./types.js";

const REDACTED = "[redacted]";
const encoder = new TextEncoder();
const contexts = new WeakMap<ConnectorContext, SentSecrets>();
const wrappedCredentials = new WeakSet<ConnectorContext>();
const sensitiveName = /key|token|secret|auth|signature|session/i;
// Short credentials (especially Basic usernames) would corrupt ordinary prose.
const MIN_SECRET_LENGTH = 8;

function literal(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Percent escapes are case insensitive; the credential's other bytes are not. */
function wirePattern(value: string): string {
  return value.split(/(%[0-9a-f]{2})/i).map((part) =>
    /^%[0-9a-f]{2}$/i.test(part)
      ? `%${part.slice(1).split("").map((char) => /[a-f]/i.test(char) ? `[${char.toUpperCase()}${char.toLowerCase()}]` : char).join("")}`
      : literal(part),
  ).join("");
}

const jsonEscape = /\\(?:u[0-9a-fA-F]{4}|["\\/bfnrt])/g;
const shortEscape: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

function base64(value: string): string {
  let binary = "";
  for (const byte of encoder.encode(value)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export class SentSecrets {
  private readonly values = new Set<string>();
  private matcher: RegExp | undefined;
  private readonly recipients = new Set<SentSecrets>();

  private form(value: string): void {
    if (this.values.has(value)) return;
    this.values.add(value);
    this.matcher = undefined;
    for (const recipient of this.recipients) recipient.form(value);
  }

  /** A program also redacts its later outputs with credentials from its calls. */
  include(source: SentSecrets): void {
    if (source === this) return;
    source.recipients.add(this);
    for (const value of source.values) this.form(value);
  }

  add(value: string): void {
    if (value.length < MIN_SECRET_LENGTH) return;
    for (const form of [value, `Bearer ${value}`, `token ${value}`]) {
      this.form(form);
      this.form(encodeURIComponent(form));
      this.form(encodeURI(form));
      this.form(new URLSearchParams({ value: form }).toString().slice(6));
      const encoded = base64(form);
      this.form(encoded);
      this.form(encoded.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));
    }
  }

  header(value: string): void {
    this.add(value);
    const framed = /^(?:Bearer|token|Basic)\s+(.+)$/i.exec(value);
    if (!framed) return;
    this.add(framed[1]!);
    if (/^Basic\s/i.test(value)) {
      try {
        const decoded = atob(framed[1]!.replace(/-/g, "+").replace(/_/g, "/"));
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
      if (name === "cookie" || sensitiveName.test(name)) this.header(value);
      if (name === "cookie") {
        for (const cookie of value.split(";")) {
          const equals = cookie.indexOf("=");
          if (equals !== -1) this.add(cookie.slice(equals + 1).trim());
        }
      }
    }
    const url = new URL(input instanceof Request ? input.url : String(input));
    for (const [name, value] of url.searchParams) {
      if (sensitiveName.test(name)) this.add(value);
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
    if (this.values.size === 0) return value;
    // Replace longer forms first so a raw token cannot leave its prefix or
    // encoded suffix behind. Literal matches only: ordinary diagnostics stay.
    this.matcher ??= new RegExp([
      literal(REDACTED),
      ...[...this.values].sort((a, b) => b.length - a.length).map(wirePattern),
    ].join("|"), "g");
    // A single pass never scans a newly inserted placeholder as credential
    // text. Protect existing placeholders when another boundary runs too.
    value = value.replace(this.matcher, REDACTED);
    if (value.includes("\\")) value = this.escapedText(value);
    return value.replace(
      /(^|[\r\n])([\t ]*(?:cookie|set-cookie|[a-z0-9-]*(?:key|token|secret|auth|signature|session)[a-z0-9-]*)\s*:\s*)[^\r\n]*/gi,
      `$1$2${REDACTED}`,
    );
  }

  /** Decode a matching view, retaining source spans so replacements stay JSON-safe.
   * Two passes also cover an escaped diagnostic inside a serialized envelope.
   * This avoids exponentially large regexes for vault-backed private keys. */
  private escapedText(source: string): string {
    let view = source;
    let starts = Array.from({ length: source.length }, (_, i) => i);
    let ends = starts.map((i) => i + 1);
    const matches: { start: number; end: number }[] = [];
    for (let pass = 0; pass < 2; pass++) {
      const decoded: string[] = [];
      const nextStarts: number[] = [];
      const nextEnds: number[] = [];
      let cursor = 0;
      const copy = (end: number) => {
        for (; cursor < end; cursor++) {
          decoded.push(view[cursor]!);
          nextStarts.push(starts[cursor]!);
          nextEnds.push(ends[cursor]!);
        }
      };
      for (const match of view.matchAll(jsonEscape)) {
        copy(match.index);
        const code = match[0].slice(1);
        decoded.push(code.startsWith("u") ? String.fromCharCode(parseInt(code.slice(1), 16)) : shortEscape[code]!);
        nextStarts.push(starts[match.index]!);
        cursor = match.index + match[0].length;
        nextEnds.push(ends[cursor - 1]!);
      }
      if (cursor === 0) break;
      copy(view.length);
      view = decoded.join("");
      starts = nextStarts;
      ends = nextEnds;
      for (const match of view.matchAll(this.matcher!)) {
        if (match[0] !== REDACTED) matches.push({ start: starts[match.index]!, end: ends[match.index + match[0].length - 1]! });
      }
    }
    if (matches.length === 0) return source;
    matches.sort((a, b) => a.start - b.start || b.end - a.end);
    let result = "";
    let cursor = 0;
    for (let i = 0; i < matches.length; i++) {
      const match = matches[i]!;
      let end = match.end;
      while (matches[i + 1] && matches[i + 1]!.start <= end) end = Math.max(end, matches[++i]!.end);
      result += source.slice(cursor, match.start) + REDACTED;
      cursor = end;
    }
    return result + source.slice(cursor);
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
        const field = key === "content" ? this.joinedContent(descriptor.value) : descriptor.value;
        changed ||= field !== descriptor.value;
        Object.defineProperty(copy, redactedKey, {
          ...descriptor, value: visit(field),
          ...(redactedKey !== key ? { configurable: true } : {}),
        });
      }
      return item instanceof Error ? carryFailureFacts(item, copy) : copy;
    };
    const copy = visit(value) as T;
    return changed ? copy : value;
  }

  /** Match across blocks before isError/JSON unwrapping concatenates them. */
  private joinedContent(value: unknown): unknown {
    if (!Array.isArray(value)) return value;
    const blocks = value.filter((block) => block?.type === "text" && typeof block.text === "string");
    if (blocks.length < 2) return value;
    for (const separator of ["", "\n"]) {
      const joined = blocks.map((block) => block.text).join(separator);
      const redacted = this.text(joined);
      if (redacted === blocks.map((block) => this.text(block.text)).join(separator)) continue;
      let first = true;
      return value.map((block) => {
        if (!blocks.includes(block)) return block;
        const text = first ? redacted : "";
        first = false;
        return { ...block, text };
      });
    }
    return value;
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

/** Register only after the transport has assembled the request it sends. */
export function sentSecretsFetch(ctx: ConnectorContext, send: typeof fetch = fetch): typeof fetch {
  return (input, init) => {
    sentSecretsFor(ctx).request(input, init);
    return send(input, init);
  };
}
