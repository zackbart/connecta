import { decodeBase64url } from "../../../bytes.js";
import { carriesWithheldLink } from "../../_shared/rest/value-safety.js";

const MAX_MIME_DEPTH = 8;
const MAX_MIME_PARTS = 256;
const MAX_DECODED_BYTES = 16 * 1024 * 1024;
const MAX_ENCODED_WORDS = 4096;
const MAX_BOUNDARY_LENGTH = 70;
const WITHHELD =
  "Not sent: this raw message carries a URL whose query or fragment Connecta withheld ([redacted]). Supply the original link or omit it.";
const SINGLE_BYTE_CHARSETS = /^(?:us-ascii|utf-8|iso-8859-(?:[1-9]|1[013-6])|windows-125[0-8])$/i;
const IDENTITY_ENCODINGS = new Set(["7bit", "8bit", "binary"]);
const TRANSFER_ENCODINGS = new Set([...IDENTITY_ENCODINGS, "base64", "quoted-printable"]);
const TSPECIALS = '()<>@,;:\\"/[]?=';
const BOUNDARY_CHARACTERS = /^[0-9A-Za-z'()+_,\-./:=? ]+$/;
const QUOTED_PAIR = /\\([\t\x20-\x7e])/g;

class Refusal extends Error {}

interface Field {
  name: string;
  value: string;
}
interface Budget {
  parts: number;
  bytes: number;
  words: number;
}
interface Parameterized {
  value: string;
  params: Record<string, string>;
}

/**
 * Gmail decodes a message's `raw` field itself (base64url RFC 2822), so the
 * hatch's ordinary admission sees only its encoding. This admission is a strict
 * allowlist: it accepts only MIME it reads exactly as a mail client would —
 * single-valued, comment-free Content-Type, Content-Transfer-Encoding and
 * Content-Disposition, identity/base64/quoted-printable transfer encodings,
 * US-ASCII, UTF-8 and single-byte ISO-8859/windows-125x charsets, exact
 * boundary delimiter lines and RFC 2047 encoded words joined as clients join
 * them — scans every decoded part, header and attached message for a withheld
 * destination, and refuses anything else, so a refused message sends nothing.
 * Messages, imports and inserts carry `raw` at the top; drafts nest it under
 * `message`.
 */
export function refuseWithheldRaw(body: unknown): string | undefined {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return undefined;
  const record = body as Record<string, unknown>;
  const message = record["message"];
  const lanes = [
    record["raw"],
    message !== null && typeof message === "object" && !Array.isArray(message)
      ? (message as Record<string, unknown>)["raw"]
      : undefined,
  ];
  for (const raw of lanes) {
    if (raw === undefined) continue;
    if (typeof raw !== "string") return "Gmail raw must be a base64url string of an RFC 2822 message.";
    let bytes: Uint8Array;
    try {
      bytes = decodeBase64url(raw, true);
    } catch {
      return "Gmail raw must be valid base64url of an RFC 2822 message.";
    }
    const refusal = refuseWithheldMessage(bytes);
    if (refusal) return refusal;
  }
  return undefined;
}

function refuseWithheldMessage(bytes: Uint8Array): string | undefined {
  try {
    const budget: Budget = { parts: 0, bytes: 0, words: 0 };
    spend(budget, bytes.length);
    const source = latin1(bytes);
    scan(lenientUtf8(source), budget);
    inspectEntity(source, 0, "text/plain", budget);
    return undefined;
  } catch (error) {
    if (error instanceof Refusal) return error.message;
    throw error;
  }
}

function refuse(reason: string): never {
  throw new Refusal(`Not sent: ${reason}`);
}

function spend(budget: Budget, length: number): void {
  budget.bytes += length;
  if (budget.bytes > MAX_DECODED_BYTES)
    refuse(`this raw message decodes to more than ${MAX_DECODED_BYTES} bytes, more than this connection inspects.`);
}

function scan(text: string, budget: Budget): void {
  spend(budget, text.length);
  if (carriesWithheldLink(text)) throw new Refusal(WITHHELD);
}

function inspectEntity(source: string, depth: number, defaultType: string, budget: Budget): void {
  if (depth > MAX_MIME_DEPTH) refuse(`this raw message nests MIME deeper than ${MAX_MIME_DEPTH} levels.`);
  if (++budget.parts > MAX_MIME_PARTS) refuse(`this raw message has more than ${MAX_MIME_PARTS} MIME parts.`);
  const { fields, body } = splitEntity(source);
  scan(fields.flatMap((field) => fieldReadings(field.value, budget)).join("\n"), budget);
  const contentType = single(fields, "content-type");
  const encodingField = single(fields, "content-transfer-encoding");
  const disposition = single(fields, "content-disposition");
  const type = contentType ? parseParameterized(contentType, "Content-Type", true) : { value: defaultType, params: {} };
  if (disposition) parseParameterized(disposition, "Content-Disposition", false);
  const encoding = encodingField ? parseEncoding(encodingField) : "7bit";
  const charset = type.params["charset"];
  if (charset !== undefined && !SINGLE_BYTE_CHARSETS.test(charset))
    refuse(
      `a raw message part declares charset ${JSON.stringify(charset.slice(0, 40))}; only US-ASCII, UTF-8, ISO-8859 and windows-125x are inspected.`,
    );
  if (type.value.startsWith("multipart/")) {
    if (!IDENTITY_ENCODINGS.has(encoding)) refuse("a raw multipart must use a 7bit, 8bit or binary transfer encoding.");
    const boundary = type.params["boundary"];
    if (
      boundary === undefined ||
      boundary.length > MAX_BOUNDARY_LENGTH ||
      !BOUNDARY_CHARACTERS.test(boundary) ||
      boundary.endsWith(" ")
    )
      refuse("a raw multipart has no boundary this connection can read.");
    if (hasBareCarriageReturn(body)) refuse("a raw multipart has a carriage return without a line feed.");
    const childType = type.value === "multipart/digest" ? "message/rfc822" : "text/plain";
    const { text, parts } = splitMultipart(body, boundary);
    for (const section of text) scan(lenientUtf8(section), budget);
    for (const part of parts) inspectEntity(part, depth + 1, childType, budget);
    return;
  }
  const content = decodeTransfer(body, encoding);
  if (!IDENTITY_ENCODINGS.has(encoding)) spend(budget, content.length);
  if (type.value === "message/rfc822" || type.value === "message/global") {
    inspectEntity(content, depth + 1, "text/plain", budget);
    return;
  }
  if (charset !== undefined) scan(decodeCharset(content, charset), budget);
  else if (type.value.startsWith("text/")) scan(decodeCharset(content, "utf-8"), budget);
  else scan(lenientUtf8(content), budget);
}

function single(fields: Field[], name: string): string | undefined {
  const matching = fields.filter((field) => field.name === name);
  if (matching.length > 1) refuse(`a raw message part repeats its ${name} header.`);
  return matching[0]?.value;
}

function splitEntity(source: string): { fields: Field[]; body: string } {
  const fields: Field[] = [];
  let at = 0;
  while (at < source.length) {
    const newline = source.indexOf("\n", at);
    const end = newline < 0 ? source.length : newline + 1;
    const line = withoutLineEnd(source, at, end);
    at = end;
    if (line === "") return { fields, body: source.slice(end) };
    if (line.includes("\r")) refuse("a raw message header block has a carriage return without a line feed.");
    const first = line.charCodeAt(0);
    if (first === 0x20 || first === 0x09) {
      const last = fields.at(-1);
      if (!last) refuse("a raw message header block starts with a continuation line.");
      last.value += line;
      continue;
    }
    const colon = line.indexOf(":");
    const name = colon < 0 ? "" : trimTrailingWhitespace(line.slice(0, colon));
    if (!isFieldName(name)) refuse("a raw message header line is not a field this connection can read.");
    fields.push({ name: name.toLowerCase(), value: line.slice(colon + 1) });
  }
  return { fields, body: "" };
}

function isFieldName(name: string): boolean {
  if (name === "") return false;
  for (let index = 0; index < name.length; index++) {
    const code = name.charCodeAt(index);
    if (code < 33 || code > 126 || code === 0x3a) return false;
  }
  return true;
}

/**
 * RFC 2045 `value *(";" attribute "=" value)` with only whitespace between
 * tokens. Comments, RFC 2231 extended or continued parameters, repeated
 * parameters and stray characters are refused: clients disagree on them, and
 * a boundary or charset read differently would hide a part from inspection.
 */
function parseParameterized(source: string, header: string, mediaType: boolean): Parameterized {
  const unreadable = () =>
    refuse(
      `a raw message part has a ${header} this connection cannot read exactly; comments, extended or repeated parameters and stray characters are refused.`,
    );
  let at = skipWhitespace(source, 0);
  const token = () => {
    const start = at;
    while (at < source.length && isTokenCharacter(source.charCodeAt(at))) at++;
    if (at === start) unreadable();
    return source.slice(start, at);
  };
  let value = token();
  if (mediaType) {
    at = skipWhitespace(source, at);
    if (source[at] !== "/") unreadable();
    at = skipWhitespace(source, at + 1);
    value = `${value}/${token()}`;
  }
  const params: Record<string, string> = Object.create(null);
  for (;;) {
    at = skipWhitespace(source, at);
    if (at === source.length) break;
    if (source[at] !== ";") unreadable();
    at = skipWhitespace(source, at + 1);
    if (at === source.length) break;
    const name = token().toLowerCase();
    if (name.includes("*") || params[name] !== undefined) unreadable();
    at = skipWhitespace(source, at);
    if (source[at] !== "=") unreadable();
    at = skipWhitespace(source, at + 1);
    if (source[at] === '"') {
      let text = "";
      for (at++; ; at++) {
        if (at >= source.length) unreadable();
        const character = source[at]!;
        if (character === '"') break;
        if (character === "\\") {
          at++;
          if (at >= source.length) unreadable();
          text += source[at];
        } else text += character;
      }
      at++;
      params[name] = text;
    } else params[name] = token();
  }
  return { value: value.toLowerCase(), params };
}

function parseEncoding(source: string): string {
  const start = skipWhitespace(source, 0);
  const encoding = trimTrailingWhitespace(source.slice(start)).toLowerCase();
  if (!TRANSFER_ENCODINGS.has(encoding))
    refuse(
      `a raw message part uses transfer encoding ${JSON.stringify(encoding.slice(0, 40))}; only 7bit, 8bit, binary, base64 and quoted-printable are inspected.`,
    );
  return encoding;
}

function isTokenCharacter(code: number): boolean {
  return code > 32 && code < 127 && !TSPECIALS.includes(String.fromCharCode(code));
}

/**
 * A delimiter line is exactly `--boundary` or `--boundary--` plus optional
 * transport padding. Any other line that begins with the delimiter is refused,
 * since clients split on it differently. The line break before a delimiter
 * belongs to the delimiter.
 */
function splitMultipart(body: string, boundary: string): { text: string[]; parts: string[] } {
  const delimiter = `--${boundary}`;
  const sections: string[] = [];
  let sectionStart = 0;
  let closed = false;
  let at = 0;
  while (at < body.length) {
    const newline = body.indexOf("\n", at);
    const end = newline < 0 ? body.length : newline + 1;
    if (body.startsWith(delimiter, at)) {
      const line = trimTrailingWhitespace(withoutLineEnd(body, at, end));
      if (closed || (line !== delimiter && line !== `${delimiter}--`))
        refuse("a raw multipart has a line that begins with its boundary but is not an exact delimiter.");
      sections.push(body.slice(sectionStart, beforeLineBreak(body, sectionStart, at)));
      closed = line !== delimiter;
      sectionStart = end;
    }
    at = end;
  }
  if (sections.length === 0) refuse("a raw multipart has no boundary delimiter.");
  const rest = body.slice(sectionStart);
  const [preamble = "", ...parts] = sections;
  return closed ? { text: [preamble, rest], parts } : { text: [preamble], parts: [...parts, rest] };
}

function beforeLineBreak(text: string, start: number, at: number): number {
  if (at > start && text[at - 1] === "\n") at--;
  if (at > start && text[at - 1] === "\r") at--;
  return at;
}

function withoutLineEnd(text: string, start: number, end: number): string {
  if (end > start && text[end - 1] === "\n") end--;
  if (end > start && text[end - 1] === "\r") end--;
  return text.slice(start, end);
}

function trimTrailingWhitespace(text: string): string {
  let end = text.length;
  while (end > 0 && (text[end - 1] === " " || text[end - 1] === "\t")) end--;
  return text.slice(0, end);
}

function skipWhitespace(text: string, at: number): number {
  while (at < text.length && (text[at] === " " || text[at] === "\t")) at++;
  return at;
}

function hasBareCarriageReturn(text: string): boolean {
  for (let at = text.indexOf("\r"); at >= 0; at = text.indexOf("\r", at + 1)) if (text[at + 1] !== "\n") return true;
  return false;
}

function decodeTransfer(body: string, encoding: string): string {
  if (IDENTITY_ENCODINGS.has(encoding)) return body;
  if (encoding === "base64") return decodeBase64(body, true);
  return decodeQuotedPrintable(body, false);
}

function decodeBase64(text: string, ignoreWhitespace: boolean): string {
  const compact = ignoreWhitespace ? text.replace(/[\r\n\t ]+/g, "") : text;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 === 1)
    refuse("a raw message part has base64 this connection cannot decode exactly.");
  try {
    return atob(compact);
  } catch {
    return refuse("a raw message part has base64 this connection cannot decode exactly.");
  }
}

/** Quoted-printable bodies, or RFC 2047 `Q` words when `word` is set. */
function decodeQuotedPrintable(text: string, word: boolean): string {
  let decoded = "";
  let at = 0;
  while (at < text.length) {
    const equals = text.indexOf("=", at);
    const plain = text.slice(at, equals < 0 ? text.length : equals);
    decoded += word ? plain.replaceAll("_", " ") : plain;
    if (equals < 0) break;
    const hex = text.slice(equals + 1, equals + 3);
    if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
      decoded += String.fromCharCode(parseInt(hex, 16));
      at = equals + 3;
      continue;
    }
    const padded = word ? equals + 1 : skipWhitespace(text, equals + 1);
    if (!word && (padded === text.length || text[padded] === "\n" || text.startsWith("\r\n", padded))) {
      at = padded === text.length ? padded : padded + (text[padded] === "\r" ? 2 : 1);
      continue;
    }
    refuse("a raw message part has quoted-printable this connection cannot decode exactly.");
  }
  return decoded;
}

const decoders = new Map<string, TextDecoder>();

function decoder(charset: string, fatal: boolean): TextDecoder {
  const label = charset.toLowerCase();
  const key = `${fatal}:${label}`;
  let cached = decoders.get(key);
  if (!cached) decoders.set(key, (cached = new TextDecoder(label, { fatal, ignoreBOM: false })));
  return cached;
}

function decodeCharset(binary: string, charset: string): string {
  if (isAscii(binary)) return binary;
  try {
    return decoder(charset, true).decode(bytesOf(binary));
  } catch {
    return refuse(`a raw message part is not valid ${charset.slice(0, 40)} text.`);
  }
}

/**
 * A field value's readings, and when it holds RFC 5322 quoted-pairs, also its readings
 * with each pair read as the character it escapes, as clients read quoted strings,
 * comments and parameter values before decoding encoded words.
 */
function fieldReadings(value: string, budget: Budget): string[] {
  const readings = headerReadings(value, budget);
  return value.includes("\\") ? [...readings, ...headerReadings(value.replace(QUOTED_PAIR, "$1"), budget)] : readings;
}

interface EncodedWord {
  start: number;
  end: number;
  charset: string;
  bytes: string;
}

/**
 * A header value's readings as clients display it: RFC 2047 encoded words decoded
 * wherever they appear, and also with the whitespace between adjacent encoded
 * words removed (RFC 2047 section 6.2), so a link split across words is read
 * whole. Encoded words in a charset outside the allowlist are refused.
 */
function headerReadings(value: string, budget: Budget): string[] {
  const words = encodedWords(value, budget);
  let spaced = "";
  let joined = "";
  let pending = "";
  let pendingCharset = "";
  let at = 0;
  const flush = () => {
    if (pending) joined += decodeCharset(pending, pendingCharset);
    pending = "";
  };
  for (const [index, word] of words.entries()) {
    const gap = value.slice(at, word.start);
    const adjacent = index > 0 && skipWhitespace(gap, 0) === gap.length;
    const gapText = decodeCharset(gap, "utf-8");
    spaced += gapText + lenientDecode(word.bytes, word.charset);
    if (!adjacent || word.charset !== pendingCharset) flush();
    if (!adjacent) joined += gapText;
    pending += word.bytes;
    pendingCharset = word.charset;
    at = word.end;
  }
  flush();
  const tail = decodeCharset(value.slice(at), "utf-8");
  return words.length > 0 ? [spaced + tail, joined + tail] : [spaced + tail];
}

function encodedWords(value: string, budget: Budget): EncodedWord[] {
  const words: EncodedWord[] = [];
  for (let start = value.indexOf("=?"); start >= 0; start = value.indexOf("=?", start + 1)) {
    const charsetEnd = value.indexOf("?", start + 2);
    if (charsetEnd < 0) break;
    const kind = value.charCodeAt(charsetEnd + 1) & ~0x20;
    if ((kind !== 0x42 && kind !== 0x51) || value[charsetEnd + 2] !== "?") continue;
    const textEnd = value.indexOf("?", charsetEnd + 3);
    if (textEnd < 0) break;
    if (value[textEnd + 1] !== "=") continue;
    const label = value.slice(start + 2, charsetEnd);
    const encoded = value.slice(charsetEnd + 3, textEnd);
    if (label === "" || /\s/.test(label) || /\s/.test(encoded)) continue;
    const charset = label.split("*")[0]!.toLowerCase();
    if (!SINGLE_BYTE_CHARSETS.test(charset))
      refuse(
        `a raw message header uses an encoded word in charset ${JSON.stringify(charset.slice(0, 40))}; only US-ASCII, UTF-8, ISO-8859 and windows-125x are inspected.`,
      );
    if (++budget.words > MAX_ENCODED_WORDS)
      refuse(`this raw message has more than ${MAX_ENCODED_WORDS} encoded words, more than this connection inspects.`);
    const bytes = kind === 0x42 ? decodeBase64(encoded, false) : decodeQuotedPrintable(encoded, true);
    words.push({ start, end: textEnd + 2, charset, bytes });
    start = textEnd + 1;
  }
  return words;
}

function latin1(bytes: Uint8Array): string {
  const units = new Uint16Array(bytes.length);
  units.set(bytes);
  return new TextDecoder("utf-16le").decode(units);
}

function bytesOf(binary: string): Uint8Array {
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function lenientUtf8(binary: string): string {
  return lenientDecode(binary, "utf-8");
}

function lenientDecode(binary: string, charset: string): string {
  return isAscii(binary) ? binary : decoder(charset, false).decode(bytesOf(binary));
}

function isAscii(binary: string): boolean {
  for (let index = 0; index < binary.length; index++) if (binary.charCodeAt(index) > 0x7f) return false;
  return true;
}
