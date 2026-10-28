import { authCall, authMethod } from "./auth/native.js";
import { Effect } from "effect";
// Credentials and submitted private argument values used by one upstream request. Memory
// only; never part of a context's public shape, a failure record, storage, or a log. Web APIs only.
import { classificationCode, ConnectorCallError } from "./errors.js";
import { credentialUrlViews } from "./credential-url.js";
import { RequestScope, requestOwner } from "./runtime/request-scope.js";
import { viewSecrets, wrapViewCredentials } from "./runtime/call.js";
import { visitPrivateCallArguments } from "./argument-redaction.js";
import { keptErrorName, redactedCopyOf } from "./redaction-identity.js";
import { REDACTED } from "./redaction-marker.js";
import type { ConnectorContext, JsonSchema, Logger } from "./types.js";

const encoder = new TextEncoder();

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
// Base64 or base64url text no declared field names is decoded and checked too: a whole view of
// at least ENCODED_FIELD_UNITS, or a run inside one long enough to carry the smallest piece the
// scan matches, up to MAX_ENCODED_LEVELS encodings deep. A run is a maximal span of base64 and
// base64url units, decoded from its first. L units decode to floor(3L/4) bytes, so p bytes that
// start a bytes into the encoding (a = 0, 1 or 2, its alignment) need L >= ceil(4(a + p)/3),
// least at a = 0. Padding follows a run and is never counted, so a padded and an unpadded
// encoding decode alike. The smallest piece is a short private value, four units and so at least
// four bytes, when payload rules apply and one is registered: ceil(16/3) = 6 units. Otherwise it
// is K units, at least eight bytes: ceil(32/3) = 11. A whole view needs no more than the first.
const ENCODED_FIELD_UNITS = 6;
const SHORT_RUN_UNITS = 6;
const FRAGMENT_RUN_UNITS = 11;
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
    "title description inputSchema outputSchema size writeOutcome"
  ).split(" "),
);
const TAGS = new Set(
  (
    "type:text type:image type:audio type:resource type:resource_link format:json format:text format:paged " +
    "valueFormat:json valueFormat:text dev.connecta/format:json dev.connecta/format:text resultType:complete " +
    "resultType:input_required mode:form mode:url method:elicitation/create jsonrpc:2.0 writeOutcome:unknown"
  ).split(" "),
);
// Outcome flags: a boolean under these names is kept, since a boolean carries one bit whatever
// produced it. A number or string under them is matched like any other.
const FACTS = new Set(["isError", "ok", "retryable", "truncated", "hasMore"]);
// An error's diagnostics. Its own accessors under these names, such as V8's stack, are read once
// into its copy, as is whatever its chain answers for them; any other own accessor is never
// invoked. Accessors its class chain defines are read once too.
const ERROR_ACCESSORS = new Set(["stack", "message", "cause", "code", "name"]);
// Parts the checker reads: text; a number's canonical text, withheld whole when it changes; a
// declared base64 field, also decoded whole and withheld as the encoded marker; and the bytes a
// typed array or ArrayBuffer holds, as byte-valued units, withheld whole when anything matches.
const TEXT = 0;
const NUMBER = 1;
const BINARY = 2;
const BYTES = 3;
// A typed binary's joined numbers are withheld together, including on an error.
const NUMBERS = 4;
// A changed numeric diagnostic is absent from the error's text projection.
const ERROR_NUMBER = 5;
const numeric = (kind: number | undefined) => kind === NUMBER || kind === NUMBERS || kind === ERROR_NUMBER;
const replacement = (kind: number | undefined) => (kind === BINARY || kind === ERROR_NUMBER ? "" : REDACTED);

/** Payload scans also match short private values; envelope scans leave Connecta's own
 * identifiers, counts and addresses to them. */
type Scan = { budget: { work: number; nodes: number }; payload: boolean };
type Found = { spans: number[] };
/** Source spans to replace. `deep` text still held escapes after MAX_DECODE_LEVELS layers. */
type Matches = { spans: number[]; deep: boolean };

/** An accessor met while looking up an inherited field: never invoked. */
const WITHHELD_ACCESSOR = Symbol("accessor");
/** The engine's own getters for what a typed array, DataView or ArrayBuffer holds, so no
 * subclass answers for them, and the built-in element types by the name a typed array reports. */
const getter = (prototype: object, name: PropertyKey) =>
  Object.getOwnPropertyDescriptor(prototype, name)!.get! as (this: unknown) => unknown;
const TYPED = Object.getPrototypeOf(Uint8Array.prototype) as object;
const TYPED_NAME = getter(TYPED, Symbol.toStringTag);
const TYPED_BUFFER = getter(TYPED, "buffer");
const TYPED_OFFSET = getter(TYPED, "byteOffset");
const TYPED_LENGTH = getter(TYPED, "byteLength");
const VIEW_BUFFER = getter(DataView.prototype, "buffer");
const VIEW_OFFSET = getter(DataView.prototype, "byteOffset");
const VIEW_LENGTH = getter(DataView.prototype, "byteLength");
const BUFFER_LENGTH = getter(ArrayBuffer.prototype, "byteLength");
type Elements = new (buffer: ArrayBufferLike) => ArrayLike<number | bigint>;
// Typed arrays whose elements are not their bytes; a Uint8Array's and a Uint8ClampedArray's are.
const ELEMENTS = new Map(
  (
    "Int8Array Int16Array Uint16Array Int32Array Uint32Array Float16Array Float32Array Float64Array " +
    "BigInt64Array BigUint64Array"
  )
    .split(" ")
    .map((name) => [name, (globalThis as Record<string, unknown>)[name]] as const)
    .filter((entry): entry is readonly [string, Elements] => typeof entry[1] === "function"),
);
const DECIMAL = Array.from({ length: 256 }, (_, byte) => String(byte));
/** Wrapper objects JSON reads as their primitive, read from the engine's slot. */
const BOXED: readonly (readonly [new (value?: unknown) => object, (this: unknown) => unknown])[] = [
  [String, String.prototype.valueOf],
  [Number, Number.prototype.valueOf],
  [Boolean, Boolean.prototype.valueOf],
];

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

/** The bytes a typed array, DataView or ArrayBuffer holds, copied into a fresh built-in
 * Uint8Array through the engine's slots, with the element type of a typed array whose elements
 * are not those bytes. Undefined for any other value. */
function binaryOf(item: object): { bytes: Uint8Array; elements: Elements | undefined } | undefined {
  let held: Uint8Array;
  let elements: Elements | undefined;
  if (ArrayBuffer.isView(item)) {
    const name = TYPED_NAME.call(item);
    const typed = name !== undefined;
    held = new Uint8Array(
      (typed ? TYPED_BUFFER : VIEW_BUFFER).call(item) as ArrayBuffer,
      (typed ? TYPED_OFFSET : VIEW_OFFSET).call(item) as number,
      (typed ? TYPED_LENGTH : VIEW_LENGTH).call(item) as number,
    );
    elements = ELEMENTS.get(name as string);
  } else {
    if (!(item instanceof ArrayBuffer)) return undefined;
    try {
      BUFFER_LENGTH.call(item);
    } catch {
      return undefined; // Its prototype, not an ArrayBuffer.
    }
    held = new Uint8Array(item);
  }
  const bytes = new Uint8Array(held.length);
  bytes.set(held);
  return { bytes, elements };
}

/** A String, Number or Boolean wrapper's primitive, as JSON reads it; undefined otherwise. */
function unboxed(item: object): { value: unknown } | undefined {
  for (const [type, valueOf] of BOXED) {
    if (!(item instanceof type)) continue;
    try {
      return { value: valueOf.call(item) };
    } catch {
      return undefined; // Its prototype, not a wrapper.
    }
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

/** Base64 text without its trailing padding. */
function unpadded(text: string): string {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 0x3d) end--;
  return end === text.length ? text : text.slice(0, end);
}

const BASE64_UNIT = new Uint8Array(65_536);
for (const unit of "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/-_")
  BASE64_UNIT[unit.charCodeAt(0)] = 1;

/** Base64 or base64url runs worth decoding, padding aside: the whole text when it is one, at
 * least ENCODED_FIELD_UNITS long, or each run inside it at least `minimum` long. */
function encodedRuns(text: string, minimum: number): string[] {
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
    if (at === 0 && padded === text.length ? run >= ENCODED_FIELD_UNITS : run >= minimum)
      runs.push(text.slice(at, end));
    at = padded;
  }
  return runs;
}

/** Percent escapes decoded to the byte-valued units they name, or undefined when nothing
 * decodes. With `form`, a `+` is a space too, as form encoding writes one, with or without a
 * percent escape beside it. */
function percentDecoded(text: string, form: boolean): string | undefined {
  let found = false;
  const decoded = text.replace(form ? /%([0-9A-Fa-f]{2})|\+/g : /%([0-9A-Fa-f]{2})/g, (_, digits?: string) => {
    found = true;
    return digits === undefined ? " " : String.fromCharCode(parseInt(digits, 16));
  });
  return found ? decoded : undefined;
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
  const ranges = merged(headerValues(text, spans));
  const parts: string[] = [];
  let cursor = 0;
  for (let index = 0; index < ranges.length; index += 2) {
    parts.push(text.slice(cursor, ranges[index]), REDACTED);
    cursor = ranges[index + 1]!;
  }
  parts.push(text.slice(cursor));
  return parts.join("").replace(headerLine, `$1$2${REDACTED}`);
}

/** A unit of a header line's name, as `headerLine` reads one. */
function headerNameUnit(code: number): boolean {
  return (
    (code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a) || (code >= 0x30 && code <= 0x39) || code === 0x2d
  );
}

/** Whitespace as `headerLine`'s `\s` reads it around a header's `:`. */
function headerSpace(text: string, at: number): boolean {
  return /\s/.test(text[at]!);
}

/**
 * The echo's spans with the value of every sensitive header line (`headerLine`'s names) added,
 * read on the text before the echo is replaced (#703). An echoed private value can take part of a
 * header's name, its `:`, or a credential prefix such as `Bearer `, so the line cannot be read
 * after replacement; read here, the whole value goes, every cookie pair and any short tail with
 * it. A line that is not a sensitive header keeps its text. One forward pass; nothing is kept.
 */
function headerValues(text: string, spans: number[]): number[] {
  const out = [...spans];
  for (let line = 0; line < text.length;) {
    let at = line;
    while (at < text.length && (text[at] === " " || text[at] === "\t")) at++;
    const name = at;
    while (at < text.length && headerNameUnit(text.charCodeAt(at))) at++;
    let next = at;
    while (next < text.length && text[next] !== "\n" && text[next] !== "\r") next++;
    if (at > name) {
      const word = text.slice(name, at).toLowerCase();
      if (word === "cookie" || word === "set-cookie" || /key|token|secret|auth|signature|session/.test(word)) {
        let colon = at;
        while (colon < text.length && headerSpace(text, colon)) colon++;
        if (text[colon] === ":") {
          let value = colon + 1;
          while (value < text.length && headerSpace(text, value)) value++;
          let end = value;
          while (end < text.length && text[end] !== "\n" && text[end] !== "\r") end++;
          if (end > value) out.push(value, end);
          next = Math.max(next, end);
        }
      }
    }
    line = next + 1;
  }
  return out;
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
 * parsed value, the nested JSON holding it, and whether anything in it changed. Text with a
 * match spanning tokens is withheld before its leaves enter the projection. */
interface Nested {
  frame: object;
  slot: PropertyKey;
  json: unknown;
  owner: number;
  dirty: boolean;
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
    short?: Matcher | null;
    whole?: Matcher | null;
    fragments?: Fragments;
    credentials?: SentSecrets;
    folded?: SentSecrets;
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

  /** Structural fields must be refused, never repaired into different URLs. A field the checker
   * would change under the boundary's rules is refused: one holding a whole form or any K-unit
   * run of one, in any view of the lattice. With `ignoreCase`, as for a host URL parsing
   * lowercased, the lowercased field is also checked against lowercased forms. */
  contains(value: string, ignoreCase = false): boolean {
    if (value.length >= Math.min(this.unmatched, this.unmatched < Infinity ? FRAGMENT_LENGTH : Infinity)) return true;
    if (!this.forms.size) return false;
    if (this.checked([value], [TEXT], this.scan(false))[0] !== value) return true;
    return ignoreCase && this.folded().contains(value.toLowerCase());
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

  /** An SDK response body, checked after it has been fully read so late registrations
   * still apply. An idle set leaves the original serialization untouched. */
  serializedAgentOutput(body: string, json: boolean): string {
    if (this.idle()) return body;
    if (json) {
      // Structured redaction joins text blocks, including secrets split across them.
      try {
        return JSON.stringify(redactAgentOutput(this, JSON.parse(body)));
      } catch {
        /* Non-JSON diagnostics still pass through the text boundary. */
      }
    }
    // A second serialized pass over parsed JSON would mistake a blob's encoding
    // for credential bytes. Only non-JSON bodies take this text path.
    return redactAgentOutput(this, body);
  }

  /** A plain-data snapshot of `value` with every match removed: own enumerable data properties
   * (an error's own fields, non-enumerable ones included), read once each. Accessors are never
   * invoked, except an error's stack and the accessors its class defines, read once into the
   * copy. The original object is never returned, so nothing read later can differ from what was
   * checked. Payload rules apply where downstream or guest data enters; the envelope pass at the
   * agent boundary repeats every check except short private values, which would rewrite
   * Connecta's own identifiers, counts and addresses. `values` applies payload rules to every
   * value of a parsed vendor body but keeps its object keys, which result safety and projections
   * match by name: a renamed key would hide a field from the rule that withholds it. JSON inside
   * a string is a value, so its keys are still checked. The connector's result and failures are
   * checked again under payload rules, keys included, at the `api()` boundary and the invocation. */
  redact<T>(value: T, mode: "payload" | "envelope" | "values" = "payload"): T {
    if (this.idle()) return value;
    return this.project(value, this.scan(mode !== "envelope"), mode === "values").value as T;
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
   * payload rules. `claims` is JSON Connecta assembled, such as a page cursor: its own names,
   * counts and fingerprints beside downstream values it already redacted under payload rules.
   * Every string in it is checked under payload rules, since each downstream value a cursor
   * holds is one, and the whole text and its encoding under the boundary's, so Connecta's keys
   * and counts never meet a short private value. Checked so, it is remembered as clean for later
   * passes over the same set. */
  encode(bytes: Uint8Array, { url = false, claims = false }: { url?: boolean; claims?: boolean } = {}): string {
    const binary = latin1(bytes);
    const finish = (text: string) => {
      const encoded = btoa(text);
      return url ? encoded.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : encoded;
    };
    if (this.idle()) return finish(binary);
    const encoded = finish(binary);
    const clean = claims
      ? this.claimsClean(binary, encoded)
      : this.checked([encoded], [BINARY], this.scan(true))[0] === encoded;
    if (!clean) return finish(REDACTED);
    if (claims || encoded.length >= MEMO_UNITS) this.memo.set(encoded, true);
    return encoded;
  }

  /** Text pieces a provider reads as one lane, such as rich-text runs with metadata between
   * them: checked joined, each match replaced in every piece it touches. */
  parts(parts: string[]): string[] {
    if (this.idle()) return parts;
    return this.checked(
      parts,
      parts.map(() => TEXT),
      this.scan(true),
    );
  }

  /** Complete and unfinished forms in bounded text, all found against its original bytes.
   * Replacing a complete match first could hide a longer open match containing it. Even a
   * one-unit shared prefix is withheld: a read boundary gives no evidence it is public text.
   * Each decoded layer sets aside a trailing escape the read cut short, which is withheld. */
  redactOpenTail(text: string): string {
    if (this.idle()) return text;
    return this.checked([text], [TEXT], this.scan(true), true)[0]!;
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

  /** Every form lowercased, for fields such as hosts that reach output lowercased. */
  private folded(): SentSecrets {
    if (!this.views.folded) {
      const view = new SentSecrets();
      for (const [form, kind] of this.forms)
        for (const low of wireForms(form.toLowerCase())) view.store(low, kind, this.frames.get(form) ?? 0);
      this.views.folded = view;
    }
    return this.views.folded;
  }

  /** The shortest text that might hold something this set cannot check, which is withheld: a
   * K-unit run of a value too large to register (or a whole short one), or of a form past the
   * fragment index's or a matcher's capacity. Envelope scans rely on the payload scans for
   * unregistered values. */
  private limit(scan: Scan): number {
    let limit = this.fragments().complete ? Infinity : FRAGMENT_LENGTH;
    limit = Math.min(limit, this.wholeMatcher()?.unindexed ?? Infinity);
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

  /** The one string checker. Every string that can reach an agent, an executor or storage is
   * checked here, under the whole lattice: projection leaves and numbers, object keys, declared
   * binary fields, the bytes of typed arrays and ArrayBuffers, cursor claims and every encoding
   * Connecta produces, error fields, provider lanes, bounded reads and structural fields.
   * `parts` is one lane: matched joined, raw and through its JSON layers, each match replaced in
   * every part it touches, a tiny private value withholding a part it equals, and every part
   * withheld that the set cannot fully check. Then every text and declared binary part is
   * decoded in each of its text views (see textViews), its base64 and base64url runs and a
   * declared field's whole content are decoded and checked as bytes, UTF-8 and nested base64,
   * and so are byte parts; a part a decoded view matches is withheld whole. Each decode is
   * charged to the call's budget, and a part it cannot pay for is withheld. A `bounded` lane is
   * text cut short, which also loses an unfinished tail. Nothing else matches a string that is
   * returned: the matching steps below are called only from here. */
  private checked(
    parts: string[],
    kinds: readonly number[],
    scan: Scan,
    bounded = false,
    normalize?: (lane: string[]) => void,
  ): string[] {
    return this.safeParts(parts, kinds, scan, bounded, normalize);
  }

  /** Cursor claims: the whole text and its encoding under the boundary's rules, then every
   * string in the JSON under payload rules. Keys and numbers are Connecta's own names and
   * counts: a downstream value enters a cursor only as a string. */
  private claimsClean(binary: string, encoded: string): boolean {
    if (this.checked([encoded], [BINARY], this.scan(false))[0] !== encoded) return false;
    const text = utf8(binary);
    const parsed = parse(text);
    const strings: string[] = [];
    const collect = (value: unknown): void => {
      if (typeof value === "string") strings.push(value);
      else if (value !== null && typeof value === "object") for (const item of Object.values(value)) collect(item);
    };
    if (parsed) collect(parsed.json);
    else strings.push(text);
    const scan = this.scan(true);
    return strings.every((claim) => !this.project(claim, scan).changed);
  }

  /** The shortest base64 run inside a view that is decoded: long enough to carry the smallest
   * piece this scan matches (see SHORT_RUN_UNITS). */
  private runUnits(scan: Scan): number {
    return scan.payload && this.shortMatcher() ? SHORT_RUN_UNITS : FRAGMENT_RUN_UNITS;
  }

  /** The text views base64 is found in: the text; one layer of its JSON escapes decoded; its
   * percent escapes decoded; and its form decoding, a `+` read as a space with any percent
   * escapes decoded, whether or not it holds one. Two decodes chained, such as percent escapes
   * inside JSON escapes, are not a view. Undefined when the work budget cannot pay for them. */
  private textViews(text: string, scan: Scan): string[] | undefined {
    const escaped = text.includes("\\");
    const percent = text.includes("%");
    const plus = text.includes("+");
    const decodes = Number(escaped) + Number(percent) + Number(plus);
    if (!decodes) return [text];
    if (!spend(scan, decodes * Math.ceil(text.length / 8))) return undefined;
    const views = [text];
    for (const view of [
      escaped ? unescapeLayer(text)?.text : undefined,
      percent ? percentDecoded(text, false) : undefined,
      plus ? percentDecoded(text, true) : undefined,
    ])
      if (view !== undefined && !views.includes(view)) views.push(view);
    return views;
  }

  /** Text and declared binary parts carrying base64 or base64url, in any text view, the whole
   * view or a run inside it, and byte parts, whose decoded bytes or their UTF-8 text hold a
   * match are withheld whole: no later pass reads through an encoding the output does not
   * declare. A declared field is also decoded whole, as its reader decodes it. Every part's
   * decoded views are matched together, as one lane between unmatched separators. Each decode
   * is paid for from the call's work budget; a part the budget cannot check is withheld. */
  private encodedLeaves(parts: string[], kinds: readonly number[], safe: string[], scan: Scan): void {
    // A run decodes to a group of views, once per call however many parts repeat it, and so do
    // byte parts; each part's groups are recorded as (part, group) pairs. Group -1 is content
    // the work budget could not check, which withholds every part holding it.
    const views: string[] = [];
    const viewGroups: number[] = [];
    const groups = new Map<string, number>();
    const byteGroups = new Map<string, number>();
    const pairLeaves: number[] = [];
    const pairGroups: number[] = [];
    let size = 0;
    const minimum = this.runUnits(scan);
    /** Views of bytes: the bytes themselves unless the lane already matched them, their UTF-8
     * text when a form is not ASCII, and the base64 they carry. */
    const add = (binary: string, group: number, level: number, self = true): boolean => {
      if (self) {
        views.push(binary);
        viewGroups.push(group);
      }
      if (this.unicodeForms && /[\x80-\xff]/.test(binary)) {
        if (!spend(scan, Math.ceil(binary.length / 8))) return false;
        views.push(utf8(binary));
        viewGroups.push(group);
      }
      if (level < MAX_ENCODED_LEVELS)
        for (const run of encodedRuns(binary, minimum)) {
          if (!spend(scan, Math.ceil(run.length / 8))) return false;
          const inner = decodeBase64(run);
          if (inner && !add(inner, group, level + 1)) return false;
        }
      return true;
    };
    const groupOf = (run: string): number => {
      let group = groups.get(run);
      if (group === undefined) {
        group = size++;
        const bytes = spend(scan, Math.ceil(run.length / 8)) ? decodeBase64(run) : null;
        if (bytes === null || (bytes && !add(bytes, group, 1))) group = -1;
        groups.set(run, group);
      }
      return group;
    };
    const bytesGroup = (bytes: string): number => {
      let group = byteGroups.get(bytes);
      if (group === undefined) {
        group = size++;
        if (!add(bytes, group, 1, false)) group = -1;
        byteGroups.set(bytes, group);
      }
      return group;
    };
    leaves: for (let index = 0; index < parts.length; index++) {
      // The part as text matching left it: a run it replaced in place, such as a registered base64
      // form, leaves no decodable remnant of K units; a match only decoding reveals withholds all.
      // Binary and bytes any match changed are withheld whole already.
      const kind = kinds[index]!;
      const text = safe[index]!;
      if (numeric(kind) || text === REDACTED || this.memo.get(text) === true) continue;
      if ((!scan.payload && this.memo.has(text)) || (kind !== TEXT && text !== parts[index])) continue;
      const pair = (group: number): boolean => {
        if (group < 0) {
          safe[index] = REDACTED;
          return false;
        }
        pairLeaves.push(index);
        pairGroups.push(group);
        return true;
      };
      if (kind === BYTES) {
        pair(bytesGroup(text));
        continue;
      }
      const textViews = this.textViews(text, scan);
      if (!textViews) {
        safe[index] = REDACTED;
        continue;
      }
      for (const view of textViews)
        for (const run of encodedRuns(view, minimum)) if (!pair(groupOf(run))) continue leaves;
      if (kind === BINARY) pair(groupOf(unpadded(text)));
    }
    if (!views.length) return;
    const matched = new Uint8Array(size);
    const withhold = (at: number) => (matched[viewGroups[at]!] = 1);
    try {
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
    } finally {
      for (let pair = 0; pair < pairLeaves.length; pair++)
        if (matched[pairGroups[pair]!]) safe[pairLeaves[pair]!] = REDACTED;
    }
  }

  /** Check replacements as returned, including their placeholder seams. Numbers touched by
   * the first scan get one chance beside the replaced strings; every later hit withholds its
   * entire part. Each changing round therefore removes at least one remaining part. Unchanged
   * lanes pay for no retry. Large lanes recheck changed parts and the seams touching them; an
   * unaffordable check withholds every part it read and all original retention candidates. */
  private settleParts(
    parts: string[],
    safe: string[],
    scan: Scan,
    numbers: number[] = [],
    leafByLeaf = false,
    kinds?: readonly number[],
    normalize?: (lane: string[]) => void,
  ): string[] {
    let touched = new Set(parts.flatMap((part, index) => (part !== safe[index] ? [index] : [])));
    if (!touched.size) return safe;
    const lane = [...safe];
    for (const index of numbers) lane[index] = parts[index]!;
    normalize?.(lane);
    while (touched.size) {
      // Pay for round bookkeeping even when no registered matcher could scan (for
      // example, an oversized private registration governed only by withholdRuns).
      if (!spend(scan, lane.length)) {
        const withheld = lane.map((part, index) => part && replacement(kinds?.[index]));
        normalize?.(withheld);
        return withheld;
      }
      let checked: string[];
      const recheck = { parts: touched, complete: true };
      const matches = leafByLeaf ? undefined : this.spansOf(lane.join(""), scan, scan.payload);
      if (matches && !matches.deep) checked = replaceParts(lane, matches.spans);
      else checked = this.leafByLeaf(lane, scan, undefined, recheck);
      const limit = this.limit(scan);
      if (limit < Infinity) checked = withholdRuns(lane, checked, limit);
      if (!recheck.complete)
        for (const index of numbers) if (checked[index] === parts[index]) checked[index] = replacement(kinds?.[index]);
      normalize?.(checked);
      const next = new Set<number>();
      for (let index = 0; index < lane.length; index++) {
        if (checked[index] === lane[index] || (lane[index] === REDACTED && checked[index] !== "")) continue;
        const withheld = replacement(kinds?.[index]);
        // Whole-field groups project one marker and empty remaining parts.
        const value = checked[index] === "" ? "" : withheld;
        if (lane[index] === value) continue;
        lane[index] = value;
        next.add(index);
      }
      touched = next;
    }
    return lane;
  }

  /** The parts' joined text, with each part's replacement. A touched number is checked again
   * after string replacement before withholding it whole. Tiny or short whole private values,
   * deep matches and unchecked runs still withhold changed numbers whole. A bounded lane also
   * loses an unfinished tail, and withholds every touched number without a second check. */
  private safeParts(
    parts: string[],
    kinds: readonly number[],
    scan: Scan,
    bounded: boolean,
    normalize?: (lane: string[]) => void,
  ): string[] {
    if (!parts.length) return parts;
    const text = parts.join("");
    // A form too large to register or index could begin anywhere in what was read.
    const matches = bounded && this.uncheckedTail() ? undefined : this.spansOf(text, scan, scan.payload);
    if (bounded && (!matches || matches.deep)) return parts.map((part) => part && REDACTED);
    if (bounded) this.openSpans(text, matches!.spans);
    const numbers: number[] = [];
    let safe = matches ? replaceParts(parts, matches.spans) : this.leafByLeaf(parts, scan, kinds, undefined, numbers);
    if (matches && !bounded && !matches.deep)
      for (let index = 0; index < parts.length; index++)
        if (numeric(kinds[index]) && safe[index] !== parts[index]) numbers.push(index);
    if (matches?.deep) safe = safe.map((next, index) => (parts[index]!.includes("\\") ? REDACTED : next));
    const whole = new Set<number>();
    if (scan.payload && this.smallForms)
      safe = safe.map((next, index) => {
        // Typed numeric groups checked their individual whole values while walking.
        if (kinds[index] === NUMBERS || !this.whole(parts[index]!)) return next;
        whole.add(index);
        return REDACTED;
      });
    const limit = this.limit(scan);
    if (limit < Infinity) safe = withholdRuns(parts, safe, limit);
    safe = safe.map((next, index) => (next !== parts[index] && numeric(kinds[index]) ? REDACTED : next));
    this.encodedLeaves(parts, kinds, safe, scan);
    // Declared binary leaves as the checked encoding of the marker, not its partial text.
    let marker: string | undefined;
    safe = safe.map((next, index) => {
      if (next === parts[index] || kinds[index] !== BINARY) return next;
      const encoded = btoa(REDACTED);
      marker ??= this.checked([encoded], [TEXT], scan)[0] === encoded ? encoded : "";
      return marker;
    });
    safe = safe.map((next, index) => (next !== parts[index] && kinds[index] === ERROR_NUMBER ? "" : next));
    normalize?.(safe);
    return this.settleParts(
      parts,
      safe,
      scan,
      numbers.filter((index) => !whole.has(index) && limit === Infinity),
      !matches,
      kinds,
      normalize,
    );
  }

  /** Leaves too large to match joined within the work budget: each is matched alone, in order,
   * and one that does not fit is withheld without spending what a smaller one needs. A run
   * crossing from one kept leaf into the next, through any short leaves between them, is then
   * matched SEAM_UNITS deep on each side of the seam. */
  private leafByLeaf(
    parts: string[],
    scan: Scan,
    kinds?: readonly number[],
    recheck?: { parts: ReadonlySet<number>; complete: boolean },
    candidates?: number[],
  ): string[] {
    const spans = parts.map((part, index) => {
      // Only changed parts and their seams need checking on a retry. Kept neighbours
      // remain exactly as returned, even when their full text would not fit again.
      if (recheck && !recheck.parts.has(index)) return [];
      const matches = this.spansOf(part, scan, scan.payload);
      if (recheck && (!matches || matches.deep)) recheck.complete = false;
      return !matches || (matches.deep && part.includes("\\")) ? undefined : matches.spans;
    });
    let pieces: { index: number; start: number; text: string }[] = [];
    const seam = () => {
      const text = pieces.map((piece) => piece.text).join("");
      const needed = pieces.length > 1 && (!recheck || pieces.some((piece) => recheck.parts.has(piece.index)));
      const matches = needed ? this.spansOf(text, scan, scan.payload) : { spans: [], deep: false };
      if (recheck && (!matches || matches.deep)) recheck.complete = false;
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
      // A failed retry, or a marker already introduced while walking, still
      // contains this part in the returned lane. Keep its unchecked seams.
      if (!spans[index] && !recheck && part !== REDACTED) return seam();
      if (part.length <= 2 * SEAM_UNITS) return void pieces.push({ index, start: 0, text: part });
      pieces.push({ index, start: 0, text: part.slice(0, SEAM_UNITS) });
      seam();
      pieces.push({ index, start: part.length - SEAM_UNITS, text: part.slice(-SEAM_UNITS) });
    });
    seam();
    const safe = parts.map((part, index) => {
      const own = spans[index];
      return !own ? part && REDACTED : own.length ? replace(part, own) : part;
    });
    const numbers = kinds
      ? kinds.flatMap((kind, index) =>
          numeric(kind) && spans[index]?.length && safe[index] !== parts[index] ? [index] : [],
        )
      : [];
    if (candidates) {
      for (const index of numbers) candidates.push(index);
      return safe;
    }
    return kinds
      ? this.settleParts(
          parts,
          safe.map((next, index) => (next !== parts[index] && numeric(kinds[index]) ? REDACTED : next)),
          scan,
          numbers,
          true,
          kinds,
        )
      : safe;
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
   * own fields included, declared binary fields and the bytes and numbers typed binary holds
   * among them; the one checker matches the joined projection, so a form split across adjacent
   * leaves is found, and only the affected piece of each leaf is written back. Keys and scalars
   * go through the same checker alone. Fixed framing words and tags, outcome booleans, and on an
   * error its classification code and a name its registered class gives it (redaction-identity's
   * fixed allowlist) are kept: nothing downstream chooses them. Every other field is matched,
   * whatever its name; an error's other name is projected like any field and withheld whole when
   * anything changes any part of it.
   *
   * What returns is what was checked, and only JSON data: strings, numbers, booleans, null,
   * plain objects and arrays, a fresh built-in Uint8Array, and error copies. A caller's container
   * is returned as it stands only as verified plain data, so a later read returns the same
   * values: its prototype is Object.prototype, Array.prototype or null, nothing on its chain is a
   * toJSON, it holds no symbol field and an array no field but its indices (a hole checked
   * through its prototypes), every field is a data property this walk read, and nothing in it
   * changed. Anything else is a copy. An error always is, of its own class, with the accessors in
   * ERROR_ACCESSORS and those its chain defines read once into fields and a toJSON shadowed, never
   * read; an object of any other class is plain data, its chain's accessors unread; an array that
   * is not plain is a plain array of its indices; a String, Number or Boolean wrapper is its
   * primitive. A typed array, DataView or ArrayBuffer becomes a fresh Uint8Array of the bytes it
   * held, which are checked as bytes, and as numbers with any other elements it held. A function
   * or symbol is withheld. A container's own accessor is never invoked: its copy leaves it out,
   * or holds the placeholder at an array index. A toJSON is called once, as serialization would,
   * and replaced by its checked result. A change copies every container on its path on first
   * write, so no caller's value is ever mutated, and a container past the node budget is
   * withheld whole. Copies hold writable, configurable data properties and keep the identity
   * facts registered in redaction-identity. */
  private project(value: unknown, scan: Scan, keepKeys = false): { value: unknown; changed: boolean } {
    type Holder = Record<PropertyKey, unknown>;
    /** Where values are written: `target` itself when this walk made it, or for a caller's
     * container (`shared`) a copy made on its first write and put in place of it in `parent`.
     * `children` are the toJSON results walked in its slots. */
    interface Frame {
      target: object;
      shared: boolean;
      parent: Frame | undefined;
      slot: PropertyKey;
      copy?: object;
      children?: Map<PropertyKey, Frame>;
    }
    const parts: string[] = [];
    const kinds: number[] = [];
    const frames: Frame[] = [];
    const slots: PropertyKey[] = [];
    const owners: number[] = [];
    // Structural changes found while walking: a withheld or checked field, a copied container.
    const replaced: [frame: Frame, slot: PropertyKey, value: unknown][] = [];
    // Caller's arrays that are not plain data: copied even where nothing in them changed.
    const copied: Frame[] = [];
    const nested: Nested[] = [];
    const active = new Set<object>();
    // Keys and scalars repeat across rows; each is checked once per call.
    const seen = { keys: new Map<string, string>(), scalars: new Map<string, string>() };
    // An error name may contain parsed JSON. Any change collapses all of its
    // projected leaves to one placeholder before the surrounding lane settles.
    const named: { copy: Holder; slot: string; start: number; end: number; withheld: boolean }[] = [];
    // Non-byte typed arrays have an alternate numeric projection, in the same slots as
    // their returned bytes. Neither representation can interrupt the other's neighbours.
    const elements = new Map<number, string>();
    // The accessors each prototype's chain defines, found once per call.
    const chains = new Map<object, string[]>();
    let changed = false;
    const touch = (owner: number) => {
      changed = true;
      if (owner >= 0) nested[owner]!.dirty = true;
    };
    const withheld = (frame: Frame, slot: PropertyKey, owner: number) => {
      leaf(REDACTED, TEXT, frame, slot, owner);
      touch(owner);
      return REDACTED;
    };
    /** A key or scalar's text, through the one checker alone. */
    const check = (cache: Map<string, string>, text: string, kind: number): string => {
      let result = cache.get(text);
      if (result === undefined) cache.set(text, (result = this.checked([text], [kind], scan)[0]!));
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
    /** A field put on a copy or on parsed JSON: an array index by assignment, any other key as a
     * writable, configurable data property, enumerable as it was. A frozen or read-only original
     * never makes a write throw, and no inherited setter runs. */
    const put = (holder: object, slot: PropertyKey, next: unknown, enumerable = true) => {
      if (typeof slot === "number") (holder as unknown[])[slot] = next;
      else
        Object.defineProperty(holder, slot, {
          value: next,
          writable: true,
          configurable: true,
          enumerable: Object.getOwnPropertyDescriptor(holder, slot)?.enumerable ?? enumerable,
        });
    };
    /** A caller's container copied from its descriptors, never invoking an accessor: an array as
     * a plain array of its indices, a hole staying one and an accessor the placeholder; a plain
     * object as its own data fields. */
    const shallow = (frame: Frame): object => {
      const item = frame.target;
      if (Array.isArray(item)) {
        const length = (item as unknown[]).length;
        const out: unknown[] = [];
        out.length = length;
        for (let index = 0; index < length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(item, index);
          if (descriptor) out[index] = "value" in descriptor ? descriptor.value : REDACTED;
        }
        return redactedCopyOf(item, out);
      }
      const out = Object.create(Object.getPrototypeOf(item) as object | null) as Holder;
      for (const name of Object.getOwnPropertyNames(item)) {
        const descriptor = Object.getOwnPropertyDescriptor(item, name)!;
        if ("value" in descriptor) put(out, name, descriptor.value, descriptor.enumerable);
      }
      return redactedCopyOf(item, out);
    };
    // toJSON results, which replace their container in its slot and may be copied after.
    const serialized = new Set<object>();
    /** A caller's container walked in a slot. A toJSON result is remembered there, so a copy it
     * gets replaces it in that slot. */
    const walked = (frame: Frame, item: object, slot: PropertyKey, owned: boolean): Frame => {
      const own: Frame = { target: item, shared: !owned, parent: frame, slot };
      if (!owned && serialized.has(item)) (frame.children ??= new Map()).set(slot, own);
      return own;
    };
    const writable = (frame: Frame): Holder => {
      if (!frame.shared) return frame.target as Holder;
      if (!frame.copy) {
        frame.copy = shallow(frame);
        put(writable(frame.parent!), frame.slot, frame.copy);
      }
      return frame.copy as Holder;
    };
    /** The accessors a prototype's chain defines below Object.prototype, by name. */
    const accessorsOf = (prototype: object): string[] => {
      let names = chains.get(prototype);
      if (!names) {
        names = [];
        for (
          let at: object | null = prototype;
          at && at !== Object.prototype;
          at = Object.getPrototypeOf(at) as object | null
        )
          for (const name of Object.getOwnPropertyNames(at)) {
            const descriptor = Object.getOwnPropertyDescriptor(at, name);
            if (descriptor && !("value" in descriptor) && !names.includes(name)) names.push(name);
          }
        chains.set(prototype, names);
      }
      return names;
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
            if (this.spansTokens(item, scan)) return withheld(frame, slot, owner);
            const entry: Nested = { frame, slot, json: undefined, owner, dirty: false };
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
        leaf(String(item), frame.target instanceof Error ? ERROR_NUMBER : NUMBER, frame, slot, owner);
        return item;
      }
      if (typeof item === "boolean" || item === null)
        return check(seen.scalars, String(item), NUMBER) === String(item) ? item : withheld(frame, slot, owner);
      // A function carries no data, and every exit's serializer would call a toJSON it holds; a
      // symbol carries none either. Both are withheld.
      if (typeof item === "function" || typeof item === "symbol") return withheld(frame, slot, owner);
      if (typeof item !== "object") return item;
      if (active.has(item) || depth > MAX_WALK_DEPTH) return withheld(frame, slot, owner);
      active.add(item);
      try {
        return container(item, frame, slot, depth, level, owner, owned);
      } catch {
        return withheld(frame, slot, owner); // A proxy trap or a toJSON that threw.
      } finally {
        active.delete(item);
      }
    };
    /** A child that changed: written into parsed JSON this walk owns, or recorded as a change
     * to a caller's container. */
    const settle = (frame: Frame, slot: PropertyKey, next: unknown, owner: number) => {
      if (frame.shared) return replace(frame, slot, next, owner);
      put(frame.target, slot, next);
      touch(owner);
    };
    /** Entries within the node budget are walked; a container past it is withheld whole. */
    const fits = (size: number): boolean => {
      if (size > scan.budget.nodes) return false;
      scan.budget.nodes -= size;
      return true;
    };
    /** A declared base64 field: a leaf the checker also decodes whole, unless this set already
     * found the same content clean. */
    const declared = (text: string, frame: Frame, slot: PropertyKey, owner: number): string => {
      if (this.memo.get(text) !== true && (scan.payload || !this.memo.has(text)))
        leaf(text, BINARY, frame, slot, owner);
      return text;
    };
    /** Typed binary is one whole-withheld numeric part: its byte numbers are adjacent to
     * neighbours in the returned lane, and original elements substitute in a separate lane.
     * Individual numeric whole-value matches and the raw byte view are also checked. */
    const typed = (
      { bytes, elements: constructor }: NonNullable<ReturnType<typeof binaryOf>>,
      frame: Frame,
      slot: PropertyKey,
      owner: number,
    ): unknown => {
      const numbers = constructor ? new constructor(bytes.buffer) : undefined;
      let clean = fits(bytes.length + (numbers?.length ?? 0) + 1) && spend(scan, Math.ceil(bytes.length / 8));
      const decimal = (values: ArrayLike<number | bigint>): string => {
        const text: string[] = [];
        for (let index = 0; index < values.length; index++) {
          const number = values === bytes ? DECIMAL[bytes[index]!]! : String(values[index]);
          if (scan.payload && this.smallForms && this.whole(number)) clean = false;
          text.push(number);
        }
        return text.join("");
      };
      // Refuse oversize arrays before building their numeric projection.
      if (!clean) {
        return withheld(frame, slot, owner);
      }
      const text = decimal(bytes);
      const original = numbers ? decimal(numbers) : undefined;
      const binary = latin1(bytes);
      clean &&= this.checked([binary], [BYTES], scan)[0] === binary;
      if (clean && original !== undefined) elements.set(parts.length, original);
      leaf(clean ? text : REDACTED, NUMBERS, frame, slot, owner);
      if (!clean) touch(owner);
      return clean ? bytes : REDACTED;
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
      const error = item instanceof Error;
      if (!error && !owned) {
        const held = binaryOf(item);
        if (held) return typed(held, frame, slot, owner);
        const primitive = unboxed(item);
        if (primitive) return visit(primitive.value, frame, slot, depth + 1, level, owner, false);
        // What serialization would read: a toJSON result, checked in place of the container.
        const toJSON = inherited(item, "toJSON", WITHHELD_ACCESSOR);
        if (toJSON === WITHHELD_ACCESSOR) return withheld(frame, slot, owner);
        if (typeof toJSON === "function") {
          const result: unknown = toJSON.call(item, String(slot));
          if (result !== null && typeof result === "object") serialized.add(result);
          return visit(result, frame, slot, depth + 1, level, owner, false);
        }
      }
      return Array.isArray(item)
        ? list(item as unknown[], frame, slot, depth, level, owner, owned)
        : record(item, error, frame, slot, depth, level, owner, owned);
    };
    /** An array's indices, each read once. A caller's array stands only as verified plain data;
     * one that is not is copied as a plain array of its indices, which drops other fields. */
    const list = (
      item: unknown[],
      frame: Frame,
      slot: PropertyKey,
      depth: number,
      level: number,
      owner: number,
      owned: boolean,
    ): unknown => {
      const length = item.length;
      if (!fits(length)) return withheld(frame, slot, owner);
      const own = walked(frame, item, slot, owned);
      for (let index = 0; index < length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, index);
        if (!descriptor) {
          // A hole serializes as what its prototypes hold at its index: a data field is checked
          // and copied in, an accessor is withheld unread, and nothing leaves the hole as it is.
          const found = owned ? undefined : inherited(item, String(index), WITHHELD_ACCESSOR);
          if (found === WITHHELD_ACCESSOR) replace(own, index, withheld(own, index, owner), owner);
          else if (found !== undefined) {
            replaced.push([own, index, found]);
            const next = visit(found, own, index, depth + 1, level, owner, owned);
            if (next !== found) settle(own, index, next, owner);
          }
          continue;
        }
        if (!("value" in descriptor)) {
          replace(own, index, withheld(own, index, owner), owner);
          continue;
        }
        const next = visit(descriptor.value, own, index, depth + 1, level, owner, owned);
        if (next !== descriptor.value) settle(own, index, next, owner);
      }
      // Fields other than its indices are not read: JSON, which the MCP wire, the result stash and
      // every executor marshal with, never serializes them, and listing them would allocate a
      // string per index.
      if (!owned && (Object.getPrototypeOf(item) !== Array.prototype || Object.getOwnPropertySymbols(item).length > 0))
        copied.push(own);
      return item;
    };
    const record = (
      item: object,
      error: boolean,
      frame: Frame,
      slot: PropertyKey,
      depth: number,
      level: number,
      owner: number,
      owned: boolean,
    ): unknown => {
      const names = Object.getOwnPropertyNames(item);
      if (!fits(names.length)) return withheld(frame, slot, owner);
      const prototype = Object.getPrototypeOf(item) as object | null;
      let plain =
        owned ||
        (!error &&
          (prototype === Object.prototype || prototype === null) &&
          Object.getOwnPropertySymbols(item).length === 0);
      // Every field is read once, and every decision below reads what was read.
      const keys: string[] = [];
      const values: unknown[] = [];
      const visible: boolean[] = [];
      for (const name of names) {
        const descriptor = Object.getOwnPropertyDescriptor(item, name);
        if (!descriptor) continue;
        // An error is never replaced by its toJSON: its copy shadows one.
        if ("value" in descriptor) values.push(error && name === "toJSON" ? undefined : descriptor.value);
        else if (error && descriptor.get && ERROR_ACCESSORS.has(name)) {
          // V8 renders Error.stack through an own accessor: it is read once into the copy.
          try {
            values.push(Reflect.apply(descriptor.get, item, []));
          } catch {
            continue; // A getter that throws leaves its field out of the copy.
          }
        } else {
          // Never invoked: the container is copied without it.
          plain = false;
          continue;
        }
        keys.push(name);
        visible.push(descriptor.enumerable === true);
      }
      // A key is checked like any text; an error's toJSON shadow keeps its name, so it shadows.
      // `keepKeys` leaves the walked value's own keys, never those of JSON inside a string.
      const rename = (key: string) =>
        FRAMING_KEYS.has(key) || (error && key === "toJSON") || (keepKeys && level === 0 && !error)
          ? key
          : check(seen.keys, key, TEXT);
      const renamed = keys.map(rename);
      if (renamed.some((name, index) => name !== keys[index])) plain = false;
      // An error's copy is of its class. Every accessor its chain defines, such as DOMException's
      // name and message or an SDK error's status, and whatever the chain answers for the names
      // in ERROR_ACCESSORS, is read once and held as a checked field under its checked name, so
      // no later read of the copy invokes a getter. A toJSON, data or accessor, is never read: the
      // copy shadows it, so no serializer can run. Any other copy is plain data.
      let extras: [string, unknown][] | undefined;
      if (error && prototype) {
        for (const name of [...ERROR_ACCESSORS, ...accessorsOf(prototype)]) {
          if (name === "toJSON" || keys.includes(name) || extras?.some(([taken]) => taken === name)) continue;
          if (!(name in item)) continue;
          try {
            (extras ??= []).push([name, Reflect.get(item, name)]);
          } catch {
            (extras ??= []).push([name, undefined]); // A getter that throws leaves its field shadowed.
          }
        }
        if (!keys.includes("toJSON") && inherited(item, "toJSON", WITHHELD_ACCESSOR) !== undefined)
          (extras ??= []).push(["toJSON", undefined]);
      }
      // A container walked as it stands: a caller's, copied on first write, or parsed JSON this
      // walk owns, written in place. Any other is copied now, field by field.
      const own: Frame = plain
        ? walked(frame, item, slot, owned)
        : {
            target: Object.create(error || prototype === null ? prototype : Object.prototype) as object,
            shared: false,
            parent: frame,
            slot,
          };
      const out = own.target as Holder;
      const field = (name: string) => values[keys.indexOf(name)];
      const count = keys.length + (extras?.length ?? 0);
      for (let index = 0; index < count; index++) {
        const extra = index >= keys.length ? extras![index - keys.length]! : undefined;
        const key = extra ? extra[0] : keys[index]!;
        const value = extra ? extra[1] : values[index];
        const name = extra ? rename(key) : renamed[index]!;
        // Two keys renamed alike keep the first; the second's leaves write nowhere.
        const target: Frame =
          !plain && Object.hasOwn(out, name) ? { target: {}, shared: false, parent: undefined, slot: name } : own;
        let next: unknown;
        if (
          (typeof value === "string" && TAGS.has(`${key}:${value}`)) ||
          (typeof value === "boolean" && FACTS.has(key)) ||
          (error && typeof value === "string" && key === "code" && classificationCode(value) !== undefined)
        )
          next = value;
        // An error's name is kept only as one its registered class gives it. Any other is a field
        // like any other, projected with its neighbours, and withheld whole once anything changes
        // any part of it; the copy keeps its class.
        else if (error && key === "name" && typeof value === "string" && keptErrorName(prototype, value)) next = value;
        else if (typeof value === "string" && binaryField(field, key)) next = declared(value, target, name, owner);
        else {
          const start = parts.length;
          const nestedStart = nested.length;
          next = visit(value, target, name, depth + 1, level, owner, owned);
          if (error && key === "name" && typeof value === "string" && target === own) {
            if (parts.length === start) leaf("", TEXT, target, name, owner);
            named.push({
              copy: out,
              slot: name,
              start,
              end: parts.length,
              withheld: next !== value || nested.slice(nestedStart).some((entry) => entry.dirty),
            });
          }
        }
        if (target !== own) continue;
        if (!plain) put(out, name, next, extra ? false : visible[index]);
        else if (next !== value) settle(own, name, next, owner);
      }
      if (plain) return item;
      touch(owner);
      return redactedCopyOf(item, out);
    };
    const root: Frame = { target: { value: undefined }, shared: false, parent: undefined, slot: "value" };
    (root.target as Holder)["value"] = visit(value, root, "value", 0, 0, -1, false);
    const normalize = named.length
      ? (lane: string[]) => {
          for (const entry of named) {
            for (let index = entry.start; !entry.withheld && index < entry.end; index++)
              if (lane[index] !== parts[index]) entry.withheld = true;
            if (entry.withheld)
              for (let index = entry.start; index < entry.end; index++)
                lane[index] = index === entry.start ? REDACTED : "";
          }
        }
      : undefined;
    let lane = parts;
    if (elements.size) {
      const original = parts.map((part, index) => elements.get(index) ?? part);
      const checked = this.checked(original, kinds, scan, false, normalize);
      lane = checked.map((part, index) => (part === original[index] ? parts[index]! : part));
    }
    const safe = this.checked(lane, kinds, scan, false, normalize);
    // Structure first, then the leaves inside it and typed binary, then nested JSON from the
    // innermost out.
    // A slot replaced by a toJSON result walked there takes the copy that result already got,
    // never the original.
    for (const [frame, slot, next] of replaced) {
      const child = frame.children?.get(slot);
      put(writable(frame), slot, child && child.target === next && child.copy ? child.copy : next);
    }
    for (const frame of copied) writable(frame);
    for (let index = 0; index < parts.length; index++) {
      const next = safe[index]!;
      const kind = kinds[index]!;
      if (next === parts[index]) {
        if (kind === BINARY && next.length >= MEMO_UNITS) this.memo.set(next, scan.payload);
        continue;
      }
      const holder = writable(frames[index]!);
      // A typed number on an error is dropped rather than turned into text.
      put(holder, slots[index]!, kind === ERROR_NUMBER ? undefined : next);
      touch(owners[index]!);
    }
    for (let index = nested.length - 1; index >= 0; index--) {
      const entry = nested[index]!;
      if (!entry.dirty) continue;
      put(writable(entry.frame as Frame), entry.slot, JSON.stringify(entry.json));
      touch(entry.owner);
    }
    for (const entry of named) if (entry.withheld) put(entry.copy, entry.slot, REDACTED);
    return { value: (root.target as Holder)["value"], changed };
  }
}

export function sentSecretsFor(ctx: ConnectorContext): SentSecrets {
  return viewSecrets(ctx);
}

/** One identity per upstream request, including all discovery and call work. */
export function sentSecretsForRequest(scope: object, secrets?: SentSecrets): SentSecrets {
  const retained = requestOwner(scope).retained;
  const request = (retained.secrets ??= secrets ?? new SentSecrets());
  if (secrets) request.include(secrets);
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
      authMethod((...args: never[]) =>
        Effect.suspend(() => {
          const scope = requestScope ?? {};
          const secrets = sentSecretsForRequest(scope);
          const owner = requestOwner(scope);
          if (!owner.open) return Effect.fail(owner.controller.signal.reason);
          return authCall(create(scope)[name], args).pipe(
            Effect.provideService(RequestScope, requestOwner(scope)),
            Effect.map((value) => redactAgentOutput(secrets, value)),
            Effect.mapError((error) => redactAgentOutput(secrets, error)),
          );
        }),
      ),
    ]),
  ) as T;
}

/** Slot reads cover custom handlers too, including keys put in query strings. A field named
 * as an identifier (an application or client ID, a username, a public key) is matched whole. */
export function registerCredentialValues(
  secrets: SentSecrets,
  values: import("./types.js").ConnectorCredentialValues | null,
): void {
  for (const [field, value] of Object.entries(values ?? {})) {
    if (explicitSecretName.test(field)) secrets.secret(value);
    else if (identifierName.test(field)) secrets.identifier(value);
    else secrets.add(value);
  }
}
export function trackCredentialReads(ctx: ConnectorContext): void {
  wrapViewCredentials(ctx);
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
