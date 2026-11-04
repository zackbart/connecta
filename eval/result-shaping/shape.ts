/**
 * Eval-only result presentation arms (#703 result-shaping study). Nothing here
 * is reachable from a package entry or configuration: the Worker eval composition
 * installs a presenter on a per-isolate global, and `--result-arm` refuses every
 * other target. Programs, value mode, writes and failures never reach it.
 *
 * Arms:
 *  - lean: a direct read's JSON loses null and empty object properties and any
 *    whitespace, with a one-line disclosure in a second text block.
 *  - preview: a direct read whose rows or text exceed a threshold returns a
 *    retained resultId, row count, keys and whole first rows in the value's own
 *    shape, instead of the first 24,000 bytes cut through the middle of the JSON.
 *
 * Invariant for both: what is shown is a structural subset of the value a
 * program sees. Every path and value shown exists identically there, so code
 * written from the view runs against the data.
 */
const RESULT_ARMS = ["control", "lean", "preview", "lean-preview"] as const;
export type ResultArm = (typeof RESULT_ARMS)[number];

export function parseResultArm(value = "control"): ResultArm {
  if (!(RESULT_ARMS as readonly string[]).includes(value))
    throw new Error(`--result-arm must be one of ${RESULT_ARMS.join(", ")}`);
  return value as ResultArm;
}

/** Rows are previewed above this many bytes; smaller lists stay whole. */
export const PREVIEW_ROW_THRESHOLD = 4_096;
/** Plain text is previewed above this many bytes. */
const PREVIEW_TEXT_THRESHOLD = 8_192;
/** Bytes of whole rows a preview shows. */
export const PREVIEW_ROW_BYTES = 1_500;
const PREVIEW_HEAD_BYTES = 1_200;
const PREVIEW_TAIL_BYTES = 800;
const MAX_KEYS = 40;
/** Top-level non-row values stay whole up to this; beyond it they are named. */
const MAX_REST_BYTES = 1_024;
/** Below this saving lean returns the original text. Low on purpose: the study tests harm on real nulls. */
const LEAN_MIN_SAVING = 16;

const enc = new TextEncoder();
const bytesOf = (text: string) => enc.encode(text).length;

/** Never dropped, at any depth: continuation, totals, state and failure facts. */
const PROTECTED =
  /^(next|next_?cursor|next_?page|next_?offset|next_?page_?token|has_?more|cursor|offset|limit|total|total_?count|count|page|warnings?|errors?|error_?code|ok|status|state|value|values|format|truncated|result_?id)$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  return isRecord(value) && Object.keys(value).length === 0;
}

/**
 * A number JSON.parse would round. A false positive inside a string only skips
 * shaping, which is the safe direction.
 */
const UNSAFE_NUMBER = /[:[,]\s*-?\d{16,}/;

function parseSafely(text: string): unknown {
  if (UNSAFE_NUMBER.test(text)) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Drop null and "" properties below the root, and empty arrays or objects
 * only inside a row or at depth three and below, so `items: []` and
 * `data.data: []` still say that nothing matched. Array elements are never
 * dropped: positions carry meaning in rows of cells. false and 0 are values.
 */
export function leanValue(value: unknown): { value: unknown; dropped: number } {
  let dropped = 0;
  const walk = (node: unknown, depth: number, inArray: boolean): unknown => {
    if (Array.isArray(node)) return node.map((item) => walk(item, depth, true));
    if (!isRecord(node)) return node;
    const entries: [string, unknown][] = [];
    for (const [key, child] of Object.entries(node)) {
      const next = walk(child, depth + 1, inArray);
      const droppable =
        depth >= 1 &&
        !PROTECTED.test(key) &&
        isEmpty(next) &&
        (child === null || child === "" || inArray || depth >= 2);
      if (droppable) dropped++;
      else entries.push([key, next]);
    }
    return Object.fromEntries(entries);
  };
  return { value: walk(value, 0, false), dropped };
}

export interface LeanPresentation {
  text: string;
  note: string;
  dropped: number;
}

export function presentLean(text: string): LeanPresentation | undefined {
  const parsed = parseSafely(text);
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const { value, dropped } = leanValue(parsed);
  const shaped = JSON.stringify(value);
  if (bytesOf(text) - bytesOf(shaped) < LEAN_MIN_SAVING) return undefined;
  return {
    text: shaped,
    dropped,
    note: dropped
      ? "connecta: null and empty properties are omitted from this view; execute_code sees the exact value."
      : "connecta: whitespace removed from this view.",
  };
}

interface RowsLocation {
  path: string[];
  rows: unknown[];
  bytes: number;
}

/** The largest list of records within three keys of the root. */
function dominantRows(root: unknown): RowsLocation | undefined {
  let best: RowsLocation | undefined;
  const visit = (node: unknown, path: string[]) => {
    if (Array.isArray(node)) {
      if (node.length >= 3 && node.every((row) => (isRecord(row) || Array.isArray(row)) && row !== null)) {
        const bytes = bytesOf(JSON.stringify(node));
        if (!best || bytes > best.bytes) best = { path, rows: node, bytes };
      }
      return;
    }
    if (!isRecord(node) || path.length >= 3) return;
    for (const [key, child] of Object.entries(node)) visit(child, [...path, key]);
  };
  visit(root, []);
  return best;
}

function replaceAt(root: unknown, path: readonly string[], rows: unknown[]): unknown {
  if (!path.length) return rows;
  const [head, ...tail] = path;
  const record = root as Record<string, unknown>;
  return { ...record, [head!]: replaceAt(record[head!], tail, rows) };
}

function rowKeys(rows: readonly unknown[]): string[] {
  const keys = new Set<string>();
  for (const row of rows.slice(0, 50)) if (isRecord(row)) for (const key of Object.keys(row)) keys.add(key);
  return [...keys].slice(0, MAX_KEYS);
}

function accessor(path: readonly string[]): string {
  return path.map((key) => (/^[A-Za-z_$][\w$]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`)).join("");
}

function readAll(id: string): string {
  return `let text = "", offset = 0, page; do { page = await connecta.result(${JSON.stringify(id)}, { offset, maxBytes: 16000 }); text += page.text; offset = page.nextOffset; } while (page.hasMore);`;
}

export interface PreviewPresentation {
  /** Replaces the page hint in the truncation notice. */
  hint: string;
  /** Extra notice fields; every value is structure, counts or key names. */
  fields: Record<string, unknown>;
  /** What follows the notice line. */
  body: string;
  /** The program a notice offers, for a retained id. */
  program(id: string): string;
}

function rowsPreview(text: string, parsed: unknown, total: number): PreviewPresentation | undefined {
  const found = dominantRows(parsed);
  // A record or document is read whole: a preview cannot stand in for its fields.
  if (!found || found.bytes * 2 < total || total <= PREVIEW_ROW_THRESHOLD) return undefined;
  const shown: unknown[] = [];
  let used = 0;
  for (const row of found.rows) {
    const size = bytesOf(JSON.stringify(row)) + 1;
    if (shown.length && used + size > PREVIEW_ROW_BYTES) break;
    if (!shown.length && size > PREVIEW_ROW_BYTES * 2) break;
    shown.push(row);
    used += size;
  }
  const body = JSON.stringify(replaceAt(parsed, found.path, shown));
  if (bytesOf(body) - used > MAX_REST_BYTES) return undefined;
  const count = found.rows.length;
  const keys = rowKeys(found.rows);
  const path = found.path.join(".") || "(root)";
  return {
    hint: `${count} rows at ${path}; the first ${shown.length} follow, in the result's own shape, with every value outside the list. All rows are retained: run nextAction, editing its last line to filter, join or count them, instead of repeating this read or reading pages by hand.`,
    fields: { rows: { path, count, shown: shown.length, keys } },
    body,
    program: (id) =>
      `async () => { ${readAll(id)} const rows = JSON.parse(text)${accessor(found.path)}; return { count: rows.length, rows: rows.slice(0, 5) }; }`,
  };
}

function textPreview(text: string, total: number): PreviewPresentation | undefined {
  if (total <= PREVIEW_TEXT_THRESHOLD) return undefined;
  const bytes = enc.encode(text);
  const dec = new TextDecoder();
  const head = dec.decode(bytes.subarray(0, PREVIEW_HEAD_BYTES)).replace(/�$/, "");
  const tail = dec.decode(bytes.subarray(total - PREVIEW_TAIL_BYTES)).replace(/^�/, "");
  const lines = text.split("\n").length;
  return {
    hint: `${lines} lines. The head and tail follow, with the middle omitted. All of it is retained: run nextAction, editing its last line to search for what you need, instead of repeating this read or reading pages by hand.`,
    fields: { text: { lines, shownBytes: PREVIEW_HEAD_BYTES + PREVIEW_TAIL_BYTES } },
    body: `${head}\n…[${total - PREVIEW_HEAD_BYTES - PREVIEW_TAIL_BYTES} bytes omitted]…\n${tail}`,
    program: (id) =>
      `async () => { ${readAll(id)} const lines = text.split("\\n"); return { lines: lines.length, matches: lines.filter((line) => /error|fail/i.test(line)).slice(0, 40) }; }`,
  };
}

/** A preview for a read over a threshold, or undefined to use the ordinary guard. */
export function presentPreview(text: string): PreviewPresentation | undefined {
  const total = bytesOf(text);
  if (total <= PREVIEW_ROW_THRESHOLD) return undefined;
  const parsed = parseSafely(text);
  if (typeof parsed === "object" && parsed !== null) return rowsPreview(text, parsed, total);
  // JSON that parsed to a scalar, or whose numbers cannot round-trip, stays whole.
  if (parsed !== undefined || UNSAFE_NUMBER.test(text)) return undefined;
  return textPreview(text, total);
}

/** The eval-only seam src/meta-tools.ts reads. */
interface ResultPresenter {
  arm: ResultArm;
  lean?: (text: string) => LeanPresentation | undefined;
  preview?: (text: string) => PreviewPresentation | undefined;
}

function presenterFor(arm: ResultArm): ResultPresenter | undefined {
  if (arm === "control") return undefined;
  return {
    arm,
    ...(arm === "lean" || arm === "lean-preview" ? { lean: presentLean } : {}),
    ...(arm === "preview" || arm === "lean-preview" ? { preview: presentPreview } : {}),
  };
}

const PRESENTER = Symbol.for("connecta.eval.resultPresenter");

/** Per isolate. The Worker eval composition calls this once before createConnecta. */
export function installResultPresenter(arm: ResultArm): void {
  (globalThis as Record<symbol, unknown>)[PRESENTER] = presenterFor(arm);
}
