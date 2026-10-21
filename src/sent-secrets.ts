// Credentials and submitted private argument values used by one upstream request. Memory
// only; never part of a context's public shape, a failure record, storage, or a log. Web APIs only.
import { classificationCode, ConnectorCallError } from "./errors.js";
import { credentialUrlViews } from "./credential-url.js";
import { visitPrivateCallArguments } from "./argument-redaction.js";
import { redactedCopyOf } from "./redaction-identity.js";
import type { ConnectorContext, JsonSchema, Logger } from "./types.js";

const REDACTED = "[redacted]";
const encoder = new TextEncoder();
const contexts = new WeakMap<ConnectorContext, SentSecrets>();
const requests = new WeakMap<object, SentSecrets>();
const wrappedCredentials = new WeakSet<ConnectorContext>();
const sensitiveName = /key|token|secret|password|auth|signature|session/i;
const explicitSecretName = /secret|password/i;
const identifierName = /(?:id|user(?:name)?|login|email)$|^public/i;
// Continuation cursors are named tokens but are public result state, returned changed on the
// next page; matching their fragments would corrupt the cursor the agent pages with.
const continuationName = /^(?:next_?)?page_?token$|^(?:next|continuation|sync)_?token$/i;
const headerLine =
  /(^|[\r\n])([\t ]*(?:cookie|set-cookie|[a-z0-9-]*(?:key|token|secret|auth|signature|session)[a-z0-9-]*)\s*:\s*)[^\r\n]*/gi;
// Short credentials can match protocol fields or legitimate configuration.
const MIN_SECRET_LENGTH = 8;
// K: every contiguous run this long of a registered form is matched wherever it appears. It
// equals MIN_SECRET_LENGTH, so every registered credential and every private value of at least K
// units is fragment-indexed. Eight units keeps ordinary words, dates, counts and auth framing out
// of the index: a public run must repeat eight consecutive units of a secret's form to match.
const FRAGMENT_LENGTH = MIN_SECRET_LENGTH;
// A private value shorter than this is matched only as a whole field value: a leaf, key, number,
// boolean or decoded view equal to one of its forms. One to three units recur inside ordinary
// words, counts and ids, so a substring match would rewrite them everywhere.
const SUBSTRING_LENGTH = 4;
// Form kinds, weakest first, by the length of the value they came from. A tiny private value
// (1-3 units) is matched whole only. A short one (4-7) is also matched as a substring of payload
// text and decoded views. Longer private values and credentials are matched whole and by every
// K-unit run, wherever they occur.
const TINY = 1;
const SHORT = 2;
const PRIVATE = 3;
const CREDENTIAL = 4;
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
// Fragments are indexed by two independent polynomial hashes, at most MAX_FRAGMENTS distinct ones
// (8 bytes each, in a table at most half full); a larger set withholds every run of K units.
const SECOND_BASE = 0x5b_d1_e9_95;
const MAX_FRAGMENTS = 524_288;
// A unit's weight in a K-unit window, first and second position, under each base.
const [FIRST_TOP, FIRST_NEXT] = [POWERS[FRAGMENT_LENGTH - 1]!, POWERS[FRAGMENT_LENGTH - 2]!];
let [SECOND_TOP, SECOND_NEXT] = [1, 1];
for (let length = 1; length < FRAGMENT_LENGTH; length++) {
  SECOND_TOP = Math.imul(SECOND_TOP, SECOND_BASE);
  if (length < FRAGMENT_LENGTH - 1) SECOND_NEXT = Math.imul(SECOND_NEXT, SECOND_BASE);
}
// One redaction call visits at most this many structured entries, this deep. A string is
// decoded at most MAX_DECODE_LEVELS JSON layers, counting nested JSON strings it was parsed from.
const MAX_WALK_NODES = 1_048_576;
const MAX_WALK_DEPTH = 512;
const MAX_DECODE_LEVELS = 8;
// A decoded layer is scanned only around the escapes it decoded, this far past the widest form
// on each side: a match holding no newly decoded unit was already found a layer up. Wider forms
// scan the whole layer.
const MAX_WINDOW_UNITS = 4_096;
// Leaves too large to match joined within the work budget are matched alone; a run crossing
// two of them is matched this many units deep on each side of their seam.
const SEAM_UNITS = 512;
// Base64 or base64url text no declared field names is decoded and checked too: a whole leaf of
// at least ENCODED_FIELD_UNITS (four bytes), or a run inside one of at least ENCODED_RUN_UNITS
// (twelve bytes), up to MAX_ENCODED_LEVELS encodings deep.
const ENCODED_FIELD_UNITS = 6;
const ENCODED_RUN_UNITS = 16;
const MAX_ENCODED_LEVELS = 3;
// Checked encoded content this long is remembered for the request, so a later pass over the
// same bytes under the same set is not decoded and scanned again.
const MEMO_UNITS = 4_096;
// Work for one redaction call, across parsing and every scanned view. Credential-only sets
// keep the multi-MiB document and skill-file reads they always allowed.
const PRIVATE_SCAN_WORK = 64 * 1_048_576;
const CREDENTIAL_SCAN_WORK = 1_024 * 1_048_576;
// Connecta, MCP and JSON-RPC framing: these names and tag values are fixed words, copied
// unchanged, so a submitted value such as "text" or one holding the word "resource" cannot
// rename an envelope member or rewrite a content type. They carry no downstream-chosen content
// beyond the word itself. Any other key, and every other value, is checked like text.
const FRAMING_KEYS = new Set(
  (
    "content structuredContent isError _meta resultType dev.connecta/format type text data mimeType resource uri " +
    "blob annotations ok format valueFormat error code message stack name cause details retryable retryAfterMs " +
    "nextAction uncertainCall result logs failure inputRequests requestState method params mode requestedSchema url " +
    "jsonrpc id tools resources resourceTemplates uriTemplate contents prompts messages role arguments nextCursor " +
    "title description inputSchema outputSchema size"
  ).split(" "),
);
const TAGS = new Set(
  (
    "type:text type:image type:audio type:resource type:resource_link format:json format:text format:paged " +
    "valueFormat:json valueFormat:text dev.connecta/format:json dev.connecta/format:text resultType:complete " +
    "resultType:input_required mode:form mode:url method:elicitation/create jsonrpc:2.0"
  ).split(" "),
);
// Outcome flags: a boolean under these names is kept, since a boolean carries one bit whatever
// produced it. A number or string under them is matched like any other.
const FACTS = new Set(["isError", "ok", "retryable", "truncated", "hasMore"]);
// Leaves of a projection: text, a number's canonical text, or a container too large to walk,
// serialized. A number or container that changes is withheld whole.
const TEXT = 0;
const NUMBER = 1;
const SERIALIZED = 2;

/** Payload scans also match short private values; envelope scans leave Connecta's own
 * identifiers, counts and addresses to them. */
type Scan = { budget: { work: number; nodes: number }; payload: boolean };
type Found = { spans: number[] };
/** Source spans to replace. `deep` text still held escapes after MAX_DECODE_LEVELS layers. */
type Matches = { spans: number[]; deep: boolean };

/** An accessor met while looking up an inherited field: never invoked. */
const WITHHELD_ACCESSOR = Symbol("accessor");

/** Spend work that fits the call's remaining budget. Work that does not fit is refused
 * without spending, so its field is withheld while smaller fields can still be checked. */
function spend(scan: Scan, work: number): boolean {
  if (work > scan.budget.work) return false;
  scan.budget.work -= work;
  return true;
}

/** Base64 fields MCP and Connecta declare: resource blobs, image and audio data, content a
 * provider marks `format: "base64"`, and a REST body's `base64` beside its `contentType`. They
 * are checked as the bytes they carry. `field` reads the snapshot, never the original again. */
function binaryField(field: (name: string) => unknown, key: string): boolean {
  return (
    (key === "blob" && typeof field("uri") === "string") ||
    (key === "data" && (field("type") === "image" || field("type") === "audio")) ||
    (key === "content" && field("format") === "base64") ||
    (key === "base64" && typeof field("contentType") === "string")
  );
}

/** Error fields, non-enumerable ones included, for a container serialized as one leaf. */
function errorFields(_key: string, value: unknown): unknown {
  return value instanceof Error
    ? Object.fromEntries(Object.getOwnPropertyNames(value).map((name) => [name, Reflect.get(value, name)]))
    : value;
}

function parse(text: string): { json: unknown } | undefined {
  try {
    return { json: JSON.parse(text) };
  } catch {
    return undefined; // Prose rather than serialized JSON.
  }
}

/** A data property found on `item` or its prototypes, or undefined. An accessor on the way is
 * never invoked: it reads as `accessor`. */
function inherited(item: object, name: string, accessor: unknown): unknown {
  for (let at: object | null = item; at; at = Object.getPrototypeOf(at) as object | null) {
    const descriptor = Object.getOwnPropertyDescriptor(at, name);
    if (descriptor) return "value" in descriptor ? descriptor.value : accessor;
  }
  return undefined;
}

/** Bytes as a string of byte-valued code units, in bounded batches. */
function latin1(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
  return chunks.join("");
}

/** The UTF-8 text a string of byte-valued code units decodes to, invalid sequences replaced. */
function utf8(binary: string): string {
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(bytes);
}

/** Base64 or base64url text decoded to byte-valued code units, or undefined when it is not. */
function decodeBase64(text: string): string | undefined {
  let standard = text.includes("-") || text.includes("_") ? text.replace(/-/g, "+").replace(/_/g, "/") : text;
  // An unpadded encoding cut one unit past a whole quad still decodes up to that quad.
  let bare = standard.length;
  while (bare > 0 && standard.charCodeAt(bare - 1) === 0x3d) bare--;
  if (bare % 4 === 1) standard = standard.slice(0, bare - 1);
  try {
    return atob(standard);
  } catch {
    return undefined;
  }
}

const BASE64_UNIT = new Uint8Array(65_536);
for (const unit of "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/-_")
  BASE64_UNIT[unit.charCodeAt(0)] = 1;

/** Base64 or base64url runs worth decoding: the whole text when it is one, at least
 * ENCODED_FIELD_UNITS long with its padding, or each run inside it of ENCODED_RUN_UNITS. */
function encodedRuns(text: string): string[] {
  const runs: string[] = [];
  for (let at = 0; at < text.length;) {
    if (!BASE64_UNIT[text.charCodeAt(at)]) {
      at++;
      continue;
    }
    let end = at + 1;
    while (end < text.length && BASE64_UNIT[text.charCodeAt(end)]) end++;
    const run = end - at;
    let padded = end;
    while (padded < text.length && padded - end < 2 && text.charCodeAt(padded) === 0x3d) padded++;
    if (at === 0 && padded === text.length ? run >= ENCODED_FIELD_UNITS : run >= ENCODED_RUN_UNITS)
      runs.push(text.slice(at, end));
    at = padded;
  }
  return runs;
}

/** One layer of JSON string escapes decoded, with where each decoded escape lies: `at` in the
 * decoded text, `from` and `width` in the text it came from. Undefined when the layer decodes
 * nothing, so it equals its source. */
interface Layer {
  text: string;
  at: number[];
  from: number[];
  width: number[];
}

function unescapeLayer(text: string): Layer | undefined {
  const parts: string[] = [];
  const layer: Layer = { text: "", at: [], from: [], width: [] };
  let [cursor, length] = [0, 0];
  for (let index = text.indexOf("\\"); index >= 0 && index < text.length - 1; index = text.indexOf("\\", index)) {
    const code = text.charCodeAt(index + 1);
    let unit = shortEscape[code] ?? -1;
    let width = 2;
    if (unit < 0 && code === 0x75 && index + 6 <= text.length) {
      unit = 0;
      for (let offset = 2; offset < 6 && unit >= 0; offset++) {
        const digit = hex(text.charCodeAt(index + offset));
        unit = digit < 0 ? -1 : unit * 16 + digit;
      }
      width = 6;
    }
    if (unit < 0) {
      index++;
      continue;
    }
    parts.push(text.slice(cursor, index), String.fromCharCode(unit));
    length += index - cursor;
    layer.at.push(length++);
    layer.from.push(index);
    layer.width.push(width);
    cursor = index + width;
    index = cursor;
  }
  if (!layer.at.length) return undefined;
  parts.push(text.slice(cursor));
  layer.text = parts.join("");
  return layer;
}

/** The unit a decoded layer's unit came from in the text above it: the first unit of its
 * escape, or with `last` the escape's final unit. */
function above(layer: Layer, unit: number, last: boolean): number {
  const { at, from, width } = layer;
  let [low, high] = [0, at.length];
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (at[middle]! <= unit) low = middle + 1;
    else high = middle;
  }
  const escape = low - 1;
  if (escape < 0) return unit;
  if (at[escape] === unit) return last ? from[escape]! + width[escape]! - 1 : from[escape]!;
  return from[escape]! + width[escape]! + (unit - at[escape]! - 1);
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

/** A view that sets aside an incomplete JSON escape its text ends with, keeping source
 * offsets, and records where it began. Wrapped around every decoded layer, so an escape that
 * only a later layer reveals is set aside there too. Only the final six units can be one. */
class ClosedView implements Units {
  start = 0;
  end = 0;
  open = -1;
  private readonly pending: { code: number; start: number; end: number }[] = [];
  private ended = false;
  constructor(private readonly from: Units) {}
  next(): number {
    while (!this.ended && this.pending.length < 7) {
      const code = this.from.next();
      if (code < 0) {
        this.ended = true;
        const tail = String.fromCharCode(...this.pending.map((unit) => unit.code));
        const match = /\\(?:u[0-9a-fA-F]{0,3})?$/.exec(tail);
        if (match) {
          this.open = this.pending[match.index]!.start;
          this.pending.length = match.index;
        }
      } else this.pending.push({ code, start: this.from.start, end: this.from.end });
    }
    const unit = this.pending.shift();
    if (!unit) return -1;
    this.start = unit.start;
    this.end = unit.end;
    return unit.code;
  }
}

function hexLetter(code: number): boolean {
  const lower = code | 0x20;
  return lower >= 0x61 && lower <= 0x66;
}

/** Every K-unit run of every form of a value at least K long, as two independent 32-bit
 * polynomial hashes in an open-addressed table: a match needs both to agree, so a false one is
 * vanishingly rare and only ever redacts more. Index and scan are linear in the forms and the
 * scanned text, whatever the number of values. A form's leading auth framing (`Bearer `,
 * `token `) is public, so runs that start inside it are not indexed: a run holding K units of
 * the value is indexed from the value's own forms. A run may start inside a percent escape
 * whose `%` was cut away, or right after a `%` that is not the value's, so both cases of its
 * first two hex letters are indexed. */
class Fragments {
  complete = true;
  size = 0;
  private firsts = new Int32Array(1_024);
  private seconds = new Int32Array(1_024);
  private shift = 22;
  /** One bit per first hash's top 16 mixed bits: a clear bit rules a run out in one load, so
   * only a run that might match computes its second hash and probes the table. */
  private readonly filter = new Int32Array(2_048);

  constructor(forms: readonly (readonly [form: string, frame: number])[]) {
    for (const [form, frame] of forms) {
      let first = 0;
      let second = 0;
      for (let index = 0; index < form.length; index++) {
        const old = index >= FRAGMENT_LENGTH ? form.charCodeAt(index - FRAGMENT_LENGTH) : 0;
        const code = form.charCodeAt(index);
        first = (Math.imul(first - Math.imul(old, FIRST_TOP), HASH_BASE) + code) | 0;
        second = (Math.imul(second - Math.imul(old, SECOND_TOP), SECOND_BASE) + code) | 0;
        const at = index + 1 - FRAGMENT_LENGTH;
        if (at < frame) continue;
        const [lead, next] = [form.charCodeAt(at), form.charCodeAt(at + 1)];
        for (const a of hexLetter(lead) ? [0, (lead ^ 0x20) - lead] : [0])
          for (const b of hexLetter(next) ? [0, (next ^ 0x20) - next] : [0])
            this.insert(
              (first + Math.imul(a, FIRST_TOP) + Math.imul(b, FIRST_NEXT)) | 0,
              (second + Math.imul(a, SECOND_TOP) + Math.imul(b, SECOND_NEXT)) | 0,
            );
        // Past capacity, every run of K units is withheld instead.
        if (this.size > MAX_FRAGMENTS) {
          [this.complete, this.size, this.firsts, this.seconds] = [false, 0, new Int32Array(1), new Int32Array(1)];
          return;
        }
      }
    }
  }

  /** Add one fragment; repeated runs, as in a self-similar credential, are stored once. */
  private insert(first: number, second: number): void {
    const mixed = Math.imul(first, 0x9e_37_79_b1);
    this.filter[mixed >>> 21]! |= 1 << ((mixed >>> 16) & 31);
    const key = second || 1;
    const mask = this.firsts.length - 1;
    for (let slot = Math.imul(first, 0x9e_37_79_b1) >>> this.shift; ; slot = (slot + 1) & mask) {
      if (!this.seconds[slot]) {
        this.firsts[slot] = first;
        this.seconds[slot] = key;
        // At most half full, so a probe ends quickly; past capacity the index is abandoned.
        if (++this.size * 2 > this.firsts.length && this.size <= MAX_FRAGMENTS) this.grow();
        return;
      }
      if (this.firsts[slot] === first && this.seconds[slot] === key) return;
    }
  }

  private grow(): void {
    const [firsts, seconds] = [this.firsts, this.seconds];
    [this.firsts, this.seconds, this.shift, this.size] = [
      new Int32Array(firsts.length * 2),
      new Int32Array(firsts.length * 2),
      this.shift - 1,
      0,
    ];
    for (let slot = 0; slot < firsts.length; slot++) if (seconds[slot]) this.insert(firsts[slot]!, seconds[slot]!);
  }

  private has(first: number, second: number): boolean {
    const key = second || 1;
    const mask = this.firsts.length - 1;
    for (let slot = Math.imul(first, 0x9e_37_79_b1) >>> this.shift; this.seconds[slot]; slot = (slot + 1) & mask)
      if (this.firsts[slot] === first && this.seconds[slot] === key) return true;
    return false;
  }

  /** Scan text from `from` to `to`, percent hex folded as forms are, reporting each run's span. */
  scan(text: string, from: number, to: number, spans: number[], marks: number[] | undefined): void {
    if (!this.size) return;
    const codes = new Uint16Array(FRAGMENT_LENGTH);
    const { filter } = this;
    const base = spans.length;
    let [first, percent, slot] = [0, 0, 0];
    for (let at = from; at < to; at++) {
      let code = text.charCodeAt(at);
      if (code === 0x25) percent = 2;
      else if (percent) {
        percent--;
        if (code >= 0x61 && code <= 0x66) code -= 0x20;
      }
      first = (Math.imul(first - Math.imul(codes[slot]!, FIRST_TOP), HASH_BASE) + code) | 0;
      codes[slot] = code;
      slot = (slot + 1) & (FRAGMENT_LENGTH - 1);
      const mixed = Math.imul(first, 0x9e_37_79_b1);
      if ((filter[mixed >>> 21]! & (1 << ((mixed >>> 16) & 31))) === 0 || at + 1 - from < FRAGMENT_LENGTH) continue;
      // The window's units, oldest first, are the ring from the next slot round.
      let second = 0;
      for (let unit = 0; unit < FRAGMENT_LENGTH; unit++)
        second = (Math.imul(second, SECOND_BASE) + codes[(slot + unit) & (FRAGMENT_LENGTH - 1)]!) | 0;
      if (this.has(first, second)) push(spans, base, at + 1 - FRAGMENT_LENGTH, at + 1, marks);
    }
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

/** Spans from every view and scanner, ordered and merged. */
function merged(spans: number[]): number[] {
  const order = Array.from({ length: spans.length / 2 }, (_, index) => index * 2).sort((a, b) => spans[a]! - spans[b]!);
  const out: number[] = [];
  for (const at of order) {
    if (out.length && out[out.length - 1]! >= spans[at]!)
      out[out.length - 1] = Math.max(out[out.length - 1]!, spans[at + 1]!);
    else out.push(spans[at]!, spans[at + 1]!);
  }
  return out;
}

/** Replace each merged span once, from the original text: no replacement can split another
 * view's match. Header-line scrubbing belongs to an actual echo. */
function replace(text: string, spans: number[]): string {
  const ranges = merged(spans);
  const parts: string[] = [];
  let cursor = 0;
  for (let index = 0; index < ranges.length; index += 2) {
    parts.push(text.slice(cursor, ranges[index]), REDACTED);
    cursor = ranges[index + 1]!;
  }
  parts.push(text.slice(cursor));
  return parts.join("").replace(headerLine, `$1$2${REDACTED}`);
}

/** Spans of the joined pieces, replaced in each piece they touch: a match across pieces leaves
 * every other piece, and the structure around them, intact. */
function replaceParts(parts: string[], spans: number[]): string[] {
  if (!spans.length) return parts;
  const ranges = merged(spans);
  let offset = 0;
  let at = 0;
  return parts.map((part) => {
    const end = offset + part.length;
    while (at < ranges.length && ranges[at + 1]! <= offset) at += 2;
    const local: number[] = [];
    for (let index = at; part && index < ranges.length && ranges[index]! < end; index += 2)
      local.push(Math.max(0, ranges[index]! - offset), Math.min(part.length, ranges[index + 1]! - offset));
    offset = end;
    return local.length ? replace(part, local) : part;
  });
}

/** Spans of serialized JSON's leaf tokens, in order: each string's contents and each number. */
function jsonTokens(text: string): number[] {
  const tokens: number[] = [];
  for (let at = 0; at < text.length; at++) {
    const code = text.charCodeAt(at);
    if (code === 0x22) {
      const start = at + 1;
      for (at = start; at < text.length && text.charCodeAt(at) !== 0x22; at++) if (text.charCodeAt(at) === 0x5c) at++;
      tokens.push(start, at);
    } else if (code === 0x2d || (code >= 0x30 && code <= 0x39)) {
      const start = at;
      while (at + 1 < text.length && /[-+.0-9eE]/.test(text[at + 1]!)) at++;
      tokens.push(start, at + 1);
    }
  }
  return tokens;
}

/** Pieces this set cannot fully check: withhold each one at least `limit` long, and every run
 * of adjacent shorter pieces that together reach it. */
function withholdRuns(parts: string[], safe: string[], limit: number): string[] {
  const out = [...safe];
  let [start, length] = [0, 0];
  const close = (end: number) => {
    if (length >= limit) for (let index = start; index < end; index++) if (parts[index]) out[index] = REDACTED;
  };
  for (let index = 0; index < parts.length; index++) {
    if (parts[index]!.length < limit) {
      length += parts[index]!.length;
      continue;
    }
    close(index);
    out[index] = REDACTED;
    [start, length] = [index + 1, 0];
  }
  close(parts.length);
  return out;
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
  /** The longest indexed form, whole: a match is never wider. */
  readonly widest: number = 0;
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
  private readonly starts: Int32Array;
  private readonly hashes: Int32Array;

  /** Forms of at least `spanKind` report spans; weaker ones only steer the open-tail search. */
  constructor(forms: Iterable<readonly [string, number]>, spanKind = PRIVATE) {
    // Credentials are indexed first; sorting is stable, so registration order is otherwise kept.
    const indexed: (readonly [string, number])[] = [];
    let units = 0;
    for (const entry of [...forms].sort((a, b) => b[1] - a[1])) {
      const length = Math.min(entry[0].length, FORM_PREFIX);
      if (units + length > MAX_MATCHER_UNITS) this.unindexed = Math.min(this.unindexed, entry[0].length);
      else {
        units += length;
        indexed.push(entry);
        this.widest = Math.max(this.widest, entry[0].length);
      }
    }
    const size = units + 1;
    [this.child, this.fail] = [new Int32Array(size), new Int32Array(size)];
    [this.unit, this.depth, this.longest] = [new Uint16Array(size), new Uint16Array(size), new Uint16Array(size)];
    this.kind = new Uint8Array(size);
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
      this.longest[state] = this.kind[state]! >= spanKind ? this.depth[state]! : this.longest[fail]!;
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
  scan(text: string, from: number, to: number, found: Found, budget: { work: number }, marks?: number[]): boolean {
    let state = 0;
    let count = 0;
    let percent = 0;
    let rolling = 0;
    let runs: Runs | undefined;
    let tails: Map<Group, Run> | undefined;
    const base = found.spans.length;
    const mask = this.starts.length - 1;
    for (let at = from; at < to; at++) {
      let code = text.charCodeAt(at);
      if (code === 0x25) percent = 2;
      else if (percent) {
        percent--;
        if (code >= 0x61 && code <= 0x66) code -= 0x20;
      }
      this.starts[count & mask] = at;
      this.hashes[count++ & mask] = rolling;
      rolling = (Math.imul(rolling, HASH_BASE) + code) | 0;
      state = this.step(state, code);
      const length = this.longest[state]!;
      if (length) push(found.spans, base, this.starts[(count - length) & mask]!, at + 1, marks);
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
          push(found.spans, base, run.start, at + 1, marks);
        run.count--;
        run.due += run.step;
        run.before = (Math.imul(run.before, run.stepPower) + run.stepHash) | 0;
        run.start += run.stride;
        runs.settle();
      }
    }
    return true;
  }

  /** The source start of the earliest suffix of a view that a form begins with but the view
   * ends inside: any nonempty prefix of an indexed form, or a long form whose
   * indexed prefix matched and whose length runs past the view. -1 when there is none. */
  openAt(units: Units): number {
    let state = 0;
    let count = 0;
    let percent = 0;
    const mask = this.starts.length - 1;
    // Long-form occurrences, as source start and the count by which the form would end.
    const longs: number[] = [];
    for (let code = units.next(); code >= 0; code = units.next()) {
      if (code === 0x25) percent = 2;
      else if (percent) {
        percent--;
        if (code >= 0x61 && code <= 0x66) code -= 0x20;
      }
      this.starts[count++ & mask] = units.start;
      state = this.step(state, code);
      const groups = this.depth[state] === FORM_PREFIX ? this.truncated.get(state) : undefined;
      if (groups && longs.length < 2 * MAX_PENDING_RUNS) {
        const length = Math.max(...groups.map((group) => group.length));
        longs.push(this.starts[(count - FORM_PREFIX) & mask]!, count - FORM_PREFIX + length);
      }
    }
    const depth = this.depth[state]!;
    let open = depth > 0 ? this.starts[(count - depth) & mask]! : -1;
    for (let index = 0; index < longs.length; index += 2) {
      if (longs[index + 1]! > count || longs.length >= 2 * MAX_PENDING_RUNS) {
        open = open < 0 ? longs[index]! : Math.min(open, longs[index]!);
        break;
      }
    }
    return open;
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

/** A nested JSON string in a projection: the container and slot it is written back to, its
 * parsed value, the nested JSON holding it, whether its tokens hold a run no leaf holds, and
 * whether anything in it changed. */
interface Nested {
  frame: object;
  slot: PropertyKey;
  json: unknown;
  owner: number;
  crossing: boolean;
  dirty: boolean;
}

/** The name an error's own class gives it, read without invoking an accessor. */
function className(item: object): unknown {
  const constructor = inherited(item, "constructor", undefined);
  return typeof constructor === "function" ? Object.getOwnPropertyDescriptor(constructor, "name")?.value : undefined;
}

/** Spans of a decoded layer's units, in the source text. */
function toSource(layers: readonly Layer[], unit: number, last: boolean): number {
  for (let index = layers.length - 1; index >= 0; index--) unit = above(layers[index]!, unit, last);
  return unit;
}

/** The ranges of a decoded layer to scan: `reach` units on each side of every escape it decoded,
 * merged, or the whole layer when that is no larger. */
function windows(layer: Layer, reach: number): number[] {
  const length = layer.text.length;
  if (reach > MAX_WINDOW_UNITS) return [0, length];
  const ranges: number[] = [];
  let units = 0;
  for (const unit of layer.at) {
    const [start, end] = [Math.max(0, unit - reach + 1), Math.min(length, unit + reach)];
    if (ranges.length && ranges[ranges.length - 1]! >= start) {
      units += end - ranges[ranges.length - 1]!;
      ranges[ranges.length - 1] = end;
    } else {
      units += end - start;
      ranges.push(start, end);
    }
    if (units >= length) return [0, length];
  }
  return ranges;
}

export class SentSecrets {
  /** Normalized form to its strongest kind. */
  private readonly forms = new Map<string, number>();
  /** A form's leading units that encode only public auth framing; absent is none. */
  private readonly frames = new Map<string, number>();
  private readonly recipients = new Set<SentSecrets>();
  private readonly mintedStates = new Set<string>();
  /** Encoded content this set already found clean, and whether under payload rules, which
   * cover envelope ones. Cleared whenever the set changes. */
  private memo = new Map<string, boolean>();
  private privateChars = 0;
  /** The longest form; whether any comes from a value shorter than K; whether any is not ASCII. */
  private widestForm = 0;
  private smallForms = false;
  private unicodeForms = false;
  /** The shortest form left unregistered; any string this long might contain it. */
  private unmatched = Infinity;
  private views: {
    matcher?: Matcher;
    lower?: Matcher;
    short?: Matcher | null;
    whole?: Matcher | null;
    fragments?: Fragments;
    lowerFragments?: Fragments;
    credentials?: SentSecrets;
  } = {};

  private store(form: string, kind: number, frame = 0): void {
    const prior = this.forms.get(form) ?? 0;
    const priorFrame = prior ? (this.frames.get(form) ?? 0) : Infinity;
    const nextFrame = Math.min(frame, priorFrame);
    if (prior >= kind && nextFrame === priorFrame) return;
    if (kind !== CREDENTIAL && !prior) {
      if (this.privateChars + form.length > MAX_PRIVATE_FORM_CHARS) return this.unregistered(form.length);
      this.privateChars += form.length;
    }
    this.forms.set(form, Math.max(prior, kind));
    if (nextFrame) this.frames.set(form, nextFrame);
    else this.frames.delete(form);
    this.widestForm = Math.max(this.widestForm, form.length);
    this.smallForms ||= kind < PRIVATE;
    this.unicodeForms ||= /[\u0080-\uffff]/.test(form);
    this.views = {};
    this.memo = new Map();
    for (const recipient of this.recipients) recipient.store(form, kind, frame);
  }

  private unregistered(length: number): void {
    if (length >= this.unmatched) return;
    this.unmatched = length;
    this.views = {};
    this.memo = new Map();
    for (const recipient of this.recipients) recipient.unregistered(length);
  }

  /** Every form of `value`. Its first `frame` units are public auth framing, which no form's
   * fragment index starts in: a base64 form's framing ends at its last unit encoding only it. */
  private register(value: string, kind: number, frame = 0): void {
    const encodings = (text: string) => {
      const forms = [text, new URLSearchParams({ value: text }).toString().slice(6)];
      try {
        forms.push(encodeURIComponent(text), encodeURI(text));
      } catch {
        // A lone surrogate has no URI form; its other forms remain.
      }
      return forms;
    };
    const forms = encodings(value);
    const partial = frame > 0 && frame < Infinity;
    const framing = partial ? encodings(value.slice(0, frame)).map((form) => form.length) : [];
    const encoded = base64(value);
    const bytes = partial ? Math.floor((encoder.encode(value.slice(0, frame)).length * 4) / 3) : 0;
    for (const form of [encoded, encoded.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")]) {
      forms.push(form);
      framing.push(bytes);
    }
    forms.forEach((form, index) => {
      const framed = frame === Infinity ? frame : frame ? (framing[index] ?? 0) : 0;
      for (const variant of wireForms(form)) this.store(variant, kind, framed);
    });
  }

  /** The request receives existing and future secrets from every context. */
  include(source: SentSecrets): void {
    if (source === this) return;
    source.recipients.add(this);
    for (const [form, kind] of source.forms) this.store(form, kind, source.frames.get(form) ?? 0);
    this.unregistered(source.unmatched);
  }

  /** A credential, as sent and in the auth framings a vendor may echo it with. Its first
   * `frame` units, such as a header's `Basic `, are framing too. */
  add(value: string, frame = 0): void {
    if (value.length < MIN_SECRET_LENGTH) return;
    this.register(value, CREDENTIAL, frame);
    for (const framing of ["Bearer ", "token "]) this.register(framing + value, CREDENTIAL, framing.length + frame);
  }

  /** Explicit secrets use the same floor as every other credential. */
  secret(value: string): void {
    this.add(value);
  }

  /** An identifier sent beside a credential, such as a confidential client's ID or a Basic
   * username: matched whole only, since consent URLs and metadata carry its parts by design. */
  identifier(value: string): void {
    this.add(value, Infinity);
  }

  /** Submitted writeOnly strings and numbers join this request's set, including property
   * names inside a private object. Empty strings, booleans, and null carry no text. */
  arguments(args: unknown, schema: JsonSchema | undefined): void {
    if (!schema) return;
    let nodes = 0;
    const submit = (value: string) => {
      if (!value) return;
      if (value.length > MAX_PRIVATE_FORM_CHARS) return this.unregistered(value.length);
      this.register(value, value.length < SUBSTRING_LENGTH ? TINY : value.length < MIN_SECRET_LENGTH ? SHORT : PRIVATE);
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

  /** Structural fields must be refused, never repaired into different URLs. A field holding a
   * whole form or any K-unit run of one is refused. */
  contains(value: string, ignoreCase = false): boolean {
    if (value.length >= Math.min(this.unmatched, this.unmatched < Infinity ? FRAGMENT_LENGTH : Infinity)) return true;
    if (!this.forms.size) return false;
    const found: Found = { spans: [] };
    const lowered = () =>
      [...this.forms].flatMap(([form, kind]) =>
        wireForms(form.toLowerCase()).map((low) => [low, kind, this.frames.get(form) ?? 0] as const),
      );
    const matcher = ignoreCase
      ? (this.views.lower ??= new Matcher(lowered().map(([form, kind]) => [form, kind] as const)))
      : this.matcher();
    const fragments = ignoreCase
      ? (this.views.lowerFragments ??= new Fragments(
          lowered()
            .filter(([, kind]) => kind >= PRIVATE)
            .map(([form, , frame]) => [form, frame] as const),
        ))
      : this.fragments();
    if (value.length >= matcher.unindexed || (!fragments.complete && value.length >= FRAGMENT_LENGTH)) return true;
    const text = ignoreCase ? value.toLowerCase() : value;
    if (!matcher.scan(text, 0, text.length, found, { work: Infinity }) || found.spans.length) return true;
    fragments.scan(text, 0, text.length, found.spans, undefined);
    return found.spans.length > 0;
  }

  containsUrl(value: string): boolean {
    const { hosts, components, joined } = credentialUrlViews(value);
    return (
      hosts.some((host) => this.contains(host, true)) || [...components, ...joined].some((view) => this.contains(view))
    );
  }

  header(value: string): void {
    const framed = /^(?:Bearer|token|Basic)\s+(.+)$/i.exec(value);
    this.add(value, framed ? value.length - framed[1]!.length : 0);
    if (!framed) return;
    this.add(framed[1]!);
    if (/^Basic\s/i.test(value)) {
      try {
        const decoded = atob(framed[1]!.replace(/-/g, "+").replace(/_/g, "/"));
        const colon = decoded.indexOf(":");
        // Beside a password long enough to register, the username is an identifier, such as
        // a client ID; beside none or a placeholder, it is the credential itself.
        const paired = colon !== -1 && decoded.length - colon - 1 >= MIN_SECRET_LENGTH;
        this.add(decoded, paired ? colon + 1 : 0);
        if (colon !== -1) {
          if (paired) this.identifier(decoded.slice(0, colon));
          else this.add(decoded.slice(0, colon));
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
      else if (sensitiveName.test(name) && !continuationName.test(name)) this.add(value);
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
    return this.idle() ? value : (this.project(value, this.scan(true)).value as string);
  }

  /** A plain-data snapshot of `value` with every match removed: own enumerable data properties
   * (an error's own fields, non-enumerable ones included), read once each. Accessors are never
   * invoked, except an error's stack and the accessors its class defines, read once into the
   * copy. The original object is never returned, so nothing read later can differ from what was
   * checked. Payload rules apply where downstream or guest data enters; the envelope pass at the
   * agent boundary repeats every check except short private values, which would rewrite
   * Connecta's own identifiers, counts and addresses. */
  redact<T>(value: T, mode: "payload" | "envelope" = "payload"): T {
    if (this.idle()) return value;
    return this.project(value, this.scan(mode === "payload")).value as T;
  }

  /** Whether payload redaction would change anything in `value`, for fields that must be
   * refused rather than rewritten. */
  changes(value: unknown): boolean {
    return !this.idle() && this.project(value, this.scan(true)).changed;
  }

  /** Relay state and links Connecta minted and authenticates are framing, not payload: they
   * hold sealed downstream state or Connecta's own facts, never downstream text or arguments,
   * and a coincidental match must not corrupt them. Never admit downstream-authored state
   * here. Exact value membership survives JSON serialization within this request. */
  mintedState(value: string): string {
    this.mintedStates.add(value);
    return value;
  }

  /** Base64, or base64url with `url`, of bytes Connecta returns to an agent. No later pass
   * reads through an encoding the output does not declare, so the bytes are checked first: as
   * byte-valued units, as UTF-8 text, and through any base64 they carry, then the encoding
   * itself. Content holding a match encodes the placeholder instead. Downstream content takes
   * payload rules. `claims` is text Connecta assembled, such as a page cursor, from its own
   * counts and fingerprints and downstream values it already redacted under payload rules: it
   * takes the boundary's rules, so a count never meets a short private value, and is
   * remembered as clean for later passes over the same set. */
  encode(bytes: Uint8Array, { url = false, claims = false }: { url?: boolean; claims?: boolean } = {}): string {
    const binary = latin1(bytes);
    const finish = (text: string) => {
      const encoded = btoa(text);
      return url ? encoded.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : encoded;
    };
    if (this.idle()) return finish(binary);
    const scan = this.scan(!claims);
    const encoded = finish(binary);
    if (!this.bytesClean(binary, scan) || this.isolated(encoded, scan) !== encoded) return finish(REDACTED);
    if (claims || encoded.length >= MEMO_UNITS) this.memo.set(encoded, true);
    return encoded;
  }

  /** Text pieces a provider reads as one lane, such as rich-text runs with metadata between
   * them: matched joined, each match replaced in every piece it touches. A `bounded` lane is
   * one the vendor cut short, so it also loses an unfinished tail. */
  parts(parts: string[], bounded = false): string[] {
    if (this.idle()) return parts;
    const scan = this.scan(true);
    const text = parts.join("");
    const matches = this.spansOf(text, scan, true);
    if (!matches || matches.deep || (bounded && this.uncheckedTail())) return parts.map((part) => part && REDACTED);
    if (bounded) this.openSpans(text, matches.spans);
    let safe = replaceParts(parts, matches.spans);
    if (this.smallForms) safe = safe.map((next, index) => (this.whole(parts[index]!) ? REDACTED : next));
    const limit = this.limit(scan);
    return limit < Infinity ? withholdRuns(parts, safe, limit) : safe;
  }

  /** Complete and unfinished forms in bounded text, all found against its original bytes.
   * Replacing a complete match first could hide a longer open match containing it. Even a
   * one-unit shared prefix is withheld: a read boundary gives no evidence it is public text.
   * Each decoded layer sets aside a trailing escape the read cut short, which is withheld. */
  redactOpenTail(text: string): string {
    if (this.idle()) return text;
    const scan = this.scan(true);
    // A form too large to register or index could begin anywhere in what was read.
    if (this.uncheckedTail() || this.limit(scan) <= text.length || this.whole(text)) return REDACTED;
    const matches = this.spansOf(text, scan, true);
    if (!matches || matches.deep) return REDACTED;
    this.openSpans(text, matches.spans);
    return matches.spans.length ? replace(text, matches.spans) : text;
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

  /** Short private forms, matched as substrings of payload text. */
  private shortMatcher(): Matcher | null {
    if (this.views.short === undefined) {
      const forms = [...this.forms].filter(([, kind]) => kind === SHORT);
      this.views.short = forms.length ? new Matcher(forms, SHORT) : null;
    }
    return this.views.short;
  }

  /** Forms with no indexed fragment, such as identifiers, matched whole. */
  private wholeMatcher(): Matcher | null {
    if (this.views.whole === undefined) {
      const forms = [...this.forms].filter(
        ([form, kind]) => kind >= PRIVATE && (this.frames.get(form) ?? 0) > form.length - FRAGMENT_LENGTH,
      );
      this.views.whole = forms.length ? new Matcher(forms) : null;
    }
    return this.views.whole;
  }

  private fragments(): Fragments {
    return (this.views.fragments ??= new Fragments(
      [...this.forms].filter(([, kind]) => kind >= PRIVATE).map(([form]) => [form, this.frames.get(form) ?? 0]),
    ));
  }

  private credentials(): SentSecrets {
    if (!this.privateChars && this.unmatched === Infinity) return this;
    if (!this.views.credentials) {
      const view = new SentSecrets();
      for (const [form, kind] of this.forms)
        if (kind === CREDENTIAL) view.store(form, kind, this.frames.get(form) ?? 0);
      this.views.credentials = view;
    }
    return this.views.credentials;
  }

  /** The shortest text that might hold something this set cannot check, which is withheld: a
   * K-unit run of a value too large to register (or a whole short one), or of a form past the
   * fragment index's capacity. Envelope scans rely on the payload scans for unregistered values. */
  private limit(scan: Scan): number {
    let limit = this.fragments().complete ? Infinity : FRAGMENT_LENGTH;
    if (scan.payload && this.unmatched < Infinity) limit = Math.min(limit, this.unmatched, FRAGMENT_LENGTH);
    if (scan.payload) limit = Math.min(limit, this.shortMatcher()?.unindexed ?? Infinity);
    return limit;
  }

  /** Whether an open tail could begin a form this set never registered or indexed. */
  private uncheckedTail(): boolean {
    return this.unmatched < Infinity || this.matcher().unindexed < Infinity;
  }

  /** A form whole: a leaf, key, number, boolean or decoded view equal to one, as it stands or
   * under JSON escapes. This is how a tiny private value is matched. */
  private whole(text: string): boolean {
    let view: string | undefined = text;
    for (let layer = 0; view !== undefined && layer <= MAX_DECODE_LEVELS; layer++) {
      if (view.length <= this.widestForm && this.forms.has(view.includes("%") ? wireForms(view)[0]! : view))
        return true;
      // An escape is at most six units for one, so a longer text cannot decode to a form.
      view = view.length <= 6 * this.widestForm && view.includes("\\") ? unescapeLayer(view)?.text : undefined;
    }
    return false;
  }

  /** Every K-unit run of a registered form, every identifier form, and in payload text every
   * short private form, in the raw text and each JSON-unescaped layer, mapped to source spans
   * before any replacement. A layer decodes while the one above holds an escape; each is scanned
   * only around the escapes it decoded, since any other match was found a layer up. Work beyond
   * the call's budget returns undefined, which withholds the text. */
  private spansOf(text: string, scan: Scan, short: boolean): Matches | undefined {
    const spans: number[] = [];
    const fragments = this.fragments();
    const matchers = [this.wholeMatcher(), short ? this.shortMatcher() : null].filter(
      (matcher): matcher is Matcher => matcher !== null,
    );
    const scanners = Number(fragments.size > 0) + matchers.length;
    if (!scanners) return { spans, deep: false };
    const marks = markers(text);
    if (!spend(scan, 2 * text.length * scanners)) return undefined;
    fragments.scan(text, 0, text.length, spans, marks);
    for (const matcher of matchers)
      if (!matcher.scan(text, 0, text.length, { spans }, scan.budget, marks)) return undefined;
    const reach = Math.max(FRAGMENT_LENGTH, ...matchers.map((matcher) => matcher.widest));
    const layers: Layer[] = [];
    for (let upper = text; upper.includes("\\");) {
      // Decoding a layer copies text past its escapes, far cheaper per unit than scanning it.
      if (!spend(scan, Math.ceil(upper.length / 8))) return undefined;
      const layer = unescapeLayer(upper);
      if (!layer) break;
      if (layers.length === MAX_DECODE_LEVELS) return { spans, deep: true };
      layers.push(layer);
      const ranges = windows(layer, reach);
      let units = 0;
      for (let at = 0; at < ranges.length; at += 2) units += ranges[at + 1]! - ranges[at]!;
      if (!spend(scan, 2 * units * scanners)) return undefined;
      const local: number[] = [];
      for (let at = 0; at < ranges.length; at += 2) {
        const [start, end] = [ranges[at]!, ranges[at + 1]!];
        fragments.scan(layer.text, start, end, local, undefined);
        for (const matcher of matchers)
          if (!matcher.scan(layer.text, start, end, { spans: local }, scan.budget)) return undefined;
      }
      const ordered = merged(local);
      const base = spans.length;
      for (let at = 0; at < ordered.length; at += 2)
        push(
          spans,
          base,
          toSource(layers, ordered[at]!, false),
          toSource(layers, ordered[at + 1]! - 1, true) + 1,
          marks,
        );
      upper = layer.text;
    }
    // Auth framing is never indexed, but an echo carrying it goes whole, as a header line does.
    for (let at = 0; at < spans.length; at += 2) {
      const framing = /(?:Bearer|token)(?: |\+|%20)$/.exec(text.slice(Math.max(0, spans[at]! - 9), spans[at]));
      if (framing) spans[at]! -= framing[0].length;
    }
    return { spans, deep: false };
  }

  /** Add the span of an unfinished form the text ends inside, at any decoded layer. */
  private openSpans(text: string, spans: number[]): void {
    let open = -1;
    for (let layer = 0, more = true; more; layer++) {
      if (layer > MAX_DECODE_LEVELS) {
        spans.push(0, text.length);
        return;
      }
      let units: Units = new Source(text);
      const closed: ClosedView[] = [];
      let decoded: Unescaped | undefined;
      for (let depth = 0; depth <= layer; depth++) {
        const view = new ClosedView(units);
        closed.push(view);
        units = depth < layer ? (decoded = new Unescaped(view)) : view;
      }
      const at = this.matcher().openAt(units);
      for (const start of [at, ...closed.map((view) => view.open)])
        if (start >= 0) open = open < 0 ? start : Math.min(open, start);
      more = layer === 0 ? text.includes("\\") : decoded!.decoded > 0 && decoded!.slashes > 0;
    }
    if (open >= 0) spans.push(open, text.length);
  }

  /** One string checked alone: an object key or a decoded view. In payload scans a tiny
   * private value withholds it when it is the whole string, and a short one is replaced
   * wherever it occurs. */
  private isolated(text: string, scan: Scan): string {
    if (text.length >= this.limit(scan) || (scan.payload && this.smallForms && this.whole(text))) return REDACTED;
    const matches = this.spansOf(text, scan, scan.payload);
    if (!matches || matches.deep) return REDACTED;
    return matches.spans.length ? replace(text, matches.spans) : text;
  }

  /** A declared binary field is decoded and checked as bytes, as UTF-8 and as the base64 text
   * the agent receives, so an echo at any byte alignment is found. A match withholds the whole
   * field as the encoded marker, never partially scrubbed bytes. A field that is not base64 is
   * checked as text. Content found clean, here or as it was encoded, is not checked again. */
  private binary(value: string, scan: Scan): string {
    if (this.memo.get(value) === true || (!scan.payload && this.memo.has(value))) return value;
    const bytes = decodeBase64(value);
    if (bytes === undefined) return this.isolated(value, scan);
    if (this.bytesClean(bytes, scan) && this.isolated(value, scan) === value) {
      if (value.length >= MEMO_UNITS) this.memo.set(value, scan.payload);
      return value;
    }
    const withheld = btoa(REDACTED);
    return this.isolated(withheld, scan) === withheld ? withheld : "";
  }

  /** Whether bytes, as byte-valued units, hold no match: nor their UTF-8 text when a form is not
   * ASCII, nor any base64 they carry, MAX_ENCODED_LEVELS deep. */
  private bytesClean(binary: string, scan: Scan, level = 1): boolean {
    if (this.isolated(binary, scan) !== binary) return false;
    if (this.unicodeForms && /[\x80-\xff]/.test(binary)) {
      const text = utf8(binary);
      if (this.isolated(text, scan) !== text) return false;
    }
    if (level < MAX_ENCODED_LEVELS)
      for (const run of encodedRuns(binary)) {
        const inner = decodeBase64(run);
        if (inner !== undefined && !this.bytesClean(inner, scan, level + 1)) return false;
      }
    return true;
  }

  /** Text leaves carrying base64 or base64url, the whole leaf or a long run inside it, whose
   * decoded bytes or their UTF-8 text hold a match are withheld whole: no later pass reads
   * through an encoding the output does not declare. Every leaf's decoded views are matched
   * together, as one lane between unmatched separators. */
  private encodedLeaves(parts: string[], kinds: number[], safe: string[], scan: Scan): void {
    const views: string[] = [];
    const owners: number[] = [];
    const add = (binary: string, owner: number, level: number) => {
      views.push(binary);
      owners.push(owner);
      if (this.unicodeForms && /[\x80-\xff]/.test(binary)) {
        views.push(utf8(binary));
        owners.push(owner);
      }
      if (level < MAX_ENCODED_LEVELS)
        for (const run of encodedRuns(binary)) {
          const inner = decodeBase64(run);
          if (inner) add(inner, owner, level + 1);
        }
    };
    for (let index = 0; index < parts.length; index++) {
      // The leaf as text matching left it: a run it replaced in place, such as a registered base64
      // form, leaves no decodable remnant of K units; a match only decoding reveals withholds all.
      const text = safe[index]!;
      if (kinds[index] !== TEXT || text === REDACTED || this.memo.get(text) === true) continue;
      if (!scan.payload && this.memo.has(text)) continue;
      for (const run of encodedRuns(text)) {
        const bytes = decodeBase64(run);
        if (bytes) add(bytes, index, 1);
      }
    }
    if (!views.length) return;
    const withhold = (at: number) => (safe[owners[at]!] = REDACTED);
    if (scan.payload && this.smallForms) views.forEach((view, at) => this.whole(view) && withhold(at));
    const lane = views.join("￿");
    const matches = this.spansOf(lane, scan, scan.payload);
    if (!matches) return views.forEach((_, at) => withhold(at));
    if (matches.deep) views.forEach((view, at) => view.includes("\\") && withhold(at));
    const starts: number[] = [];
    for (let at = 0, offset = 0; at < views.length; offset += views[at++]!.length + 1) starts.push(offset);
    const ranges = merged(matches.spans);
    for (let at = 0; at < ranges.length; at += 2) {
      let [low, high] = [0, starts.length];
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (starts[middle]! <= ranges[at]!) low = middle + 1;
        else high = middle;
      }
      for (let view = Math.max(0, low - 1); view < starts.length && starts[view]! < ranges[at + 1]!; view++)
        withhold(view);
    }
  }

  /** The leaves' joined text, matched once, with each leaf's replacement. A tiny or short
   * private value equal to a whole leaf withholds it. A number or a serialized container that
   * a match touches is withheld whole. */
  private safeParts(parts: string[], kinds: number[], scan: Scan): string[] {
    if (!parts.length) return parts;
    const matches = this.spansOf(parts.join(""), scan, scan.payload);
    let safe = matches ? replaceParts(parts, matches.spans) : this.leafByLeaf(parts, scan);
    if (matches?.deep) safe = safe.map((next, index) => (parts[index]!.includes("\\") ? REDACTED : next));
    if (scan.payload && this.smallForms)
      safe = safe.map((next, index) => (kinds[index] !== SERIALIZED && this.whole(parts[index]!) ? REDACTED : next));
    const limit = this.limit(scan);
    if (limit < Infinity) safe = withholdRuns(parts, safe, limit);
    return safe.map((next, index) => (next !== parts[index] && kinds[index] !== TEXT ? REDACTED : next));
  }

  /** Leaves too large to match joined within the work budget: each is matched alone, in order,
   * and one that does not fit is withheld without spending what a smaller one needs. A run
   * crossing from one kept leaf into the next, through any short leaves between them, is then
   * matched SEAM_UNITS deep on each side of the seam. */
  private leafByLeaf(parts: string[], scan: Scan): string[] {
    const spans = parts.map((part) => {
      const matches = this.spansOf(part, scan, scan.payload);
      return !matches || (matches.deep && part.includes("\\")) ? undefined : matches.spans;
    });
    let pieces: { index: number; start: number; text: string }[] = [];
    const seam = () => {
      const text = pieces.map((piece) => piece.text).join("");
      const matches = pieces.length > 1 ? this.spansOf(text, scan, scan.payload) : { spans: [], deep: false };
      const ranges = matches ? merged(matches.spans) : [];
      let offset = 0;
      for (const piece of pieces) {
        const end = offset + piece.text.length;
        if (!matches || matches.deep) spans[piece.index] = undefined;
        for (let at = 0; at < ranges.length; at += 2)
          if (ranges[at]! < end && ranges[at + 1]! > offset)
            spans[piece.index]?.push(
              piece.start + Math.max(0, ranges[at]! - offset),
              piece.start + Math.min(piece.text.length, ranges[at + 1]! - offset),
            );
        offset = end;
      }
      pieces = [];
    };
    parts.forEach((part, index) => {
      if (!spans[index]) return seam();
      if (part.length <= 2 * SEAM_UNITS) return void pieces.push({ index, start: 0, text: part });
      pieces.push({ index, start: 0, text: part.slice(0, SEAM_UNITS) });
      seam();
      pieces.push({ index, start: part.length - SEAM_UNITS, text: part.slice(-SEAM_UNITS) });
    });
    seam();
    return parts.map((part, index) => {
      const own = spans[index];
      return !own ? part && REDACTED : own.length ? replace(part, own) : part;
    });
  }

  /** Serialized JSON whose keys, syntax and leaves together hold a K-unit run of a form: one
   * spanning tokens, which no leaf holds alone, withholds the whole text. A run inside one
   * string or number is a leaf's, already matched in the projection. */
  private spansTokens(text: string, scan: Scan): boolean {
    if (!this.fragments().size) return false;
    if (!spend(scan, 2 * text.length)) return true;
    const spans: number[] = [];
    this.fragments().scan(text, 0, text.length, spans, undefined);
    if (!spans.length) return false;
    const tokens = jsonTokens(text);
    const ranges = merged(spans);
    for (let at = 0; at < ranges.length; at += 2) {
      let [low, high] = [0, tokens.length / 2];
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (tokens[middle * 2 + 1]! <= ranges[at]!) low = middle + 1;
        else high = middle;
      }
      if (low * 2 >= tokens.length || tokens[low * 2]! > ranges[at]! || tokens[low * 2 + 1]! < ranges[at + 1]!)
        return true;
    }
    return false;
  }

  /** The output boundary. One walk reads every field once, from its descriptor, and projects
   * every string and number leaf in serialization order, nested JSON strings parsed and errors'
   * own fields included; the joined projection is matched once, so a form split across adjacent
   * leaves is found, and only the affected piece of each leaf is written back. Keys and declared
   * binary fields are checked alone, and text leaves carrying base64 are also checked through
   * it. Fixed framing words and tags, outcome booleans, and on a Connecta error its own code and
   * class name are kept: nothing downstream chooses them. Every other field is matched,
   * whatever its name.
   *
   * What returns is what was checked. A caller's container is returned as it stands only while
   * every field is a data property this walk read (an error's engine-rendered stack aside) and
   * nothing in it changed: a later read returns the same values. Any other container is a copy:
   * one holding an accessor, which is never invoked and is left out; one with a toJSON, which is
   * called once, as serialization would, and replaced by its checked result; one whose key was
   * renamed; and every container a change reaches, copied on its first write, so no caller's
   * value is ever mutated. Copies keep the identity facts registered in redaction-identity. */
  private project(value: unknown, scan: Scan): { value: unknown; changed: boolean } {
    type Holder = Record<PropertyKey, unknown>;
    /** Where values are written: `target` itself when this walk made it, or for a caller's
     * container (`shared`) a copy made on its first write and put in place of it in `parent`. */
    interface Frame {
      target: object;
      shared: boolean;
      parent: Frame | undefined;
      slot: PropertyKey;
      copy?: object;
      /** An error's class accessors, read once, for its copy. */
      accessors?: [string, unknown][];
    }
    const parts: string[] = [];
    const kinds: number[] = [];
    const frames: Frame[] = [];
    const slots: PropertyKey[] = [];
    const owners: number[] = [];
    // Structural changes found while walking: a withheld or checked field, a copied container.
    const replaced: [frame: Frame, slot: PropertyKey, value: unknown][] = [];
    const nested: Nested[] = [];
    const active = new Set<object>();
    // Keys and binary fields repeat across rows; each is checked once per call.
    const checked = [new Map<string, string>(), new Map<string, string>()] as const;
    let changed = false;
    const touch = (owner: number) => {
      changed = true;
      if (owner >= 0) nested[owner]!.dirty = true;
    };
    const check = (kind: 0 | 1, text: string): string => {
      let result = checked[kind].get(text);
      if (result === undefined) {
        result = kind === 0 ? this.isolated(text, scan) : this.binary(text, scan);
        checked[kind].set(text, result);
      }
      return result;
    };
    const replace = (frame: Frame, slot: PropertyKey, next: unknown, owner: number) => {
      replaced.push([frame, slot, next]);
      touch(owner);
    };
    const leaf = (text: string, kind: number, frame: Frame, slot: PropertyKey, owner: number) => {
      parts.push(text);
      kinds.push(kind);
      frames.push(frame);
      slots.push(slot);
      owners.push(owner);
    };
    /** A field put on a copy: an error's keeps its attributes, and `__proto__` stays a field. */
    const put = (holder: object, slot: PropertyKey, next: unknown, enumerable = true) => {
      if (holder instanceof Error || slot === "__proto__" || !enumerable)
        Object.defineProperty(holder, slot, {
          value: next,
          writable: true,
          configurable: true,
          enumerable: Object.getOwnPropertyDescriptor(holder, slot)?.enumerable ?? enumerable,
        });
      else (holder as Holder)[slot] = next;
    };
    /** A caller's container copied from its descriptors, never invoking an accessor. */
    const shallow = (frame: Frame): object => {
      const item = frame.target;
      if (Array.isArray(item)) {
        const length = (item as unknown[]).length;
        // Holes stay holes.
        const out: unknown[] = [];
        out.length = length;
        for (let index = 0; index < length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(item, index);
          if (descriptor) out[index] = "value" in descriptor ? descriptor.value : REDACTED;
        }
        return out;
      }
      const out = Object.create(Object.getPrototypeOf(item) as object | null) as Holder;
      for (const name of Object.getOwnPropertyNames(item)) {
        const descriptor = Object.getOwnPropertyDescriptor(item, name)!;
        if ("value" in descriptor) Object.defineProperty(out, name, { ...descriptor, configurable: true });
        else if (item instanceof Error && name === "stack")
          Object.defineProperty(out, name, { value: item.stack, writable: true, configurable: true });
      }
      for (const [name, read] of frame.accessors ?? []) put(out, name, read, false);
      return redactedCopyOf(item, out);
    };
    const writable = (frame: Frame): Holder => {
      if (!frame.shared) return frame.target as Holder;
      if (!frame.copy) {
        frame.copy = shallow(frame);
        put(writable(frame.parent!), frame.slot, frame.copy);
      }
      return frame.copy as Holder;
    };
    const visit = (
      item: unknown,
      frame: Frame,
      slot: PropertyKey,
      depth: number,
      level: number,
      owner: number,
      owned: boolean,
    ): unknown => {
      if (typeof item === "string") {
        if (this.mintedStates.has(item)) return item;
        if (level < MAX_DECODE_LEVELS && /^\s*["[{]/.test(item) && spend(scan, item.length)) {
          const parsed = parse(item);
          if (parsed) {
            const entry: Nested = { frame, slot, json: undefined, owner, crossing: false, dirty: false };
            entry.crossing = this.spansTokens(item, scan);
            const index = nested.push(entry) - 1;
            // Parsed JSON is this walk's own, so it is written in place.
            const holder: Frame = { target: entry, shared: false, parent: undefined, slot: "json" };
            entry.json = visit(parsed.json, holder, "json", depth + 1, level + 1, index, true);
            return item;
          }
        }
        leaf(item, TEXT, frame, slot, owner);
        return item;
      }
      if (typeof item === "number" || typeof item === "bigint") {
        leaf(String(item), NUMBER, frame, slot, owner);
        return item;
      }
      if (typeof item === "boolean" || item === null)
        return scan.payload && this.smallForms && this.whole(String(item)) ? REDACTED : item;
      if (typeof item !== "object") return item;
      if (active.has(item) || depth > MAX_WALK_DEPTH) return REDACTED;
      active.add(item);
      try {
        return container(item, frame, slot, depth, level, owner, owned);
      } catch {
        return REDACTED; // A proxy trap or a toJSON that threw.
      } finally {
        active.delete(item);
      }
    };
    /** A child that changed: written into parsed JSON this walk owns, or recorded as a change
     * to a caller's container. */
    const settle = (frame: Frame, slot: PropertyKey, next: unknown, owner: number) => {
      if (frame.shared) return replace(frame, slot, next, owner);
      (frame.target as Holder)[slot] = next;
      touch(owner);
    };
    /** Entries that fit the node budget are walked; a larger container is checked as one
     * serialized leaf, and one that cannot be serialized is withheld. */
    const fits = (size: number, item: object, frame: Frame, slot: PropertyKey, owner: number) => {
      if (size <= scan.budget.nodes) {
        scan.budget.nodes -= size;
        return true;
      }
      let text: string | undefined;
      try {
        text = JSON.stringify(item, errorFields);
      } catch {
        // A cycle or bigint cannot be serialized.
      }
      if (text === undefined) return REDACTED;
      leaf(text, SERIALIZED, frame, slot, owner);
      return item;
    };
    const container = (
      item: object,
      frame: Frame,
      slot: PropertyKey,
      depth: number,
      level: number,
      owner: number,
      owned: boolean,
    ): unknown => {
      if (Array.isArray(item)) {
        const length = (item as unknown[]).length;
        const plan = fits(length, item, frame, slot, owner);
        if (plan !== true) return plan;
        const own: Frame = owned
          ? { target: item, shared: false, parent: frame, slot }
          : { target: item, shared: true, parent: frame, slot };
        for (let index = 0; index < length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(item, index);
          if (!descriptor) continue; // A hole stays one.
          if (!("value" in descriptor)) {
            replace(own, index, REDACTED, owner);
            continue;
          }
          const next = visit(descriptor.value, own, index, depth + 1, level, owner, owned);
          if (next !== descriptor.value) settle(own, index, next, owner);
        }
        return item;
      }
      const error = item instanceof Error;
      if (!error && !owned) {
        // What serialization would read: a toJSON result, checked in place of the object.
        const toJSON = inherited(item, "toJSON", WITHHELD_ACCESSOR);
        if (toJSON === WITHHELD_ACCESSOR) return REDACTED;
        if (typeof toJSON === "function")
          return visit(toJSON.call(item, String(slot)), frame, slot, depth + 1, level, owner, false);
      }
      const names = Object.getOwnPropertyNames(item);
      const plan = fits(names.length, item, frame, slot, owner);
      if (plan !== true) return plan;
      // Every field is read once, and every decision below reads what was read.
      const keys: string[] = [];
      const values: unknown[] = [];
      const visible: boolean[] = [];
      let plain = true;
      for (const name of names) {
        const descriptor = Object.getOwnPropertyDescriptor(item, name);
        if (!descriptor) continue;
        // V8 renders Error.stack through an own accessor: snapshot it. Any other own accessor
        // is never invoked, and its container is copied without it.
        if ("value" in descriptor) values.push(descriptor.value);
        else if (error && name === "stack") values.push((item as Error).stack);
        else {
          plain = false;
          continue;
        }
        keys.push(name);
        visible.push(descriptor.enumerable === true);
      }
      let accessors: [string, unknown][] | undefined;
      if (error)
        // Accessors an error's class defines, such as DOMException's name and message, are read
        // once and checked; a copy holds them as fields, since their getters cannot read it.
        for (let at = Object.getPrototypeOf(item) as object | null; at && at !== Error.prototype;) {
          for (const name of Object.getOwnPropertyNames(at)) {
            if (!Object.getOwnPropertyDescriptor(at, name)?.get || keys.includes(name)) continue;
            try {
              (accessors ??= []).push([name, Reflect.get(item, name)]);
            } catch {
              // A getter that throws leaves its field out of any copy.
            }
          }
          at = Object.getPrototypeOf(at) as object | null;
        }
      const renamed = keys.map((key) => (FRAMING_KEYS.has(key) ? key : check(0, key)));
      if (renamed.some((name, index) => name !== keys[index])) plain = false;
      // A container walked as it stands: a caller's, copied on first write, or parsed JSON this
      // walk owns, written in place. Any other is copied now, field by field.
      const own: Frame = !plain
        ? {
            target: Object.create(Object.getPrototypeOf(item) as object | null) as object,
            shared: false,
            parent: frame,
            slot,
          }
        : { target: item, shared: !owned, parent: frame, slot, ...(accessors && !owned ? { accessors } : {}) };
      const fresh = own.target !== item;
      const out = own.target as Holder;
      const kind = error ? className(item) : undefined;
      const field = (name: string) => values[keys.indexOf(name)];
      const count = keys.length + (accessors?.length ?? 0);
      for (let index = 0; index < count; index++) {
        const extra = index >= keys.length ? accessors![index - keys.length]! : undefined;
        const key = extra ? extra[0] : keys[index]!;
        const value = extra ? extra[1] : values[index];
        const name = extra ? key : renamed[index]!;
        // Two keys renamed alike keep the first; the second's leaves write nowhere.
        const target: Frame =
          fresh && Object.hasOwn(out, name) ? { target: {}, shared: false, parent: undefined, slot: name } : own;
        let next: unknown;
        if (
          (typeof value === "string" && TAGS.has(`${key}:${value}`)) ||
          (typeof value === "boolean" && FACTS.has(key)) ||
          (error &&
            typeof value === "string" &&
            ((key === "code" && classificationCode(value) !== undefined) || (key === "name" && value === kind)))
        )
          next = value;
        else if (typeof value === "string" && binaryField(field, key)) next = check(1, value);
        else next = visit(value, target, name, depth + 1, level, owner, owned);
        if (target !== own) continue;
        if (fresh) put(out, name, next, extra ? false : visible[index]);
        else if (next !== value) settle(own, name, next, owner);
      }
      if (!fresh) return item;
      touch(owner);
      return redactedCopyOf(item, out);
    };
    const root: Frame = { target: { value: undefined }, shared: false, parent: undefined, slot: "value" };
    (root.target as Holder)["value"] = visit(value, root, "value", 0, 0, -1, false);
    const safe = this.safeParts(parts, kinds, scan);
    this.encodedLeaves(parts, kinds, safe, scan);
    // Structure first, then the leaves inside it, then nested JSON from the innermost out.
    for (const [frame, slot, next] of replaced) put(writable(frame), slot, next);
    for (let index = 0; index < parts.length; index++) {
      const next = safe[index]!;
      if (next === parts[index]) continue;
      const holder = writable(frames[index]!);
      // A typed number on an error is dropped rather than turned into text.
      put(holder, slots[index]!, kinds[index] === NUMBER && holder instanceof Error ? undefined : next);
      touch(owners[index]!);
    }
    for (let index = nested.length - 1; index >= 0; index--) {
      const entry = nested[index]!;
      if (!entry.crossing && !entry.dirty) continue;
      put(writable(entry.frame as Frame), entry.slot, entry.crossing ? REDACTED : JSON.stringify(entry.json));
      touch(entry.owner);
    }
    return { value: (root.target as Holder)["value"], changed };
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
 * repeats every check but short private values around Connecta's own
 * envelopes, whose identifiers and counts are never private data. */
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

/** Slot reads cover custom handlers too, including keys put in query strings. A field named
 * as an identifier (an application or client ID, a username, a public key) is matched whole. */
export function trackCredentialReads(ctx: ConnectorContext): void {
  if (!ctx.credential || wrappedCredentials.has(ctx)) return;
  wrappedCredentials.add(ctx);
  const credential = ctx.credential;
  const register = (field: string | undefined, value: string) => {
    const secrets = sentSecretsFor(ctx);
    if (field && explicitSecretName.test(field)) secrets.secret(value);
    else if (field && identifierName.test(field)) secrets.identifier(value);
    else secrets.add(value);
  };
  ctx.credential = {
    async get(field) {
      const value = await credential.get(field);
      if (value) register(field, value);
      return value;
    },
    async getAll() {
      const values = await credential.getAll();
      for (const [field, value] of Object.entries(values ?? {})) register(field, value);
      return values;
    },
  };
}

/** A connector's result or error as it enters: every connector's credentials and the
 * request's private arguments, under payload rules. */
export function redactSentSecrets<T>(ctx: ConnectorContext, value: T): T {
  return requestSentSecrets(ctx).redact(value);
}

/** Everything the context's request sent: every connector's credentials and the
 * request's private arguments, which a context's own set does not hold. */
export function requestSentSecrets(ctx: ConnectorContext): SentSecrets {
  sentSecretsFor(ctx);
  return sentSecretsForRequest(ctx.requestScope ?? ctx);
}

/** Downstream text, or a parsed body, about to be cut short, trimmed, normalized or
 * extracted from. Redact it whole first: a cut through an echoed form can leave a remnant
 * shorter than any fragment the output boundary matches, and a normalized number or
 * extracted substring may no longer hold the form at all. */
export function redactBeforeCut<T>(ctx: ConnectorContext, value: T): T {
  return requestSentSecrets(ctx).redact(value);
}

/** Base64, or base64url with `url`, of bytes or UTF-8 text Connecta returns to an agent: a
 * download, an attachment, a REST body, a page cursor. Every such encoding goes through here,
 * since no later pass reads through an encoding the output does not declare: the content is
 * checked first with the request's set, and content holding a match encodes the placeholder.
 * A cursor passes `claims`: connecta's own counts and fingerprints beside downstream values it
 * already redacted (`redactSentSecrets`), checked under the boundary's rules. */
export function encodeForAgent(
  ctx: ConnectorContext,
  content: Uint8Array | string,
  options?: { url?: boolean; claims?: boolean },
): string {
  return requestSentSecrets(ctx).encode(typeof content === "string" ? encoder.encode(content) : content, options);
}

/** Downstream text read only up to a bound, as a field an agent reads: whole forms are
 * replaced, and so is a tail that begins one the read stopped inside. */
export function redactBoundedRead(ctx: ConnectorContext, text: string): string {
  return requestSentSecrets(ctx).redactOpenTail(text);
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
