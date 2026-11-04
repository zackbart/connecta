/**
 * Schema-aware views of direct reads past their cap, as pure functions of redacted
 * text. Presentation only: the stash and what a program sees stay byte-identical
 * to the full result, and everything shown here also appears in it, unchanged.
 * Rules: documentation/meta-tools.md#previews-of-reads-over-the-cap.
 */
const enc = new TextEncoder();
const dec = new TextDecoder();

/** Bytes of whole rows a view shows. */
const ROW_BYTES = 1_500;
/** One row can pass ROW_BYTES up to this, so a wide list still shows its shape. */
const FIRST_ROW_BYTES = 3_000;
/** Everything outside the list stays whole, or the read is not a list. */
const REST_BYTES = 1_024;
const TEXT_HEAD_BYTES = 1_200;
const TEXT_TAIL_BYTES = 800;
const MIN_ROWS = 3;
const MAX_ROW_DEPTH = 3;
const MAX_KEYS = 40;
const MAX_KEY_CHARS = 64;
/** Rows sampled for key names. */
const KEY_SAMPLE_ROWS = 50;

export interface ResultPreview {
  /** Notice fields of this view: counts and key names, never values. */
  fields: { rows: RowsSummary } | { text: { lines: number; shownBytes: number } };
  /** Valid JSON in the result's own shape, or the head and tail of its text. */
  body: string;
  /** Opens the hint: what `body` holds and what it leaves out. */
  shown: string;
  /** What the offered program holds, for the hint. */
  noun: "rows" | "text";
  /** The body of an async program, after the retained text is read into `text`. */
  reduce: string;
}

interface RowsSummary {
  path: string;
  count: number;
  shown: number;
  keys: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const byteLength = (text: string) => enc.encode(text).length;

interface RowsLocation {
  path: string[];
  rows: unknown[];
  bytes: number;
}

/** The largest list of records within MAX_ROW_DEPTH keys of the root. */
function dominantRows(root: unknown): RowsLocation | undefined {
  let best: RowsLocation | undefined;
  const visit = (node: unknown, path: string[]) => {
    if (Array.isArray(node)) {
      if (node.length >= MIN_ROWS && node.every((row) => isRecord(row) || Array.isArray(row))) {
        const bytes = byteLength(JSON.stringify(node));
        if (!best || bytes > best.bytes) best = { path, rows: node, bytes };
      }
      return;
    }
    if (!isRecord(node) || path.length >= MAX_ROW_DEPTH) return;
    for (const key of Object.keys(node)) visit(node[key], [...path, key]);
  };
  visit(root, []);
  return best;
}

function withRows(root: unknown, path: readonly string[], rows: unknown[]): unknown {
  if (!path.length) return rows;
  const [head, ...tail] = path as [string, ...string[]];
  const record = root as Record<string, unknown>;
  // Computed keys define own properties, so a key named __proto__ stays data.
  return { ...record, [head]: withRows(record[head], tail, rows) };
}

function rowKeys(rows: readonly unknown[]): string[] {
  const keys = new Set<string>();
  for (const row of rows.slice(0, KEY_SAMPLE_ROWS)) {
    if (!isRecord(row)) continue;
    for (const key of Object.keys(row)) if (key.length <= MAX_KEY_CHARS) keys.add(key);
    if (keys.size >= MAX_KEYS) break;
  }
  return [...keys].slice(0, MAX_KEYS);
}

/** JavaScript that reads `path` from a parsed value; a program runs it, so it must be exact. */
function accessor(path: readonly string[]): string {
  return path.map((key) => (/^[A-Za-z_$][\w$]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`)).join("");
}

function rowsPreview(parsed: object, total: number, cap: number): ResultPreview | undefined {
  const found = dominantRows(parsed);
  if (!found || found.bytes * 2 < total) return undefined;
  // The bytes outside the list; the ways it can be spelled do not change them.
  const rest = byteLength(JSON.stringify(withRows(parsed, found.path, [])));
  if (rest > REST_BYTES) return undefined;
  const firstRowBytes = Math.min(FIRST_ROW_BYTES, cap - rest);
  const rowBytes = Math.min(ROW_BYTES, cap - rest);
  const shown: unknown[] = [];
  let used = 0;
  for (const row of found.rows) {
    const size = byteLength(JSON.stringify(row)) + 1;
    if (used + size > (shown.length ? rowBytes : firstRowBytes)) break;
    shown.push(row);
    used += size;
  }
  const count = found.rows.length;
  // An empty list would read as a list with no rows, and a whole one needs no sample.
  if (!shown.length || shown.length === count) return undefined;
  const keys = rowKeys(found.rows);
  const path = found.path.length ? accessor(found.path).replace(/^\./, "") : "(root)";
  const body = JSON.stringify(withRows(parsed, found.path, shown));
  if (byteLength(body) > cap) return undefined;
  return {
    fields: { rows: { path, count, shown: shown.length, keys } },
    body,
    shown: `Sample only: ${shown.length === 1 ? "row 1" : `rows 1-${shown.length}`} of ${count} at ${path} follow, in the result's own shape, with every value outside the list; the other ${count - shown.length} are not shown.`,
    noun: "rows",
    reduce: `const rows = JSON.parse(text)${accessor(found.path)}; return { count: rows.length, rows: rows.slice(0, 5) };`,
  };
}

function lineCount(text: string): number {
  let lines = 1;
  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) lines++;
  return lines;
}

/** Whether a byte continues a UTF-8 character rather than starting one. */
const continues = (byte: number | undefined) => byte !== undefined && (byte & 0xc0) === 0x80;

function textPreview(text: string, reading: string, cap: number): ResultPreview | undefined {
  const bytes = enc.encode(text);
  if (bytes.length <= TEXT_HEAD_BYTES + TEXT_TAIL_BYTES) return undefined;
  const marker = (omitted: number) => `\n…[${omitted} bytes omitted]…\n`;
  let headEnd = TEXT_HEAD_BYTES;
  while (continues(bytes[headEnd])) headEnd--;
  let tailStart = bytes.length - TEXT_TAIL_BYTES;
  while (continues(bytes[tailStart])) tailStart++;
  const shownBytes = headEnd + bytes.length - tailStart;
  const body = `${dec.decode(bytes.subarray(0, headEnd))}${marker(tailStart - headEnd)}${dec.decode(bytes.subarray(tailStart))}`;
  if (byteLength(body) > cap) return undefined;
  const lines = lineCount(text);
  return {
    fields: { text: { lines, shownBytes } },
    body,
    shown: `Sample only: the first ${headEnd} and last ${bytes.length - tailStart} bytes of ${lines} lines follow; the ${tailStart - headEnd} bytes between them are not shown.`,
    noun: "text",
    reduce: `const lines = ${reading}.split("\\n"); return { lines: lines.length, matches: lines.filter((line) => /error|fail/i.test(line)).map((line) => line.slice(0, 500)).slice(0, 40) };`,
  };
}

/** Parts of a JSON number token whose exact value is the same however it is spelled. */
function exactValue(token: string): string | undefined {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token);
  if (!match) return undefined;
  const fraction = match[3] ?? "";
  const digits = `${match[2]}${fraction}`;
  let start = 0;
  let end = digits.length;
  while (digits[start] === "0") start++;
  while (end > start && digits[end - 1] === "0") end--;
  if (start === end) return `${match[1]}0`;
  return `${match[1]}${digits.slice(start, end)}e${Number(match[4] ?? 0) - fraction.length + digits.length - end}`;
}

/** Whether JSON.parse then JSON.stringify keeps this token's value, including its sign and range. */
function keepsNumber(token: string): boolean {
  const printed = String(Number(token));
  return printed === token || exactValue(printed) === exactValue(token);
}

/**
 * Whether every number in text JSON.parse has already accepted survives parsing.
 * Both a view and the offered program parse it, so one lossy number anywhere,
 * inside or outside the rows, declines the view. Strings are skipped, not read.
 */
function keepsNumbers(json: string): boolean {
  let at = 0;
  while (at < json.length) {
    const code = json.charCodeAt(at);
    if (code === 34) {
      at++;
      while (json.charCodeAt(at) !== 34) at += json.charCodeAt(at) === 92 ? 2 : 1;
      at++;
    } else if (code === 45 || (code >= 48 && code <= 57)) {
      const start = at;
      while (at < json.length && "+-.0123456789Ee".includes(json[at]!)) at++;
      if (!keepsNumber(json.slice(start, at))) return false;
    } else at++;
  }
  return true;
}

/**
 * The view of a read past its cap, or undefined when its first bytes should stand:
 * documents, scalars, shallow or deep lists a view would misstate, and numbers
 * parsing would change.
 *
 * `format` is the result's own: an API connector's text arrives here as one
 * JSON string, whose decoded text is what a person would call the result.
 */
export function previewResult(text: string, format: "json" | "text", cap: number): ResultPreview | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return textPreview(text, "text", cap);
  }
  if (typeof parsed === "string" && format === "text") return textPreview(parsed, "JSON.parse(text)", cap);
  if (typeof parsed !== "object" || parsed === null || !keepsNumbers(text)) return undefined;
  return rowsPreview(parsed, byteLength(text), cap);
}
