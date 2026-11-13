import { decodeBase64url } from "../../../bytes.js";
import { carriesWithheldLink } from "../../_shared/rest/value-safety.js";

const MAX_MIME_DEPTH = 8;
const MAX_MIME_PARTS = 256;
const BARE_CR = /\r(?!\n)/;
const WITHHELD =
  "Not sent: this raw message carries a URL whose query or fragment Connecta withheld ([redacted]). Supply the original link or omit it.";
const ASCII_CHARSETS =
  /^(?:us-ascii|ascii|utf-?8|iso[-_]?8859-\d{1,2}|latin-?\d|(?:windows|cp)-?125\d|windows-874|tis-620|koi8-[a-z]+|gb2312|gbk|gb18030|big5(?:-hkscs)?|shift[-_]jis|sjis|windows-31j|euc-(?:jp|kr|cn|tw)|iso-2022-(?:jp|kr|cn)(?:-\d)?|ks_c_5601-1987|macintosh)$/i;

interface Header {
  name: string;
  value: string;
}
interface Inspection {
  parts: number;
}
type Refusal = string | undefined;

/**
 * Gmail decodes a message's `raw` field itself (base64url RFC 2822), so the
 * hatch's ordinary admission sees only its encoding. Decode the documented
 * field once, bounded by its own length, then every MIME entity's transfer
 * encoding, header encoded words and attached message, and refuse a withheld
 * destination before anything is sent. Charsets, transfer encodings and
 * nesting this bounded parse cannot read as a client would are refused.
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
  const source = latin1(bytes);
  if (carriesWithheldLink(utf8(source))) return WITHHELD;
  return inspectEntity(source, 0, "text/plain", { parts: 0 });
}

function inspectEntity(source: string, depth: number, defaultType: string, seen: Inspection): Refusal {
  if (depth > MAX_MIME_DEPTH) return `Not sent: this raw message nests MIME deeper than ${MAX_MIME_DEPTH} levels.`;
  if (++seen.parts > MAX_MIME_PARTS) return `Not sent: this raw message has more than ${MAX_MIME_PARTS} MIME parts.`;
  const { headers, head, body } = splitEntity(source);
  if (BARE_CR.test(head)) return "Not sent: a raw message header block has a carriage return without a line feed.";
  for (const header of headers) {
    const decoded = decodeEncodedWords(header.value);
    if (decoded === undefined)
      return "Not sent: a raw message header uses an encoded word this connection cannot read.";
    if (carriesWithheldLink(decoded)) return WITHHELD;
  }
  const contentTypes = headers.filter((header) => header.name === "content-type");
  const encodings = headers.filter((header) => header.name === "content-transfer-encoding");
  if (contentTypes.length > 1 || encodings.length > 1)
    return "Not sent: a raw message part repeats Content-Type or Content-Transfer-Encoding.";
  const contentType = contentTypes[0] ? parseContentType(contentTypes[0].value) : { type: defaultType, params: {} };
  if (!contentType) return "Not sent: a raw message part has a Content-Type this connection cannot read.";
  const encoding = (encodings[0]?.value ?? "7bit").trim().toLowerCase();
  const charset = contentType.params["charset"];
  if (charset !== undefined && !ASCII_CHARSETS.test(charset))
    return `Not sent: a raw message part declares charset ${JSON.stringify(charset.slice(0, 40))}, which this connection cannot inspect.`;
  if (contentType.type.startsWith("multipart/")) {
    if (!["7bit", "8bit", "binary"].includes(encoding))
      return "Not sent: a raw multipart must use a 7bit, 8bit or binary transfer encoding.";
    const boundary = contentType.params["boundary"];
    if (!boundary) return "Not sent: a raw multipart has no boundary this connection can read.";
    if (BARE_CR.test(body)) return "Not sent: a raw multipart has a carriage return without a line feed.";
    const childType = contentType.type === "multipart/digest" ? "message/rfc822" : "text/plain";
    const { text, parts } = splitMultipart(body, boundary);
    if (text.some((section) => carriesWithheldLink(utf8(section)))) return WITHHELD;
    for (const part of parts) {
      const refusal = inspectEntity(part, depth + 1, childType, seen);
      if (refusal) return refusal;
    }
    return undefined;
  }
  const content = decodeTransfer(body, encoding);
  if (content === undefined)
    return `Not sent: a raw message part uses transfer encoding ${JSON.stringify(encoding.slice(0, 40))}, which this connection cannot inspect.`;
  if (carriesWithheldLink(utf8(content))) return WITHHELD;
  if (contentType.type === "message/rfc822" || contentType.type === "message/global")
    return inspectEntity(content, depth + 1, "text/plain", seen);
  return undefined;
}

function splitEntity(source: string): { headers: Header[]; head: string; body: string } {
  const lines = source.split(/(?<=\n)/);
  const headers: Header[] = [];
  let offset = 0;
  for (const line of lines) {
    offset += line.length;
    const content = line.replace(/\r?\n$/, "");
    if (content === "") return { headers, head: source.slice(0, offset), body: source.slice(offset) };
    const last = headers.at(-1);
    if (/^[ \t]/.test(content) && last) {
      last.value += content;
      continue;
    }
    const colon = content.indexOf(":");
    if (colon > 0)
      headers.push({ name: content.slice(0, colon).trim().toLowerCase(), value: content.slice(colon + 1) });
  }
  return { headers, head: source, body: "" };
}

function parseContentType(value: string): { type: string; params: Record<string, string> } | undefined {
  const [media = "", ...rest] = splitParams(value);
  const type = media.trim().toLowerCase();
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type)) return undefined;
  const params: Record<string, string> = Object.create(null);
  for (const param of rest) {
    const equals = param.indexOf("=");
    if (equals < 0) continue;
    const name = param.slice(0, equals).trim().toLowerCase();
    if (!/^[a-z0-9!#$&^_.+-]+$/.test(name) || params[name] !== undefined) return undefined;
    let raw = param.slice(equals + 1).trim();
    if (raw.startsWith('"')) {
      if (!raw.endsWith('"') || raw.length < 2) return undefined;
      raw = raw.slice(1, -1).replace(/\\(.)/g, "$1");
    }
    params[name] = raw;
  }
  return { type, params };
}

function splitParams(value: string): string[] {
  const params: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < value.length; index++) {
    const character = value[index]!;
    if (quoted && character === "\\") {
      current += character + (value[++index] ?? "");
      continue;
    }
    if (character === '"') quoted = !quoted;
    if (character === ";" && !quoted) {
      params.push(current);
      current = "";
    } else current += character;
  }
  params.push(current);
  return params;
}

function splitMultipart(body: string, boundary: string): { text: string[]; parts: string[] } {
  const delimiter = `--${boundary}`;
  const sections: string[] = [];
  let current: string[] = [];
  let closed = false;
  for (const line of body.split(/(?<=\n)/)) {
    const content = line.replace(/\r?\n$/, "").replace(/[ \t]+$/, "");
    if (!closed && (content === delimiter || content === `${delimiter}--`)) {
      sections.push(current.join(""));
      current = [];
      closed = content !== delimiter;
    } else current.push(line);
  }
  const rest = current.join("");
  if (sections.length === 0) return { text: [rest], parts: [] };
  const [preamble = "", ...parts] = sections;
  return closed ? { text: [preamble, rest], parts } : { text: [preamble], parts: [...parts, rest] };
}

function decodeTransfer(body: string, encoding: string): string | undefined {
  if (encoding === "7bit" || encoding === "8bit" || encoding === "binary") return body;
  if (encoding === "base64") {
    const compact = body.replace(/[\r\n\t ]+/g, "");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 === 1) return undefined;
    try {
      return atob(compact);
    } catch {
      return undefined;
    }
  }
  if (encoding === "quoted-printable") return decodeQuotedPrintable(body);
  return undefined;
}

function decodeQuotedPrintable(body: string): string {
  return body.replace(/=(?:[ \t]*\r?\n|([0-9A-Fa-f]{2}))/g, (_token, hex: string | undefined) =>
    hex === undefined ? "" : String.fromCharCode(parseInt(hex, 16)),
  );
}

function decodeEncodedWords(value: string): string | undefined {
  let unreadable = false;
  const decoded = value.replace(
    /=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g,
    (_token, charset: string, kind: string, text: string) => {
      const name = charset.split("*")[0]!;
      if (!ASCII_CHARSETS.test(name)) {
        unreadable = true;
        return "";
      }
      if (kind.toUpperCase() === "Q") return decodeQuotedPrintable(text.replace(/_/g, " "));
      const content = decodeTransfer(text, "base64");
      if (content === undefined) unreadable = true;
      return content ?? "";
    },
  );
  return unreadable ? undefined : utf8(decoded);
}

function latin1(bytes: Uint8Array): string {
  let text = "";
  for (let at = 0; at < bytes.length; at += 0x8000) text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return text;
}

function utf8(binary: string): string {
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return new TextDecoder().decode(bytes);
}
