// Credentials and private argument values used by one upstream request. Memory only; never part of a context's public
// shape, a failure record, storage, or a log. Web APIs only.
import { carryFailureFacts } from "./operator-record.js";
import { ConnectorCallError } from "./errors.js";
import { credentialUrlViews } from "./credential-url.js";
import { visitPrivateCallArguments } from "./argument-redaction.js";
import type { ConnectorContext, JsonSchema, Logger } from "./types.js";

const REDACTED = "[redacted]";
const encoder = new TextEncoder();
const contexts = new WeakMap<ConnectorContext, SentSecrets>();
const requests = new WeakMap<object, SentSecrets>();
const wrappedCredentials = new WeakSet<ConnectorContext>();
const sensitiveName = /key|token|secret|password|auth|signature|session/i;
const explicitSecretName = /secret|password/i;
// Short credentials can match protocol fields or legitimate configuration.
const MIN_SECRET_LENGTH = 8;
const MAX_FORM_BYTES = 1_048_576;
const MAX_SCAN_BYTES = 16_777_216;
// Existing credential-only reads include multi-MiB documents and skill files.
const MAX_CREDENTIAL_SCAN_BYTES = 1_073_741_824;
const MAX_ESCAPED_FORM_LENGTH = 2048;
type ScanBudget = { remaining: number };
type Match = { start: number; end: number };

type SecretWarning = { code: "short_secret_not_redacted" };

/** One payload-free warning per configured connector, regardless of requests. */
export function shortSecretWarning(): (value: string | undefined, logger: Logger) => void {
  let warned = false;
  return (value, logger) => {
    if (warned || !value || value.length >= MIN_SECRET_LENGTH) return;
    warned = true;
    const fact: SecretWarning = { code: "short_secret_not_redacted" };
    logger.warn(
      "[connecta] Credentials shorter than 8 characters are not redacted from echoes; use longer secrets.",
      fact,
    );
  };
}

/** Same-length normalization keeps match spans in the original source. */
function wireText(value: string): string {
  return value.replace(/%[0-9a-f]{2}/gi, (escape) => escape.toUpperCase());
}

/** Literal scans never compile submitted values as regular expressions.
 * Charge UTF-16 bytes for every scan and cap both work and match storage. */
function findMatches(
  source: string,
  forms: Iterable<string>,
  budget: ScanBudget,
  ignoreCase = false,
  protectPlaceholders = true,
): Match[] | undefined {
  budget.remaining -= source.length * 2;
  if (budget.remaining < 0) return undefined;
  const view = wireText(ignoreCase ? source.toLowerCase() : source);
  const matches: Match[] = [];
  const protectedSpans: Match[] = [];
  if (protectPlaceholders)
    for (let at = source.indexOf(REDACTED); at !== -1; at = source.indexOf(REDACTED, at + REDACTED.length)) {
      budget.remaining -= 16;
      if (budget.remaining < 0) return undefined;
      protectedSpans.push({ start: at, end: at + REDACTED.length });
    }
  for (const form of forms) {
    if (form.length > source.length) continue;
    budget.remaining -= 2 * (source.length + form.length);
    if (budget.remaining < 0) return undefined;
    const needle = ignoreCase ? wireText(form.toLowerCase()) : form;
    let protectedIndex = 0;
    for (let at = view.indexOf(needle); at !== -1; at = view.indexOf(needle, at + needle.length)) {
      budget.remaining -= 16;
      if (budget.remaining < 0) return undefined;
      const end = at + needle.length;
      while (protectedSpans[protectedIndex] && protectedSpans[protectedIndex]!.end <= at) protectedIndex++;
      // Only an exact emitted marker is exempt. A submitted value may
      // contain the marker or overlap it and must still be redacted.
      if (protectedSpans[protectedIndex]?.start === at && protectedSpans[protectedIndex]?.end === end) continue;
      matches.push({ start: at, end });
    }
  }
  return matches;
}

function replaceMatches(source: string, matches: Match[]): string {
  matches.sort((a, b) => a.start - b.start || b.end - a.end);
  const output: string[] = [];
  let cursor = 0;
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i]!;
    let end = match.end;
    while (matches[i + 1] && matches[i + 1]!.start <= end) end = Math.max(end, matches[++i]!.end);
    output.push(source.slice(cursor, match.start), REDACTED);
    cursor = end;
  }
  return output.length ? output.join("") + source.slice(cursor) : source;
}

/** Private arguments must not rewrite Connecta/MCP framing into invalid
 * tags or lose a typed outcome. Payload children retain exact-leaf matching. */
function protocolField(item: object, key: string): "key" | "tag" | undefined {
  if (item instanceof Error && ["name", "message", "stack", "cause", "code"].includes(key))
    return key === "name" || key === "code" ? "tag" : "key";
  if (
    "type" in item &&
    ["text", "image", "audio", "resource", "resource_link"].includes(String(item.type)) &&
    ["type", "text", "data", "mimeType", "resource", "uri", "name", "description", "annotations"].includes(key)
  )
    return key === "type" ? "tag" : "key";
  if (
    "content" in item &&
    Array.isArray(item.content) &&
    ["content", "structuredContent", "isError", "_meta", "resultType"].includes(key)
  )
    return key === "resultType" ? "tag" : "key";
  if (
    "data" in item &&
    "format" in item &&
    (item.format === "json" || item.format === "text") &&
    ["data", "format"].includes(key)
  )
    return key === "format" ? "tag" : "key";
  if ("ok" in item && typeof item.ok === "boolean" && ["ok", "data", "error", "format"].includes(key))
    return key === "format" ? "tag" : "key";
  if (
    "code" in item &&
    "retryable" in item &&
    typeof item.retryable === "boolean" &&
    ["code", "message", "retryable", "retryAfterMs", "cause", "nextAction", "uncertainCall"].includes(key)
  )
    return key === "code" ? "tag" : "key";
  if ("result" in item && "logs" in item && ["result", "logs", "error", "calls", "durationMs", "budget"].includes(key))
    return "key";
  if (key === "dev.connecta/format" && key in item) return "tag";
  return undefined;
}

const jsonEscape = /\\(?:u[0-9a-fA-F]{4}|["\\/bfnrt])/g;
const shortEscape: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

function base64(value: string): string {
  let binary = "";
  for (const byte of encoder.encode(value)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export class SentSecrets {
  private readonly values = new Set<string>();
  private readonly shortValues = new Set<string>();
  private readonly credentialValues = new Set<string>();
  private credentialView: SentSecrets | undefined;
  private formBytes = 0;
  private privateArguments = false;
  private unmatchedLength = Infinity;
  private credentialUnmatchedLength = Infinity;
  private unicode = false;
  private readonly recipients = new Set<SentSecrets>();

  private limited(length: number, argument: boolean): void {
    this.privateArguments ||= argument;
    if (length >= this.unmatchedLength && (argument || length >= this.credentialUnmatchedLength)) return;
    this.unmatchedLength = Math.min(this.unmatchedLength, length);
    if (!argument) {
      this.credentialUnmatchedLength = Math.min(this.credentialUnmatchedLength, length);
      this.credentialView = undefined;
    }
    for (const recipient of this.recipients) recipient.limited(length, argument);
  }

  private form(value: string, argument = false, short = false): void {
    this.privateArguments ||= argument;
    value = wireText(value);
    const values = short ? this.shortValues : this.values;
    const promoted = !argument && !this.credentialValues.has(value);
    if (!values.has(value)) {
      const bytes = encoder.encode(value).byteLength;
      if (this.formBytes + bytes > MAX_FORM_BYTES) {
        this.limited(value.length, argument);
        return;
      }
      this.formBytes += bytes;
    }
    if (promoted) {
      this.credentialValues.add(value);
      this.credentialView = undefined;
    }
    if (values.has(value) && !promoted) return;
    values.add(value);
    if (!this.unicode)
      for (const char of value) {
        if (char.charCodeAt(0) > 127) {
          this.unicode = true;
          break;
        }
      }
    for (const recipient of this.recipients) recipient.form(value, argument, short);
  }

  /** The request receives existing and future secrets from every context. */
  include(source: SentSecrets): void {
    if (source === this) return;
    source.recipients.add(this);
    this.privateArguments ||= source.privateArguments;
    for (const value of source.values) this.form(value, !source.credentialValues.has(value));
    for (const value of source.shortValues) this.form(value, true, true);
    if (source.unmatchedLength !== Infinity) this.limited(source.unmatchedLength, true);
    if (source.credentialUnmatchedLength !== Infinity) this.limited(source.credentialUnmatchedLength, false);
  }

  add(value: string, argument = false): void {
    if (!value || (!argument && value.length < MIN_SECRET_LENGTH)) return;
    if (value.length > MAX_FORM_BYTES) {
      this.limited(value.length, argument);
      return;
    }
    const short = argument && value.length < MIN_SECRET_LENGTH;
    for (const form of [value, `Bearer ${value}`, `token ${value}`]) {
      this.form(form, argument, short);
      try {
        this.form(encodeURIComponent(form), argument, short);
        this.form(encodeURI(form), argument, short);
      } catch {
        // Invalid Unicode cannot escape as a URI; no encoder diagnostics leave this boundary.
      }
      this.form(new URLSearchParams({ value: form }).toString().slice(6), argument, short);
      const encoded = base64(form);
      this.form(encoded, argument, short);
      this.form(encoded.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""), argument, short);
    }
  }

  /** Explicit secrets use the same floor as every other credential. */
  secret(value: string): void {
    this.add(value);
  }

  /** Short non-empty strings protect exact leaves and prose. Empty strings cannot leak.
   * Uncollectable or non-string private data still withholds the whole result. */
  arguments(args: unknown, schema: JsonSchema | undefined): { withholdDetail: boolean; withholdResult: boolean } {
    let withhold = false;
    let short = false;
    let visited = 0;
    const active = new Set<object>();
    const collect = (value: unknown, depth = 0): void => {
      if (++visited > 2048 || depth > 32) {
        withhold = true;
        return;
      }
      if (typeof value === "string") {
        short ||= value.length > 0 && value.length < MIN_SECRET_LENGTH;
        this.add(value, true);
      } else if (value !== null && typeof value === "object") {
        if (active.has(value)) {
          withhold = true;
          return;
        }
        active.add(value);
        for (const [key, entry] of Object.entries(value)) {
          if (!Array.isArray(value)) collect(key, depth + 1);
          collect(entry, depth + 1);
        }
        active.delete(value);
      } else {
        // Literal matching cannot protect numeric/boolean structured output.
        withhold = true;
      }
    };
    if (schema) visitPrivateCallArguments(args, schema, collect);
    return { withholdDetail: withhold || short, withholdResult: withhold };
  }

  /** Submitted private data is not an auth credential. Keep later program
   * arguments intact while retaining the existing credential exfiltration guard. */
  redactInput<T>(value: T): T {
    if (
      this.credentialValues.size === this.values.size &&
      !this.shortValues.size &&
      this.unmatchedLength === this.credentialUnmatchedLength
    )
      return this.redact(value);
    if (!this.credentialView) {
      this.credentialView = new SentSecrets();
      for (const credential of this.credentialValues) this.credentialView.form(credential);
      if (this.credentialUnmatchedLength !== Infinity)
        this.credentialView.limited(this.credentialUnmatchedLength, false);
    }
    return this.credentialView.redact(value);
  }

  /** Structural fields must be refused, never repaired into different URLs. */
  contains(value: string, ignoreCase = false): boolean {
    if (value.length >= this.unmatchedLength) return true;
    const matches = findMatches(value, this.values, { remaining: MAX_SCAN_BYTES }, ignoreCase, false);
    return matches === undefined || matches.length > 0;
  }

  containsUrl(value: string): boolean {
    const { hosts, components, joined } = credentialUrlViews(value);
    return (
      hosts.some((host) => this.contains(host, true)) || [...components, ...joined].some((view) => this.contains(view))
    );
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
          this.secret(decoded.slice(colon + 1));
        }
      } catch {
        /* An invalid Basic value is still registered verbatim. */
      }
    } else this.secret(framed[1]!);
  }

  request(input: RequestInfo | URL, init?: RequestInit): void {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    for (const [name, value] of headers) {
      if (explicitSecretName.test(name)) this.secret(value);
      else if (name === "cookie" || sensitiveName.test(name)) this.header(value);
      if (name === "cookie") {
        for (const cookie of value.split(";")) {
          const equals = cookie.indexOf("=");
          if (equals !== -1) this.add(cookie.slice(equals + 1).trim());
        }
      }
    }
    const url = new URL(input instanceof Request ? input.url : String(input));
    for (const [name, value] of url.searchParams) {
      if (explicitSecretName.test(name)) this.secret(value);
      else if (sensitiveName.test(name)) this.add(value);
    }
    // The OAuth SDK sends token requests as form data. Do not read a body
    // stream or clone a Request: registration must not consume its payload.
    if (
      headers.get("content-type")?.startsWith("application/x-www-form-urlencoded") &&
      (typeof init?.body === "string" || init?.body instanceof URLSearchParams)
    ) {
      for (const [name, value] of new URLSearchParams(init.body)) {
        if (/^(?:client_secret|password)$/i.test(name)) this.secret(value);
        else if (/^(?:refresh_token|code|client_assertion)$/i.test(name)) this.add(value);
      }
    }
  }

  text(value: string): string {
    // Raw wire bytes are authoritative, including numeric/boolean/null
    // echoes that JSON parsing would otherwise turn into non-string leaves.
    let scanned = this.scanText(value, false);
    if (!this.privateArguments) return scanned;
    if (scanned === REDACTED && value !== REDACTED) scanned = this.structuredText(value) ?? REDACTED;
    if (!this.shortValues.size) return scanned;
    try {
      const parsed: unknown = JSON.parse(scanned);
      if (typeof parsed === "string" || (parsed !== null && typeof parsed === "object")) {
        // Structured parsing only adds exact-leaf protection for short
        // values; it never restores bytes refused by a literal scan.
        const redacted = typeof parsed === "string" ? this.leaf(parsed) : this.redact(parsed);
        return redacted === parsed ? scanned : JSON.stringify(redacted);
      }
    } catch {
      // Plain text and JSON scalars still require the prose scan.
    }
    return this.scanText(scanned, true);
  }

  /** After a whole-wire refusal, independently scan raw JSON tokens to retain
   * safe metadata. Refused tokens become quoted placeholders before parsing. */
  private structuredText(source: string): string | undefined {
    if (!/^\s*[[{]/.test(source) || source.length * 2 > MAX_SCAN_BYTES || source.length >= this.unmatchedLength)
      return undefined;
    // A literal spanning JSON tokens cannot be recovered by token scans.
    // Only quotes or a sequence of JSON scalar/framing characters can cross
    // those boundaries in valid JSON. Bound this additional check too.
    const boundaryForms = [...this.values].filter(
      (form) => form.includes('"') || /^[{}[\],:\s\d.+eEtruefalsn-]+$/.test(form),
    );
    const overlap = boundaryForms.reduce((longest, form) => Math.max(longest, form.length), 0);
    const budget = { remaining: MAX_SCAN_BYTES };
    let unsafe = false;
    const filtered = source.replace(/"(?:\\[\s\S]|[^"\\])*"|[^\s{}[\],:]+/g, (token, at: number) => {
      if (unsafe) return REDACTED;
      if (overlap)
        for (const boundary of [at, at + token.length]) {
          const start = Math.max(0, boundary - overlap);
          const window = source.slice(start, boundary + overlap);
          const matches = findMatches(window, boundaryForms, budget);
          if (!matches || matches.some((match) => match.start < boundary - start && match.end > boundary - start)) {
            unsafe = true;
            return REDACTED;
          }
        }
      const redacted = this.scanText(token, false);
      return redacted === REDACTED ? JSON.stringify(REDACTED) : redacted;
    });
    if (unsafe) return undefined;
    try {
      JSON.parse(filtered);
      return filtered;
    } catch {
      return undefined;
    }
  }

  private leaf(value: string): string {
    if (this.shortValues.size) {
      let decoded = value;
      for (let pass = 0; pass < 3; pass++) {
        if (this.shortValues.has(wireText(decoded))) return REDACTED;
        if (!decoded.includes("\\")) break;
        decoded = decoded.replace(jsonEscape, (escape) => {
          const code = escape.slice(1);
          return code.startsWith("u") ? String.fromCharCode(parseInt(code.slice(1), 16)) : shortEscape[code]!;
        });
      }
    }
    return this.scanText(value, false);
  }

  private scanText(value: string, prose: boolean): string {
    if (!this.values.size && !(prose && this.shortValues.size) && this.unmatchedLength === Infinity) return value;
    const limit = this.privateArguments ? MAX_SCAN_BYTES : MAX_CREDENTIAL_SCAN_BYTES;
    if (value.length >= this.unmatchedLength || value.length * 2 > limit) return REDACTED;
    const original = value;
    const budget = { remaining: limit };
    if (prose && this.shortValues.size) {
      const short = findMatches(value, this.shortValues, budget);
      if (short === undefined || short.length) return REDACTED;
    }
    const matches = findMatches(value, this.values, budget);
    if (!matches) return REDACTED;
    value = replaceMatches(value, matches);
    if (value.includes("\\")) {
      const escaped = this.escapedText(value, budget, prose);
      if (escaped === undefined) return REDACTED;
      value = escaped;
    }
    // Ordinary skill bytes, including example credential header names, stay
    // exact. Header-line scrubbing belongs to an actual credential echo.
    if (value === original) return value;
    return value.replace(
      /(^|[\r\n])([\t ]*(?:cookie|set-cookie|[a-z0-9-]*(?:key|token|secret|auth|signature|session)[a-z0-9-]*)\s*:\s*)[^\r\n]*/gi,
      `$1$2${REDACTED}`,
    );
  }

  /** Skill supporting files may contain arbitrary bytes, including credential echoes. */
  private blob(value: string): string {
    let binary: string;
    try {
      binary = atob(value);
    } catch {
      return this.text(value);
    }
    const forms = [...this.values].map((secret) =>
      Array.from(encoder.encode(secret), (byte) => String.fromCharCode(byte)).join(""),
    );
    const matches = findMatches(binary, forms.map(wireText), {
      remaining: this.privateArguments ? MAX_SCAN_BYTES : MAX_CREDENTIAL_SCAN_BYTES,
    });
    let redacted = matches ? this.text(replaceMatches(binary, matches)) : REDACTED;
    if (this.unicode) {
      // atob returns byte-valued code units. A UTF-8 view also detects mixed
      // literal/JSON-escaped Unicode echoes. Never re-encode that view: an
      // arbitrary supporting file may contain invalid UTF-8 or a leading BOM.
      const view = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(
        Uint8Array.from(redacted, (char) => char.charCodeAt(0)),
      );
      if (this.text(view) !== view) redacted = REDACTED;
    }
    const encoded = redacted === binary ? value : btoa(redacted);
    // A file's encoding can itself equal a credential. Withhold that file as
    // a valid encoded placeholder, never insert prose into its base64 field.
    if (this.text(encoded) === encoded) return encoded;
    const withheld = btoa(REDACTED);
    return this.text(withheld) === withheld ? withheld : "";
  }

  /** Decode bounded windows with source spans, including twice-escaped JSON.
   * Both overlap and cumulative matching work are capped independently of inputs. */
  private escapedText(source: string, budget: ScanBudget, prose: boolean): string | undefined {
    const step = 65_536;
    const forms = prose ? [...this.values, ...this.shortValues] : [...this.values];
    let longest = 0;
    for (const value of forms) {
      if (value.length > MAX_ESCAPED_FORM_LENGTH && value.length <= source.length) return undefined;
      longest = Math.max(longest, Math.min(value.length, MAX_ESCAPED_FORM_LENGTH));
    }
    // Each of two Unicode escape layers expands a code unit at most sixfold.
    const overlap = 36 * longest + 12;
    const output: string[] = [];
    let copied = 0;
    for (let offset = 0; offset < source.length;) {
      let view = source.slice(offset, offset + step + overlap);
      let starts: Uint32Array | undefined;
      let ends: Uint32Array | undefined;
      const matches: { start: number; end: number }[] = [];
      for (let pass = 0; pass < 2 && view.includes("\\"); pass++) {
        const parts: string[] = [];
        const nextStarts = new Uint32Array(view.length);
        const nextEnds = new Uint32Array(view.length);
        let cursor = 0;
        let length = 0;
        const copy = (end: number) => {
          if (cursor < end) parts.push(view.slice(cursor, end));
          for (; cursor < end; cursor++, length++) {
            nextStarts[length] = starts?.[cursor] ?? cursor;
            nextEnds[length] = ends?.[cursor] ?? cursor + 1;
          }
        };
        for (const match of view.matchAll(jsonEscape)) {
          copy(match.index);
          const code = match[0].slice(1);
          parts.push(code.startsWith("u") ? String.fromCharCode(parseInt(code.slice(1), 16)) : shortEscape[code]!);
          nextStarts[length] = starts?.[match.index] ?? match.index;
          cursor = match.index + match[0].length;
          nextEnds[length++] = ends?.[cursor - 1] ?? cursor;
        }
        if (cursor === 0) break;
        copy(view.length);
        view = parts.join("");
        starts = nextStarts.subarray(0, length);
        ends = nextEnds.subarray(0, length);
        const found = findMatches(view, forms, budget);
        if (!found) return undefined;
        for (const match of found) {
          if (prose && this.shortValues.has(wireText(view.slice(match.start, match.end)))) return REDACTED;
          const start = starts[match.start]!;
          if (start < step) matches.push({ start, end: ends[match.end - 1]! });
        }
      }
      matches.sort((a, b) => a.start - b.start || b.end - a.end);
      let rewritten = "";
      let cursor = 0;
      for (let i = 0; i < matches.length; i++) {
        const match = matches[i]!;
        let end = match.end;
        while (matches[i + 1] && matches[i + 1]!.start <= end) end = Math.max(end, matches[++i]!.end);
        rewritten += source.slice(offset + cursor, offset + match.start) + REDACTED;
        cursor = end;
      }
      if (cursor) {
        output.push(source.slice(copied, offset), rewritten);
        copied = offset + cursor;
      }
      let boundary = step;
      if (starts && ends) {
        // Keep the next window at an original escape boundary. Starting at
        // the second slash of a JSON pair changes its meaning and can leave
        // an invalid escape immediately before a redaction placeholder.
        let left = 0;
        let right = ends.length;
        while (left < right) {
          const middle = (left + right) >>> 1;
          if (ends[middle]! <= step) left = middle + 1;
          else right = middle;
        }
        if (left < starts.length) boundary = Math.min(step, starts[left]!);
      }
      offset += Math.max(boundary, cursor);
    }
    return output.length ? output.join("") + source.slice(copied) : source;
  }

  /** Copy, including non-enumerable Error fields; never retain a raw cause. */
  redact<T>(value: T, prose = typeof value === "string", framed = true): T {
    if (this.values.size === 0 && this.shortValues.size === 0 && this.unmatchedLength === Infinity) return value;
    const seen = new Map<object, object>();
    let changed = false;
    const text = (value: string, prose = false, credential = false): string => {
      const redacted = credential ? this.redactInput(value) : prose ? this.text(value) : this.leaf(value);
      changed ||= redacted !== value;
      return redacted;
    };
    const visit = (item: unknown, prose = false, framed = true): unknown => {
      if (typeof item === "string") return text(item, prose);
      if (item === null || typeof item !== "object") return item;
      const prior = seen.get(item);
      if (prior) return prior;
      const copy = Array.isArray(item)
        ? []
        : item instanceof Error
          ? (Object.create(Object.getPrototypeOf(item)) as object)
          : {};
      seen.set(item, copy);
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(item))) {
        // V8 lazily renders Error.stack through an own accessor. Snapshot it
        // before rebuilding an error, so its diagnostic is redacted too.
        if (key === "stack" && item instanceof Error && !("value" in descriptor)) {
          Object.defineProperty(copy, key, { value: visit(item.stack, true), configurable: true, writable: true });
          continue;
        }
        // JSON and errors carry data properties. A downstream-authored getter
        // is not a safe way to expose a diagnostic to an agent.
        if (!("value" in descriptor)) {
          changed = true;
          continue;
        }
        const framing = Array.isArray(item)
          ? "key"
          : framed || item instanceof Error
            ? protocolField(item, key)
            : undefined;
        const redactedKey = text(key, false, framing !== undefined);
        const blob = key === "blob" && "uri" in item && typeof descriptor.value === "string";
        const field =
          key === "content"
            ? this.joinedContent(descriptor.value)
            : blob
              ? this.blob(descriptor.value as string)
              : descriptor.value;
        changed ||= field !== descriptor.value;
        Object.defineProperty(copy, redactedKey, {
          ...descriptor,
          value: blob
            ? field
            : framing === "tag" && typeof field === "string"
              ? text(field, false, true)
              : visit(
                  field,
                  (prose && Array.isArray(item)) ||
                    (item instanceof Error && (key === "message" || key === "stack")) ||
                    (key === "text" && "type" in item && item.type === "text") ||
                    key === "logs",
                  framed &&
                    !["data", "result", "structuredContent"].includes(key) &&
                    !(key === "toolResult" && ("content" in item || "resultType" in item)),
                ),
          ...(redactedKey !== key ? { configurable: true } : {}),
        });
      }
      return item instanceof Error ? carryFailureFacts(item, copy) : copy;
    };
    const copy = visit(value, prose, framed) as T;
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
  if (!secrets) {
    secrets = new SentSecrets();
    contexts.set(ctx, secrets);
  }
  sentSecretsForRequest(ctx.requestScope ?? ctx).include(secrets);
  return secrets;
}

/** One identity per upstream request, including all discovery and call work. */
export function sentSecretsForRequest(scope: object, secrets?: SentSecrets): SentSecrets {
  let request = requests.get(scope);
  if (!request) {
    request = secrets ?? new SentSecrets();
    requests.set(scope, request);
  } else if (secrets) {
    request.include(secrets);
  }
  return request;
}

/** The agent-facing choke point. Apply to values before bridge serialization
 * and to serialized wire text, so JSON escapes and structured strings share
 * the same rule. Intake redaction protects caches independently of this edge. */
export function redactAgentOutput<T>(secrets: SentSecrets, value: T): T {
  return secrets.redact(value);
}

/** Wrap the complete operation table, including rejections. Adding an operation
 * cannot add an unredacted exit. A direct invocation owns a fresh scope unless
 * its HTTP request supplied one. */
export function agentOutputOperations<T extends Record<string, (...args: never[]) => Promise<unknown>>>(
  create: (scope: object) => T,
  requestScope?: object,
): T {
  return Object.fromEntries(
    Object.keys(create(requestScope ?? {})).map((name) => [
      name,
      async (...args: never[]) => {
        const scope = requestScope ?? {};
        const secrets = sentSecretsForRequest(scope);
        try {
          return redactAgentOutput(secrets, await create(scope)[name]!(...args));
        } catch (error) {
          throw redactAgentOutput(secrets, error);
        }
      },
    ]),
  ) as T;
}

/** Slot reads cover custom handlers too, including keys put in query strings. */
export function trackCredentialReads(ctx: ConnectorContext): void {
  if (!ctx.credential || wrappedCredentials.has(ctx)) return;
  wrappedCredentials.add(ctx);
  const credential = ctx.credential;
  ctx.credential = {
    async get(field) {
      const value = await credential.get(field);
      if (value) {
        const secrets = sentSecretsFor(ctx);
        if (field && explicitSecretName.test(field)) secrets.secret(value);
        else secrets.add(value);
      }
      return value;
    },
    async getAll() {
      const values = await credential.getAll();
      for (const [field, value] of Object.entries(values ?? {})) {
        if (explicitSecretName.test(field)) sentSecretsFor(ctx).secret(value);
        else sentSecretsFor(ctx).add(value);
      }
      return values;
    },
  };
}

export function redactSentSecrets<T>(ctx: ConnectorContext, value: T): T {
  return sentSecretsFor(ctx).redact(value);
}

/** Sanitize listing facts before any cache or consumer receives them. A name
 * cannot be rewritten without changing dispatch, and dropping one entry would
 * publish a partial catalog, so refuse the complete listing instead. */
export function redactCatalog<T extends { name: string }>(ctx: ConnectorContext, tools: T[]): T[] {
  sentSecretsFor(ctx);
  const redacted = sentSecretsForRequest(ctx.requestScope ?? ctx).redact(tools);
  if (redacted.some((tool, index) => tool.name !== tools[index]!.name)) {
    throw new ConnectorCallError(
      "connector_call_failed",
      "Downstream catalog contains a tool name that echoes a sent credential; refusing the complete catalog.",
      { retryable: false },
    );
  }
  return redacted;
}

/** Register only after the transport has assembled the request it sends. */
export function sentSecretsFetch(ctx: ConnectorContext, send: typeof fetch = fetch): typeof fetch {
  return (input, init) => {
    sentSecretsFor(ctx).request(input, init);
    return send(input, init);
  };
}
