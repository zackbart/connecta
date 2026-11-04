/**
 * Schema-aware views of large direct reads, as pure functions of redacted text.
 * Presentation only: the stash and what a program sees stay byte-identical to
 * the full result, and everything shown here also appears in it, unchanged.
 * Rules and their evidence: documentation/meta-tools.md#previews-of-large-reads.
 */
const enc = new TextEncoder();
const dec = new TextDecoder();

/** Lists smaller than this stay whole. */
const ROW_THRESHOLD_BYTES = 4_096;
/** Plain text smaller than this stays whole. */
const TEXT_THRESHOLD_BYTES = 8_192;
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
/** A view must at least halve the context a read costs to be worth a stash and a program. */
const MIN_SAVING_RATIO = 2;
/** The notice's own bytes, before key names, for the saving check above. */
const NOTICE_BYTES = 700;

/** JSON.parse would round a number this long. A match inside a string only skips the view. */
const UNSAFE_NUMBER = /[:[,]\s*-?\d{16,}/;

export interface ResultPreview {
  /** Notice fields of this view: counts and key names, never values. */
  fields: { rows: RowsSummary } | { text: { lines: number; shownBytes: number } };
  /** Valid JSON in the result's own shape, or the head and tail of its text. */
  body: string;
  /** Opens the hint: what `body` is. */
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
  // An empty list here would read as a list with no rows: never show one.
  if (!shown.length) return undefined;
  const count = found.rows.length;
  const keys = rowKeys(found.rows);
  const path = found.path.length ? accessor(found.path).replace(/^\./, "") : "(root)";
  const body = JSON.stringify(withRows(parsed, found.path, shown));
  if (byteLength(body) > cap) return undefined;
  const notice = NOTICE_BYTES + byteLength(path) + byteLength(JSON.stringify(keys));
  if ((byteLength(body) + notice) * MIN_SAVING_RATIO > total) return undefined;
  return {
    fields: { rows: { path, count, shown: shown.length, keys } },
    body,
    shown: `${count} rows at ${path}; the first ${shown.length} follow, in the result's own shape, with every value outside the list.`,
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
    shown: `${lines} lines; the head and tail follow, with the middle omitted.`,
    noun: "text",
    reduce: `const lines = ${reading}.split("\\n"); return { lines: lines.length, matches: lines.filter((line) => /error|fail/i.test(line)).map((line) => line.slice(0, 500)).slice(0, 40) };`,
  };
}

/**
 * The view of a read over a threshold, or undefined when today's path should
 * handle it: documents, scalars, small or deep lists and unsafe numbers.
 *
 * `format` is the result's own: an API connector's text arrives here as one
 * JSON string, whose decoded text is what a person would call the result.
 */
export function previewResult(text: string, format: "json" | "text", cap: number): ResultPreview | undefined {
  const total = byteLength(text);
  if (total <= ROW_THRESHOLD_BYTES) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return total > TEXT_THRESHOLD_BYTES ? textPreview(text, "text", cap) : undefined;
  }
  if (typeof parsed === "string" && format === "text") {
    return byteLength(parsed) > TEXT_THRESHOLD_BYTES ? textPreview(parsed, "JSON.parse(text)", cap) : undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  if (UNSAFE_NUMBER.test(text) || hasNonFinite(parsed)) return undefined;
  return rowsPreview(parsed, total, cap);
}

/** JSON.parse reads 1e999 as Infinity, which JSON.stringify would then write as null. */
function hasNonFinite(root: object): boolean {
  const stack: unknown[] = [root];
  while (stack.length) {
    const node = stack.pop();
    if (typeof node === "number" && !Number.isFinite(node)) return true;
    if (typeof node === "object" && node !== null) for (const child of Object.values(node)) stack.push(child);
  }
  return false;
}
