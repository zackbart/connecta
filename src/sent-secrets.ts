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
// The matcher indexes each form's first FORM_PREFIX units, credentials first, up to
// MAX_MATCHER_UNITS for every registration together. A longer form is confirmed by a rolling
// hash once its prefix matches. A form left out withholds every string long enough to contain it.
// Forms sharing a prefix and a length share each check, and overlapping prefix occurrences in
// self-similar text share one run of checks. A scanned view holds at most MAX_PENDING_RUNS, and
// each check, which costs about as much as scanning two code units, is paid for from the call's
// work budget before it is queued; a view that needs more is withheld.
const FORM_PREFIX = 256;
const MAX_MATCHER_UNITS = 524_288;
const MAX_PENDING_RUNS = 16_384;
const CHECK_WORK = 4;
const HASH_BASE = 0x01_00_01_93;
const POWERS = new Int32Array(FORM_PREFIX + 1);
POWERS[0] = 1;
for (let length = 1; length <= FORM_PREFIX; length++) POWERS[length] = Math.imul(POWERS[length - 1]!, HASH_BASE);
// One redaction call visits at most this many structured entries, this deep. A string is
// decoded at most MAX_DECODE_LEVELS JSON layers, counting nested JSON strings it was parsed from.
const MAX_WALK_NODES = 1_048_576;
const MAX_WALK_DEPTH = 512;
const MAX_DECODE_LEVELS = 8;
// Work for one redaction call, across parsing and every scanned view. Credential-only sets
// keep the multi-MiB document and skill-file reads they always allowed.
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
type Scan = { budget: { work: number; nodes: number }; payload: boolean };
type Found = { spans: number[]; short: boolean; exact: boolean };

/** Spend work that fits the call's remaining budget. Work that does not fit is refused
 * without spending, so its field is withheld while smaller fields can still be checked. */
function spend(scan: Scan, work: number): boolean {
  if (work > scan.budget.work) return false;
  scan.budget.work -= work;
  return true;
}

/** A container in the walk, copied only once one of its entries changes. */
interface Frame {
  item: object;
  /** Own property names; an array walks its indices. */
  names: string[] | undefined;
  size: number;
  index: number;
  prose: boolean;
  depth: number;
  typed: boolean;
  /** The current entry: its name, output name, and original value. */
  key: string;
  name: string;
  field: unknown;
  copy?: object;
}

// Walk markers: a container was opened, or an entry is dropped from the copy.
const OPEN = Symbol("open");
const DROP = Symbol("drop");

/** Define one entry on a copy. An own accessor here is Error.stack, already snapshotted. */
function define(copy: object, item: object, key: string, name: string, value: unknown): void {
  const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
  Object.defineProperty(
    copy,
    name,
    "value" in descriptor
      ? { ...descriptor, value, ...(name !== key ? { configurable: true } : {}) }
      : { value, configurable: true, writable: true },
  );
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

/** A hex digit's value, or -1. */
function hex(code: number): number {
  const lower = code | 0x20;
  return code >= 0x30 && code <= 0x39 ? code - 0x30 : lower >= 0x61 && lower <= 0x66 ? lower - 0x57 : -1;
}

/** One layer of JSON string escapes decoded. It counts the escapes it decoded and the
 * backslashes it produced, which tell whether another layer could decode more. */
class Unescaped implements Units {
  start = 0;
  end = 0;
  decoded = 0;
  slashes = 0;
  private readonly codes = new Int32Array(8);
  private readonly starts = new Int32Array(8);
  private readonly ends = new Int32Array(8);
  private head = 0;
  private size = 0;
  constructor(private readonly from: Units) {}
  private fill(count: number): boolean {
    for (; this.size < count; this.size++) {
      const code = this.from.next();
      if (code < 0) return false;
      const at = (this.head + this.size) & 7;
      this.codes[at] = code;
      this.starts[at] = this.from.start;
      this.ends[at] = this.from.end;
    }
    return true;
  }
  private at(offset: number): number {
    return this.codes[(this.head + offset) & 7]!;
  }
  private take(count: number, code: number): number {
    this.start = this.starts[this.head]!;
    this.end = this.ends[(this.head + count - 1) & 7]!;
    this.head = (this.head + count) & 7;
    this.size -= count;
    if (count > 1) this.decoded++;
    if (code === 0x5c) this.slashes++;
    return code;
  }
  next(): number {
    if (!this.fill(1)) return -1;
    const code = this.at(0);
    if (code === 0x5c && this.fill(2)) {
      const escaped = shortEscape[this.at(1)];
      if (escaped !== undefined) return this.take(2, escaped);
      if (this.at(1) === 0x75 && this.fill(6)) {
        let unit = 0;
        for (let offset = 2; offset < 6 && unit >= 0; offset++) {
          const digit = hex(this.at(offset));
          unit = digit < 0 ? -1 : unit * 16 + digit;
        }
        if (unit >= 0) return this.take(6, unit);
      }
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

/** Forms longer than FORM_PREFIX that share a prefix and a length, so one hash confirms any. */
interface Group {
  length: number;
  /** HASH_BASE raised to the length. */
  power: number;
  hashes: Set<number>;
}

/** Pending checks of one group at prefix occurrences `step` units apart, `stride` source units
 * apart: a self-similar text extends one run instead of queueing a check per occurrence. The
 * head check is due at `due`, with the rolling hash before its occurrence and its source start. */
interface Run {
  group: Group;
  count: number;
  due: number;
  before: number;
  start: number;
  step: number;
  stride: number;
  /** The hash of the prefix's first `step` units, and HASH_BASE raised to `step`. */
  stepHash: number;
  stepPower: number;
  /** The unit count and source start of the latest occurrence. */
  last: number;
  lastStart: number;
}

/** A run of one occurrence, whose step is set by the next occurrence that extends it. */
const UNEXTENDED = { step: 0, stride: 0, stepHash: 0, stepPower: 0 };

/** Runs ordered by their head check's due count: a binary min-heap. */
class Runs {
  readonly items: Run[] = [];

  add(run: Run): void {
    let at = this.items.length;
    for (let parent = (at - 1) >> 1; at && this.items[parent]!.due > run.due; parent = (at - 1) >> 1) {
      this.items[at] = this.items[parent]!;
      at = parent;
    }
    this.items[at] = run;
  }

  /** Restore the order after the earliest run's head advanced, dropping it once empty. */
  settle(): void {
    // An empty run leaves, and the last run sifts down from the root in its place.
    const run = this.items[0]!.count ? this.items[0]! : this.items.pop()!;
    const size = this.items.length;
    if (!size) return;
    let at = 0;
    for (let child = 1; child < size; child = at * 2 + 1) {
      if (child + 1 < size && this.items[child + 1]!.due < this.items[child]!.due) child++;
      if (this.items[child]!.due >= run.due) break;
      this.items[at] = this.items[child]!;
      at = child;
    }
    this.items[at] = run;
  }
}

/** A polynomial hash of code units, modulo 2^32. Equal text always hashes equally, so a
 * collision can only redact more. */
function hash(text: string): number {
  let value = 0;
  for (let index = 0; index < text.length; index++) value = (Math.imul(value, HASH_BASE) + text.charCodeAt(index)) | 0;
  return value;
}

/** Aho-Corasick over registered forms: amortized constant work per scanned code unit, however
 * many forms are registered, reporting the longest form ending at each unit. Only a bounded
 * prefix of each form is indexed. A longer form is confirmed where its prefix matches by the
 * view's rolling hash once the form's last unit arrives, so no text is read twice; checks are
 * budgeted, and their queue is bounded. States live in typed arrays: the root's transitions in a
 * table, each state's first child inline, and only further branches in a map. */
class Matcher {
  /** The shortest form left unindexed; any string this long might contain it. */
  readonly unindexed: number = Infinity;
  private readonly root = new Int32Array(65_536);
  private readonly branches = new Map<number, number>();
  private readonly child: Int32Array;
  private readonly unit: Uint16Array;
  private readonly depth: Uint16Array;
  private readonly kind: Uint8Array;
  /** Forms longer than FORM_PREFIX, by the state their prefix reaches. */
  private readonly truncated = new Map<number, Group[]>();
  private readonly fail: Int32Array;
  private readonly longest: Uint16Array;
  private readonly short: Uint8Array;
  private readonly starts: Int32Array;
  private readonly hashes: Int32Array;

  constructor(forms: Iterable<readonly [string, number]>) {
    // Credentials are indexed first; sorting is stable, so registration order is otherwise kept.
    const indexed: (readonly [string, number])[] = [];
    let units = 0;
    for (const entry of [...forms].sort((a, b) => b[1] - a[1])) {
      const length = Math.min(entry[0].length, FORM_PREFIX);
      if (units + length > MAX_MATCHER_UNITS) this.unindexed = Math.min(this.unindexed, entry[0].length);
      else {
        units += length;
        indexed.push(entry);
      }
    }
    const size = units + 1;
    [this.child, this.fail] = [new Int32Array(size), new Int32Array(size)];
    [this.unit, this.depth, this.longest] = [new Uint16Array(size), new Uint16Array(size), new Uint16Array(size)];
    [this.kind, this.short] = [new Uint8Array(size), new Uint8Array(size)];
    const parent = new Int32Array(size);
    let states = 1;
    let longestForm = 0;
    for (const [form, kind] of indexed) {
      const length = Math.min(form.length, FORM_PREFIX);
      let state = 0;
      for (let index = 0; index < length; index++) {
        const code = form.charCodeAt(index);
        let next = this.next(state, code);
        if (!next) {
          next = states++;
          if (!state) this.root[code] = next;
          else if (!this.child[state]) this.child[state] = next;
          else this.branches.set(state * 65_536 + code, next);
          parent[next] = state;
          this.unit[next] = code;
          this.depth[next] = this.depth[state]! + 1;
        }
        state = next;
      }
      if (length === form.length) this.kind[state] = Math.max(this.kind[state]!, kind);
      else {
        const groups = this.truncated.get(state) ?? [];
        this.truncated.set(state, groups);
        const group = groups.find((group) => group.length === form.length);
        if (group) group.hashes.add(hash(form));
        else {
          let power = 1;
          for (let index = 0; index < form.length; index++) power = Math.imul(power, HASH_BASE);
          groups.push({ length: form.length, power, hashes: new Set([hash(form)]) });
        }
      }
      longestForm = Math.max(longestForm, length);
    }
    // Breadth-first, by a counting sort on depth: a failure link and its outputs depend only on
    // shallower states.
    const offsets = new Int32Array(FORM_PREFIX + 2);
    for (let state = 1; state < states; state++) offsets[this.depth[state]! + 1]!++;
    for (let depth = 1; depth < offsets.length; depth++) offsets[depth]! += offsets[depth - 1]!;
    const order = new Int32Array(states);
    for (let state = 1; state < states; state++) order[offsets[this.depth[state]!]!++] = state;
    for (let index = 0; index < states - 1; index++) {
      const state = order[index]!;
      const fail = this.depth[state]! > 1 ? this.step(this.fail[parent[state]!]!, this.unit[state]!) : 0;
      this.fail[state] = fail;
      this.longest[state] = this.kind[state]! >= PRIVATE ? this.depth[state]! : this.longest[fail]!;
      this.short[state] = this.kind[state] === SHORT ? 1 : this.short[fail]!;
    }
    this.starts = new Int32Array(1 << (32 - Math.clz32(longestForm)));
    this.hashes = new Int32Array(this.starts.length);
  }

  /** The child reached by one code unit, or 0. A first child is stored with its unit. */
  private next(state: number, code: number): number {
    if (!state) return this.root[code]!;
    const child = this.child[state]!;
    return child && this.unit[child] === code ? child : (this.branches.get(state * 65_536 + code) ?? 0);
  }

  private step(state: number, code: number): number {
    for (;;) {
      const next = this.next(state, code);
      if (next || !state) return next;
      state = this.fail[state]!;
    }
  }

  /** Scan one view, mapping each match back to the source units it came from. False when its
   * long-form checks exceed the remaining work or MAX_PENDING_RUNS, so the view is withheld. */
  scan(units: Units, found: Found, budget: { work: number }, marks?: number[]): boolean {
    let state = 0;
    let count = 0;
    let percent = 0;
    let rolling = 0;
    let runs: Runs | undefined;
    let tails: Map<Group, Run> | undefined;
    const base = found.spans.length;
    const mask = this.starts.length - 1;
    for (let code = units.next(); code >= 0; code = units.next()) {
      if (code === 0x25) percent = 2;
      else if (percent) {
        percent--;
        if (code >= 0x61 && code <= 0x66) code -= 0x20;
      }
      this.starts[count & mask] = units.start;
      this.hashes[count++ & mask] = rolling;
      rolling = (Math.imul(rolling, HASH_BASE) + code) | 0;
      state = this.step(state, code);
      const length = this.longest[state]!;
      if (length) push(found.spans, base, this.starts[(count - length) & mask]!, units.end, marks);
      if (this.short[state]) found.short = true;
      const groups = this.depth[state] === FORM_PREFIX ? this.truncated.get(state) : undefined;
      if (groups) {
        if (CHECK_WORK * groups.length > budget.work) return false;
        budget.work -= CHECK_WORK * groups.length;
        const before = this.hashes[(count - FORM_PREFIX) & mask]!;
        const start = this.starts[(count - FORM_PREFIX) & mask]!;
        runs ??= new Runs();
        tails ??= new Map();
        for (const group of groups) {
          const tail = tails.get(group);
          if (tail?.count && this.extend(tail, count, start)) continue;
          if (runs.items.length >= MAX_PENDING_RUNS) return false;
          const due = count - FORM_PREFIX + group.length;
          const run: Run = { group, count: 1, due, before, start, last: count, lastStart: start, ...UNEXTENDED };
          tails.set(group, run);
          runs.add(run);
        }
      }
      while (runs?.items.length && runs.items[0]!.due === count) {
        const run = runs.items[0]!;
        if (run.group.hashes.has((rolling - Math.imul(run.before, run.group.power)) | 0))
          push(found.spans, base, run.start, units.end, marks);
        run.count--;
        run.due += run.step;
        run.before = (Math.imul(run.before, run.stepPower) + run.stepHash) | 0;
        run.start += run.stride;
        runs.settle();
      }
    }
    if (this.kind[state] === SHORT && this.depth[state] === count) found.exact = true;
    return true;
  }

  /** Add an occurrence to a run when it continues the run's step and stride. The prefix has
   * period `step`, so the text between occurrences is the prefix's first `step` units. */
  private extend(run: Run, count: number, start: number): boolean {
    const step = count - run.last;
    const stride = start - run.lastStart;
    if (run.step ? step !== run.step || stride !== run.stride : step > FORM_PREFIX) return false;
    if (!run.step) {
      const mask = this.starts.length - 1;
      run.step = step;
      run.stride = stride;
      run.stepPower = POWERS[step]!;
      // The rolling hashes before both occurrences differ by the units between them.
      const previous = Math.imul(this.hashes[(run.last - FORM_PREFIX) & mask]!, run.stepPower);
      run.stepHash = (this.hashes[(count - FORM_PREFIX) & mask]! - previous) | 0;
    }
    run.count++;
    run.last = count;
    run.lastStart = start;
    return true;
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
    const matcher = ignoreCase ? (this.views.lower ??= lower()) : this.matcher();
    if (value.length >= matcher.unindexed) return true;
    const scanned = matcher.scan(new Source(ignoreCase ? value.toLowerCase() : value), found, { work: Infinity });
    return !scanned || found.spans.length > 0;
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
    return this.idle() ? value : this.wire(value, this.scan(true), 0, true, 0);
  }

  /** Copy only what changes, including non-enumerable Error fields; never retain a raw cause.
   * Payload rules apply where downstream or guest data enters; envelopes repeat literal
   * replacement. */
  redact<T>(value: T, mode: "payload" | "prose" | "envelope" = "payload"): T {
    if (this.idle()) return value;
    return this.walk(value, this.scan(mode !== "envelope"), mode === "prose" || typeof value === "string", 0, 0) as T;
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
    const work = this.privateChars || this.unmatched < Infinity ? PRIVATE_SCAN_WORK : CREDENTIAL_SCAN_WORK;
    return { budget: { work, nodes: MAX_WALK_NODES }, payload };
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

  /** Strings at least this long might hold a form that was never matched. */
  private floor(scan: Scan): number {
    return Math.min(scan.payload ? this.unmatched : Infinity, this.matcher().unindexed);
  }

  /** Every raw and JSON-unescaped match, mapped to source spans before any replacement. Text
   * decodes one more layer while the last one could still hold an escape, up to
   * MAX_DECODE_LEVELS counting the JSON strings it came from. Work beyond the call's budget
   * or that depth returns undefined, which withholds the string. */
  private find(text: string, scan: Scan, escapes: boolean, level: number): Found | undefined {
    const found: Found = { spans: [], short: false, exact: false };
    const marks = markers(text);
    for (let layer = 0, more = true; more; layer++) {
      if (level + layer > MAX_DECODE_LEVELS || !spend(scan, 2 * text.length * (layer + 1))) return undefined;
      let units: Units = new Source(text);
      for (let depth = 0; depth < layer; depth++) units = new Unescaped(units);
      if (!this.matcher().scan(units, found, scan.budget, marks)) return undefined;
      more = escapes && (units instanceof Unescaped ? units.decoded > 0 && units.slashes > 0 : text.includes("\\"));
    }
    return found;
  }

  /** A structured leaf, property name, or prose. A short private form withholds prose
   * wherever it occurs, and a leaf only when the whole leaf is that form. */
  private string(value: string, scan: Scan, prose: boolean, level = 0): string {
    if (value.length >= this.floor(scan)) return REDACTED;
    const found = this.find(value, scan, true, level);
    if (!found || (scan.payload && (prose ? found.short : found.exact))) return REDACTED;
    return found.spans.length ? replace(value, found.spans) : value;
  }

  /** A number, boolean, or null matching by its canonical text becomes a placeholder string. */
  private scalar(value: number | bigint | boolean | null, scan: Scan): unknown {
    const text = String(value);
    if ((typeof value === "number" || typeof value === "bigint") && text.length >= this.floor(scan)) return REDACTED;
    const found = this.find(text, scan, false, 0);
    return !found || found.exact || found.spans.length ? REDACTED : value;
  }

  /** JSON objects, arrays, and string literals are parsed and walked, nested JSON strings
   * included; their serialized bytes must then hold no literal the walk cannot see, such as
   * one spanning tokens. Other text is prose or a structured leaf. */
  private wire(value: string, scan: Scan, depth: number, prose: boolean, level: number): string {
    if (value.length >= this.floor(scan)) return REDACTED;
    if (level < MAX_DECODE_LEVELS && /^\s*["[{]/.test(value) && spend(scan, value.length)) {
      let parsed: { json: unknown } | undefined;
      try {
        parsed = { json: JSON.parse(value) };
      } catch {
        // Not JSON.
      }
      if (parsed) {
        const { json } = parsed;
        const walked = this.walk(json, scan, prose && typeof json === "string", depth, level + 1);
        const text = walked === json ? value : JSON.stringify(walked);
        const found = this.find(text, scan, false, level);
        return found && !found.spans.length && text.length < this.floor(scan) ? text : REDACTED;
      }
    }
    return this.string(value, scan, prose, level);
  }

  /** Iterative and copy-on-write: only containers on a changed path are copied. A container's
   * entries are counted against the node budget before it is walked; a cycle or a container
   * past MAX_WALK_DEPTH is withheld, and one past the node budget is checked as serialized text. */
  private walk(value: unknown, scan: Scan, prose: boolean, depth: number, level: number): unknown {
    const stack: Frame[] = [];
    const active = new Set<object>();
    const visit = (item: unknown, prose: boolean, depth: number): unknown => {
      if (typeof item === "string") return this.wire(item, scan, depth, prose, level);
      if (item === null || typeof item === "number" || typeof item === "bigint" || typeof item === "boolean")
        return scan.payload ? this.scalar(item, scan) : item;
      if (typeof item !== "object") return item;
      if (active.has(item) || depth > MAX_WALK_DEPTH) return REDACTED;
      const names = Array.isArray(item) ? undefined : Object.getOwnPropertyNames(item);
      const size = names ? names.length : (item as unknown[]).length;
      if (size > scan.budget.nodes) return this.serialized(item, scan, level);
      scan.budget.nodes -= size;
      if (!size) return item;
      active.add(item);
      const typed = item instanceof Error || typeof (item as { retryable?: unknown }).retryable === "boolean";
      stack.push({ item, names, size, index: 0, prose, depth, typed, key: "", name: "", field: undefined });
      return OPEN;
    };
    // Settle the top frame's next entry, drop it, or open its container.
    const enter = (frame: Frame): unknown => {
      const { item, names } = frame;
      if (!names) return visit((frame.field = (item as unknown[])[frame.index]), frame.prose, frame.depth + 1);
      const key = (frame.key = frame.name = names[frame.index]!);
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      let prose = PROSE_KEYS.has(key);
      if (descriptor && "value" in descriptor) frame.field = descriptor.value;
      // V8 lazily renders Error.stack through an own accessor. Snapshot it
      // before rebuilding an error, so its diagnostic is redacted too.
      else if (key === "stack" && item instanceof Error) {
        frame.field = item.stack;
        prose = true;
      }
      // JSON and errors carry data properties. A downstream-authored getter
      // is not a safe way to expose a diagnostic to an agent.
      else return DROP;
      const field = frame.field;
      if (!FRAMING_KEYS.has(key)) frame.name = this.string(key, scan, false);
      if (
        (typeof field === "string" && TAGS.has(`${key}:${field}`)) ||
        (FACTS.has(key) && (typeof field === "boolean" || typeof field === "number"))
      )
        return field;
      if (frame.typed && (key === "code" || key === "name") && typeof field === "string")
        return this.credentials().string(field, { ...scan, payload: false }, false);
      if (key === "blob" && "uri" in item && typeof field === "string") return this.blob(field, scan);
      const child = key === "content" ? this.joinedContent(field, scan, frame.depth, level) : field;
      return visit(child, prose, frame.depth + 1);
    };
    // Record a settled entry. The first change copies the container's earlier entries.
    const settle = (frame: Frame, value: unknown): void => {
      const { item, names, index } = frame;
      if (!frame.copy) {
        if (value === frame.field && frame.name === frame.key) return;
        if (!names) frame.copy = (item as unknown[]).slice(0, index);
        else {
          frame.copy = item instanceof Error ? (Object.create(Object.getPrototypeOf(item)) as object) : {};
          for (const key of names.slice(0, index))
            define(frame.copy, item, key, key, (item as Record<string, unknown>)[key]);
        }
      }
      if (!names) (frame.copy as unknown[])[index] = value;
      else if (value !== DROP) define(frame.copy, item, frame.key, frame.name, value);
    };
    let settled = visit(value, prose, depth);
    while (stack.length) {
      const frame = stack[stack.length - 1]!;
      if (settled === OPEN) settled = enter(frame);
      if (settled === OPEN) continue;
      settle(frame, settled);
      settled = OPEN;
      if (++frame.index < frame.size) continue;
      stack.pop();
      active.delete(frame.item);
      const { item, copy } = frame;
      settled = !copy ? item : item instanceof Error ? carryFailureFacts(item, copy) : copy;
    }
    return settled;
  }

  /** A container larger than the node budget is scanned as serialized text, Error fields
   * included: kept unchanged when nothing registered appears, otherwise withheld whole. */
  private serialized(item: object, scan: Scan, level: number): unknown {
    let text: string | undefined;
    try {
      text = JSON.stringify(item, (_key, value: unknown) =>
        value instanceof Error
          ? Object.fromEntries(Object.getOwnPropertyNames(value).map((name) => [name, Reflect.get(value, name)]))
          : value,
      );
    } catch {
      // A cycle or bigint cannot be serialized, so the container is withheld.
    }
    if (text === undefined || text.length >= this.floor(scan)) return REDACTED;
    const found = this.find(text, scan, true, level);
    return found && !found.spans.length && !(scan.payload && found.short) ? item : REDACTED;
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
  private joinedContent(value: unknown, scan: Scan, depth: number, level: number): unknown {
    if (!Array.isArray(value)) return value;
    const blocks = value.filter((block) => block?.type === "text" && typeof block.text === "string");
    if (blocks.length < 2) return value;
    for (const separator of ["", "\n"]) {
      const joined = blocks.map((block) => block.text).join(separator);
      const redacted = this.wire(joined, scan, depth, true, level);
      if (redacted === blocks.map((block) => this.wire(block.text, scan, depth, true, level)).join(separator)) continue;
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
