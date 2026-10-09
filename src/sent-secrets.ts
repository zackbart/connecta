// Credentials and submitted private argument values used by one upstream request. Memory
// only; never part of a context's public shape, a failure record, storage, or a log. Web APIs only.
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
const headerLine =
  /(^|[\r\n])([\t ]*(?:cookie|set-cookie|[a-z0-9-]*(?:key|token|secret|auth|signature|session)[a-z0-9-]*)\s*:\s*)[^\r\n]*/gi;
// Short credentials can match protocol fields or legitimate configuration.
const MIN_SECRET_LENGTH = 8;
// Form kinds, weakest first. A short private value redacts exact structured leaves and
// withholds prose; longer private values and credentials are replaced wherever they occur.
const SHORT = 1;
const PRIVATE = 2;
const CREDENTIAL = 3;
// Submitted values register at most this many form code units and argument nodes. A form
// that does not fit withholds every string long enough to contain it.
const MAX_PRIVATE_FORM_CHARS = 524_288;
const MAX_ARGUMENT_NODES = 4_096;
const MAX_ARGUMENT_DEPTH = 32;
const MAX_WALK_DEPTH = 512;
// Work for one redaction call, across parsing, visited nodes, and every scanned view.
// Credential-only sets keep the multi-MiB document and skill-file reads they always allowed.
const PRIVATE_SCAN_WORK = 64 * 1_048_576;
const CREDENTIAL_SCAN_WORK = 1_024 * 1_048_576;
// Connecta and MCP framing: these names, tag values, and typed facts are copied unchanged,
// so a submitted value such as "text" or "true" cannot rewrite an envelope or its outcome.
const FRAMING_KEYS = new Set(
  (
    "content structuredContent isError _meta resultType dev.connecta/format type text data mimeType resource uri " +
    "blob annotations ok format valueFormat error code message stack name cause details retryable retryAfterMs " +
    "nextAction uncertainCall result logs failure inputRequests requestState method params mode requestedSchema url"
  ).split(" "),
);
const TAGS = new Set(
  (
    "type:text type:image type:audio type:resource type:resource_link format:json format:text format:paged " +
    "valueFormat:json valueFormat:text dev.connecta/format:json dev.connecta/format:text resultType:complete " +
    "resultType:input_required mode:form mode:url method:elicitation/create jsonrpc:2.0"
  ).split(" "),
);
const FACTS = new Set(["isError", "ok", "retryable", "retryAfterMs", "truncated", "hasMore"]);
// Downstream and guest prose: a short private value anywhere in it withholds the whole string.
const PROSE_KEYS = new Set(["message", "stack", "error", "logs", "text", "result"]);

/** Payload scans apply every private-value rule; envelope scans only replace literals. */
type Scan = { budget: { left: number }; payload: boolean };
type Found = { spans: number[]; short: boolean; exact: boolean };

/** Spend work that fits the call's remaining budget. Work that does not fit is refused
 * without spending, so its field is withheld while smaller fields can still be checked. */
function spend(scan: Scan, work: number): boolean {
  if (work > scan.budget.left) return false;
  scan.budget.left -= work;
  return true;
}

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

/** Percent escapes compare case-insensitively: hex letters within two units after `%` fold
 * to uppercase in forms and scanned text alike. A match can begin inside that pair, so a
 * form's first one or two letters may arrive folded as well. */
function wireForms(value: string): string[] {
  const fold = (text: string) => text.replace(/[a-f]/g, (letter) => letter.toUpperCase());
  const form = value.replace(/%[^%]?[^%]?/g, fold);
  return [...new Set([form, fold(form.slice(0, 1)) + form.slice(1), fold(form.slice(0, 2)) + form.slice(2)])];
}

function base64(value: string): string {
  let binary = "";
  for (const byte of encoder.encode(value)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Code units of a view, each with the source span it came from. */
interface Units {
  start: number;
  end: number;
  next(): number;
}

class Source implements Units {
  start = 0;
  end = 0;
  constructor(private readonly text: string) {}
  next(): number {
    if (this.end >= this.text.length) return -1;
    this.start = this.end++;
    return this.text.charCodeAt(this.start);
  }
}

const shortEscape: Record<number, number> = { 34: 34, 47: 47, 92: 92, 98: 8, 102: 12, 110: 10, 114: 13, 116: 9 };

/** One layer of JSON string escapes decoded; a second layer finds twice-escaped echoes. */
class Unescaped implements Units {
  start = 0;
  end = 0;
  private readonly ahead: [code: number, start: number, end: number][] = [];
  constructor(private readonly from: Units) {}
  private fill(count: number): boolean {
    while (this.ahead.length < count) {
      const code = this.from.next();
      if (code < 0) return false;
      this.ahead.push([code, this.from.start, this.from.end]);
    }
    return true;
  }
  private take(count: number, code: number): number {
    const taken = this.ahead.splice(0, count);
    this.start = taken[0]![1];
    this.end = taken[count - 1]![2];
    return code;
  }
  next(): number {
    if (!this.fill(1)) return -1;
    const code = this.ahead[0]![0];
    if (code === 0x5c && this.fill(2)) {
      const escaped = shortEscape[this.ahead[1]![0]];
      if (escaped !== undefined) return this.take(2, escaped);
      const digits = this.fill(6) ? String.fromCharCode(...this.ahead.slice(1, 6).map(([unit]) => unit)) : "";
      if (/^u[0-9a-f]{4}$/i.test(digits)) return this.take(6, parseInt(digits.slice(1), 16));
    }
    return this.take(1, code);
  }
}

/** Merge one view's spans as they arrive, ends ascending. A span wholly inside an emitted
 * placeholder is that placeholder; a private value containing its text spans more. */
function push(spans: number[], base: number, start: number, end: number, marks: number[] | undefined): void {
  if (marks) {
    let low = 0;
    let high = marks.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (marks[middle]! <= start) low = middle + 1;
      else high = middle;
    }
    if (low && end <= marks[low - 1]! + REDACTED.length) return;
  }
  while (spans.length > base && spans[spans.length - 1]! >= start) {
    start = Math.min(start, spans[spans.length - 2]!);
    spans.length -= 2;
  }
  spans.push(start, end);
}

function markers(text: string): number[] | undefined {
  let at = text.indexOf(REDACTED);
  if (at < 0) return undefined;
  const marks: number[] = [];
  for (; at >= 0; at = text.indexOf(REDACTED, at + REDACTED.length)) marks.push(at);
  return marks;
}

/** Replace each merged span once, from the original text: no replacement can split another
 * view's match. Header-line scrubbing belongs to an actual echo. */
function replace(text: string, spans: number[]): string {
  const order = Array.from({ length: spans.length / 2 }, (_, index) => index * 2).sort((a, b) => spans[a]! - spans[b]!);
  const parts: string[] = [];
  let cursor = 0;
  for (let index = 0; index < order.length;) {
    const start = spans[order[index]!]!;
    let end = spans[order[index]! + 1]!;
    while (++index < order.length && spans[order[index]!]! <= end) end = Math.max(end, spans[order[index]! + 1]!);
    parts.push(text.slice(cursor, start), REDACTED);
    cursor = end;
  }
  parts.push(text.slice(cursor));
  return parts.join("").replace(headerLine, `$1$2${REDACTED}`);
}

/** Aho-Corasick over registered forms: amortized constant work per scanned code unit, however
 * many forms are registered, reporting the longest form ending at each unit. */
class Matcher {
  private readonly edges = new Map<number, number>();
  private readonly depth = [0];
  private readonly kind = [0];
  private readonly fail: Int32Array;
  private readonly longest: Int32Array;
  private readonly short: Uint8Array;
  private readonly starts: Int32Array;

  constructor(forms: Iterable<readonly [string, number]>) {
    const parent = [0];
    const char = [0];
    let longestForm = 0;
    for (const [form, kind] of forms) {
      let state = 0;
      for (let index = 0; index < form.length; index++) {
        const key = state * 65_536 + form.charCodeAt(index);
        const next = this.edges.get(key) ?? this.depth.length;
        if (next === this.depth.length) {
          this.edges.set(key, next);
          parent.push(state);
          char.push(form.charCodeAt(index));
          this.depth.push(this.depth[state]! + 1);
          this.kind.push(0);
        }
        state = next;
      }
      this.kind[state] = Math.max(this.kind[state]!, kind);
      longestForm = Math.max(longestForm, form.length);
    }
    this.fail = new Int32Array(this.depth.length);
    this.longest = new Int32Array(this.depth.length);
    this.short = new Uint8Array(this.depth.length);
    // Breadth-first: a failure link and its outputs depend only on shallower states.
    const order = Array.from({ length: this.depth.length - 1 }, (_, index) => index + 1);
    for (const state of order.sort((a, b) => this.depth[a]! - this.depth[b]!)) {
      const fail = this.depth[state]! > 1 ? this.step(this.fail[parent[state]!]!, char[state]!) : 0;
      this.fail[state] = fail;
      this.longest[state] = this.kind[state]! >= PRIVATE ? this.depth[state]! : this.longest[fail]!;
      this.short[state] = this.kind[state] === SHORT ? 1 : this.short[fail]!;
    }
    this.starts = new Int32Array(1 << (32 - Math.clz32(longestForm)));
  }

  private step(state: number, code: number): number {
    for (;;) {
      const next = this.edges.get(state * 65_536 + code);
      if (next !== undefined) return next;
      if (!state) return 0;
      state = this.fail[state]!;
    }
  }

  /** Scan one view, mapping each match back to the source units it came from. */
  scan(units: Units, found: Found, marks?: number[]): void {
    let state = 0;
    let count = 0;
    let percent = 0;
    const base = found.spans.length;
    const mask = this.starts.length - 1;
    for (let code = units.next(); code >= 0; code = units.next()) {
      if (code === 0x25) percent = 2;
      else if (percent) {
        percent--;
        if (code >= 0x61 && code <= 0x66) code -= 0x20;
      }
      this.starts[count++ & mask] = units.start;
      state = this.step(state, code);
      const length = this.longest[state]!;
      if (length) push(found.spans, base, this.starts[(count - length) & mask]!, units.end, marks);
      if (this.short[state]) found.short = true;
    }
    if (this.kind[state] === SHORT && this.depth[state] === count) found.exact = true;
  }
}

export class SentSecrets {
  /** Normalized form to its strongest kind. */
  private readonly forms = new Map<string, number>();
  private readonly recipients = new Set<SentSecrets>();
  private privateChars = 0;
  /** The shortest form left unregistered; any string this long might contain it. */
  private unmatched = Infinity;
  private unicode = false;
  private views: { matcher?: Matcher; lower?: Matcher; credentials?: SentSecrets } = {};

  private store(form: string, kind: number): void {
    const prior = this.forms.get(form) ?? 0;
    if (prior >= kind) return;
    if (kind !== CREDENTIAL && !prior) {
      if (this.privateChars + form.length > MAX_PRIVATE_FORM_CHARS) return this.unregistered(form.length);
      this.privateChars += form.length;
    }
    this.forms.set(form, kind);
    this.unicode ||= /[\u0080-\uffff]/.test(form);
    this.views = {};
    for (const recipient of this.recipients) recipient.store(form, kind);
  }

  private unregistered(length: number): void {
    if (length >= this.unmatched) return;
    this.unmatched = length;
    this.views = {};
    for (const recipient of this.recipients) recipient.unregistered(length);
  }

  private register(value: string, kind: number): void {
    const forms = [value, new URLSearchParams({ value }).toString().slice(6)];
    try {
      forms.push(encodeURIComponent(value), encodeURI(value));
    } catch {
      // A lone surrogate has no URI form; its other forms remain.
    }
    const encoded = base64(value);
    forms.push(encoded, encoded.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));
    for (const form of forms) for (const variant of wireForms(form)) this.store(variant, kind);
  }

  /** The request receives existing and future secrets from every context. */
  include(source: SentSecrets): void {
    if (source === this) return;
    source.recipients.add(this);
    for (const [form, kind] of source.forms) this.store(form, kind);
    this.unregistered(source.unmatched);
  }

  add(value: string): void {
    if (value.length < MIN_SECRET_LENGTH) return;
    for (const form of [value, `Bearer ${value}`, `token ${value}`]) this.register(form, CREDENTIAL);
  }

  /** Explicit secrets use the same floor as every other credential. */
  secret(value: string): void {
    this.add(value);
  }

  /** Submitted writeOnly strings and numbers join this request's set, including property
   * names inside a private object. Empty strings, booleans, and null carry no text. */
  arguments(args: unknown, schema: JsonSchema | undefined): void {
    if (!schema) return;
    let nodes = 0;
    const submit = (value: string) => {
      if (!value) return;
      if (value.length > MAX_PRIVATE_FORM_CHARS) return this.unregistered(value.length);
      this.register(value, value.length < MIN_SECRET_LENGTH ? SHORT : PRIVATE);
    };
    const collect = (value: unknown, depth: number): void => {
      if (++nodes > MAX_ARGUMENT_NODES || depth > MAX_ARGUMENT_DEPTH) return this.unregistered(1);
      if (typeof value === "string") submit(value);
      else if (typeof value === "number" || typeof value === "bigint") submit(String(value));
      else if (value !== null && typeof value === "object")
        for (const key of Object.keys(value)) {
          if (nodes > MAX_ARGUMENT_NODES) return;
          if (!Array.isArray(value)) submit(key);
          collect((value as Record<string, unknown>)[key], depth + 1);
        }
    };
    visitPrivateCallArguments(args, schema, (value) => collect(value, 0));
  }

  /** Structural fields must be refused, never repaired into different URLs. */
  contains(value: string, ignoreCase = false): boolean {
    if (value.length >= this.unmatched) return true;
    if (!this.forms.size) return false;
    const found: Found = { spans: [], short: false, exact: false };
    const lower = () =>
      new Matcher(
        [...this.forms].flatMap(([form, kind]) => wireForms(form.toLowerCase()).map((low) => [low, kind] as const)),
      );
    if (ignoreCase) (this.views.lower ??= lower()).scan(new Source(value.toLowerCase()), found);
    else this.matcher().scan(new Source(value), found);
    return found.spans.length > 0;
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

  /** Serialized wire text about to be returned, stored, or paged, under payload rules. */
  text(value: string): string {
    return this.idle() ? value : this.wire(value, this.scan(true), 0);
  }

  /** Copy, including non-enumerable Error fields; never retain a raw cause. Payload rules
   * apply where downstream or guest data enters; envelopes repeat literal replacement. */
  redact<T>(value: T, mode: "payload" | "prose" | "envelope" = "payload"): T {
    if (this.idle()) return value;
    return this.walk(value, this.scan(mode !== "envelope"), mode === "prose" || typeof value === "string", 0) as T;
  }

  /** Credentials alone: later calls keep the private arguments they submit, and cached
   * catalogs never depend on one request's arguments. */
  redactCredentials<T>(value: T): T {
    return this.credentials().redact(value, "envelope");
  }

  private idle(): boolean {
    return !this.forms.size && this.unmatched === Infinity;
  }

  private scan(payload: boolean): Scan {
    const left = this.privateChars || this.unmatched < Infinity ? PRIVATE_SCAN_WORK : CREDENTIAL_SCAN_WORK;
    return { budget: { left }, payload };
  }

  private matcher(): Matcher {
    return (this.views.matcher ??= new Matcher(this.forms));
  }

  private credentials(): SentSecrets {
    if (!this.privateChars && this.unmatched === Infinity) return this;
    if (!this.views.credentials) {
      const view = new SentSecrets();
      for (const [form, kind] of this.forms) if (kind === CREDENTIAL) view.store(form, kind);
      this.views.credentials = view;
    }
    return this.views.credentials;
  }

  /** Every raw and JSON-unescaped match, mapped to source spans before any replacement.
   * Work beyond the call's budget returns undefined, which withholds the string. */
  private find(text: string, scan: Scan, escapes = true): Found | undefined {
    const layers = !escapes || !text.includes("\\") ? 0 : /\\\\|\\u005[cC]/.test(text) ? 2 : 1;
    if (!spend(scan, 2 * text.length * (layers + 1))) return undefined;
    const found: Found = { spans: [], short: false, exact: false };
    const marks = markers(text);
    for (let layer = 0; layer <= layers; layer++) {
      let units: Units = new Source(text);
      for (let depth = 0; depth < layer; depth++) units = new Unescaped(units);
      this.matcher().scan(units, found, marks);
    }
    return found;
  }

  /** A structured leaf, property name, or prose. A short private form withholds prose
   * wherever it occurs, and a leaf only when the whole leaf is that form. */
  private string(value: string, scan: Scan, prose: boolean): string {
    if (scan.payload && value.length >= this.unmatched) return REDACTED;
    const found = this.find(value, scan);
    if (!found || (scan.payload && (prose ? found.short : found.exact))) return REDACTED;
    return found.spans.length ? replace(value, found.spans) : value;
  }

  /** A number, boolean, or null matching by its canonical text becomes a placeholder string. */
  private scalar(value: number | bigint | boolean | null, scan: Scan): unknown {
    const text = String(value);
    if ((typeof value === "number" || typeof value === "bigint") && text.length >= this.unmatched) return REDACTED;
    const found = this.find(text, scan, false);
    return !found || found.exact || found.spans.length ? REDACTED : value;
  }

  /** A JSON object or array is parsed and walked once; its serialized bytes must then hold
   * no literal the walk cannot see, such as one spanning tokens. Other text is prose. */
  private wire(value: string, scan: Scan, depth: number): string {
    if (scan.payload && value.length >= this.unmatched) return REDACTED;
    if (/^\s*[[{]/.test(value) && spend(scan, value.length)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        // Not JSON: prose.
      }
      if (parsed !== null && typeof parsed === "object") {
        const walked = this.walk(parsed, scan, false, depth);
        const text = walked === parsed ? value : JSON.stringify(walked);
        const found = this.find(text, scan, false);
        return found && !found.spans.length && !(scan.payload && text.length >= this.unmatched) ? text : REDACTED;
      }
    }
    return this.string(value, scan, true);
  }

  private walk(value: unknown, scan: Scan, prose: boolean, depth: number): unknown {
    const seen = new Map<object, object>();
    let changed = false;
    const note = <V>(before: unknown, after: V): V => {
      changed ||= after !== before;
      return after;
    };
    const visit = (item: unknown, prose: boolean, depth: number): unknown => {
      if (typeof item === "string")
        return note(item, prose ? this.wire(item, scan, depth) : this.string(item, scan, false));
      if (item === null || typeof item === "number" || typeof item === "bigint" || typeof item === "boolean")
        return scan.payload ? note(item, this.scalar(item, scan)) : item;
      if (typeof item !== "object") return item;
      const prior = seen.get(item);
      if (prior) return prior;
      if (depth > MAX_WALK_DEPTH || !spend(scan, 1)) return note(item, REDACTED);
      if (Array.isArray(item)) {
        const copy: unknown[] = [];
        seen.set(item, copy);
        for (let index = 0; index < item.length; index++) copy[index] = visit(item[index], prose, depth + 1);
        return copy;
      }
      const copy = item instanceof Error ? (Object.create(Object.getPrototypeOf(item)) as object) : {};
      seen.set(item, copy);
      const typed = item instanceof Error || typeof (item as { retryable?: unknown }).retryable === "boolean";
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(item))) {
        // V8 lazily renders Error.stack through an own accessor. Snapshot it
        // before rebuilding an error, so its diagnostic is redacted too.
        if (key === "stack" && item instanceof Error && !("value" in descriptor)) {
          Object.defineProperty(copy, key, {
            value: visit(item.stack, true, depth + 1),
            configurable: true,
            writable: true,
          });
          continue;
        }
        // JSON and errors carry data properties. A downstream-authored getter
        // is not a safe way to expose a diagnostic to an agent.
        if (!("value" in descriptor)) {
          changed = true;
          continue;
        }
        const field: unknown = descriptor.value;
        const name = FRAMING_KEYS.has(key) ? key : note(key, this.string(key, scan, false));
        const redacted =
          (typeof field === "string" && TAGS.has(`${key}:${field}`)) ||
          (FACTS.has(key) && (typeof field === "boolean" || typeof field === "number"))
            ? field
            : typed && (key === "code" || key === "name") && typeof field === "string"
              ? note(field, this.credentials().string(field, { ...scan, payload: false }, false))
              : key === "blob" && "uri" in item && typeof field === "string"
                ? note(field, this.blob(field, scan))
                : visit(
                    key === "content" ? note(field, this.joinedContent(field, scan, depth)) : field,
                    PROSE_KEYS.has(key),
                    depth + 1,
                  );
        Object.defineProperty(copy, name, {
          ...descriptor,
          value: redacted,
          ...(name !== key ? { configurable: true } : {}),
        });
      }
      return item instanceof Error ? carryFailureFacts(item, copy) : copy;
    };
    const copy = visit(value, prose, depth);
    return changed ? copy : value;
  }

  /** Skill supporting files may contain arbitrary bytes, including echoes. */
  private blob(value: string, scan: Scan): string {
    let binary: string;
    try {
      binary = atob(value);
    } catch {
      return this.string(value, scan, false);
    }
    // Byte-valued code units match ASCII forms directly. Bytes are data, never prose.
    let redacted = this.string(binary, scan, false);
    if (this.unicode && redacted !== REDACTED) {
      // A UTF-8 view also detects non-ASCII and mixed escaped echoes. Never re-encode that
      // view: an arbitrary supporting file may contain invalid UTF-8 or a leading BOM.
      const view = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(
        Uint8Array.from(redacted, (char) => char.charCodeAt(0)),
      );
      if (this.string(view, scan, false) !== view) redacted = REDACTED;
    }
    const encoded = redacted === binary ? value : btoa(redacted);
    // A file's encoding can itself equal a secret. Withhold that file as
    // a valid encoded placeholder, never insert prose into its base64 field.
    if (this.string(encoded, scan, false) === encoded) return encoded;
    const withheld = btoa(REDACTED);
    return this.string(withheld, scan, false) === withheld ? withheld : "";
  }

  /** Match across blocks before isError/JSON unwrapping concatenates them. */
  private joinedContent(value: unknown, scan: Scan, depth: number): unknown {
    if (!Array.isArray(value)) return value;
    const blocks = value.filter((block) => block?.type === "text" && typeof block.text === "string");
    if (blocks.length < 2) return value;
    for (const separator of ["", "\n"]) {
      const joined = blocks.map((block) => block.text).join(separator);
      const redacted = this.wire(joined, scan, depth);
      if (redacted === blocks.map((block) => this.wire(block.text, scan, depth)).join(separator)) continue;
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
 * the same rule. Payloads were redacted where they entered; this boundary
 * repeats credential and literal private-value replacement around Connecta's
 * own envelopes, whose identifiers and counts are never private data. */
export function redactAgentOutput<T>(secrets: SentSecrets, value: T): T {
  return secrets.redact(value, "envelope");
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
  const redacted = sentSecretsForRequest(ctx.requestScope ?? ctx).redactCredentials(tools);
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
