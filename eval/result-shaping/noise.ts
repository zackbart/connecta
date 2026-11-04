/**
 * Eval-only byte classifier for tool results. Every compact-JSON byte of a
 * parsed result lands in exactly one exclusive class (first match wins), so the
 * classes add up to the compact size. `repeatedKeyBytes` and `duplicateBytes`
 * overlap the classes: they estimate what structure sharing could save.
 *
 * Erasable TypeScript only, so `node` can run this directly on another machine.
 */
type NoiseClass =
  | "framing"
  | "nullsEmpties"
  | "falseZeroDefaults"
  | "urlValues"
  | "linkBlocks"
  | "auditFields"
  | "vendorTags"
  | "htmlDuplicates"
  | "payload";

export interface NoiseReport {
  /** Bytes of the text as delivered. */
  rawBytes: number;
  /** Bytes of JSON.stringify(JSON.parse(text)); zero when the text was not JSON. */
  compactBytes: number;
  /** rawBytes - compactBytes, for JSON: whitespace spent on pretty printing. */
  whitespaceBytes: number;
  json: boolean;
  classes: Record<NoiseClass, number>;
  /** Key name bytes in array rows after a row that already named that key. */
  repeatedKeyBytes: number;
  /** Bytes of objects whose canonical form already appeared earlier in the value. */
  duplicateBytes: number;
  /** Leaf bytes at depth five or deeper (the first array of rows is depth two). */
  deepBytes: number;
  rows: number;
}

const enc = new TextEncoder();
const size = (value: unknown) => enc.encode(JSON.stringify(value) ?? "").length;

/** Blocks whose whole subtree exists to describe other resources or the API. */
const LINK_BLOCK = /^(_links|links|_embedded|relationships|included|meta|_meta|pagination|paging|pageInfo|page_info)$/i;
const URL_KEY = /(^|_)(url|uri|href|html_url|avatar|avatar_url|thumbnail)$|Url$|Uri$|Href$/;
const AUDIT_KEY =
  /^(created|updated|modified|deleted|archived|last_?modified|inserted)(_?at|_?on|_?date|_?time|_?by|_?ts|_?timestamp|_?by_id)?$|^(createdBy|updatedBy|modifiedBy|etag|node_id|nodeId|gravatar_id|version|revision|__v|livemode|object|kind)$/i;
const HTML_VALUE = /<\/?(p|div|span|br|table|html|body|a|ul|li|h[1-6]|img|td|tr)\b[^>]*>/i;
const URL_VALUE = /^https?:\/\/\S+$/;
const HTML_KEY = /(^|_)(html|body_html|bodyHtml|html_body|rendered)$|Html$/;

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  return typeof value === "object" && Object.keys(value as object).length === 0;
}

function classOf(key: string, value: unknown): NoiseClass | undefined {
  if (isEmpty(value)) return "nullsEmpties";
  if (LINK_BLOCK.test(key)) return "linkBlocks";
  if (HTML_KEY.test(key)) return "htmlDuplicates";
  if (typeof value === "string" && HTML_VALUE.test(value)) return "htmlDuplicates";
  if (AUDIT_KEY.test(key))
    return key === "object" || key === "kind" || key === "livemode" ? "vendorTags" : "auditFields";
  if (typeof value === "string" && (URL_KEY.test(key) || URL_VALUE.test(value))) return "urlValues";
  if (value === false || value === 0) return "falseZeroDefaults";
  return undefined;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value as object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export function classifyResult(text: string): NoiseReport {
  const rawBytes = enc.encode(text).length;
  const classes: Record<NoiseClass, number> = {
    framing: 0,
    nullsEmpties: 0,
    falseZeroDefaults: 0,
    urlValues: 0,
    linkBlocks: 0,
    auditFields: 0,
    vendorTags: 0,
    htmlDuplicates: 0,
    payload: 0,
  };
  const report: NoiseReport = {
    rawBytes,
    compactBytes: 0,
    whitespaceBytes: 0,
    json: false,
    classes,
    repeatedKeyBytes: 0,
    duplicateBytes: 0,
    deepBytes: 0,
    rows: 0,
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    classes.payload = rawBytes;
    return report;
  }
  if (typeof parsed !== "object" || parsed === null) {
    classes.payload = rawBytes;
    return report;
  }
  report.json = true;
  report.compactBytes = size(parsed);
  report.whitespaceBytes = rawBytes - report.compactBytes;
  const seen = new Set<string>();
  const assigned = { total: 0 };
  const count = (name: NoiseClass, bytes: number, depth: number) => {
    classes[name] += bytes;
    assigned.total += bytes;
    if (depth >= 5) report.deepBytes += bytes;
  };
  const walk = (value: unknown, depth: number, rowKeys?: Set<string>): void => {
    if (Array.isArray(value)) {
      const shared = new Set<string>();
      if (value.some((item) => item && typeof item === "object" && !Array.isArray(item))) report.rows += value.length;
      count("framing", 2 + Math.max(0, value.length - 1), depth);
      for (const item of value) walk(item, depth + 1, shared);
      return;
    }
    if (value && typeof value === "object") {
      const entries = Object.entries(value as Record<string, unknown>);
      const form = canonical(value);
      if (entries.length > 1) {
        if (seen.has(form)) report.duplicateBytes += size(value);
        else seen.add(form);
      }
      count("framing", 2 + Math.max(0, entries.length - 1), depth);
      for (const [key, child] of entries) {
        const keyBytes = size(key) + 1;
        if (rowKeys) {
          if (rowKeys.has(key)) report.repeatedKeyBytes += keyBytes;
          else rowKeys.add(key);
        }
        const label = classOf(key, child);
        if (label) count(label, keyBytes + size(child), depth);
        else {
          count("payload", keyBytes, depth);
          walk(child, depth + 1);
        }
      }
      return;
    }
    count("payload", size(value), depth);
  };
  walk(parsed, 0);
  // Top-level containers, separators and escapes the walk rounds differently.
  classes.framing += report.compactBytes - assigned.total;
  return report;
}

/** Sum a set of reports into one, for tables. */
export function mergeReports(reports: readonly NoiseReport[]): NoiseReport & { results: number; jsonResults: number } {
  const total = classifyResult("");
  const merged = { ...total, results: reports.length, jsonResults: 0 };
  for (const report of reports) {
    merged.rawBytes += report.rawBytes;
    merged.compactBytes += report.compactBytes;
    merged.whitespaceBytes += report.whitespaceBytes;
    merged.repeatedKeyBytes += report.repeatedKeyBytes;
    merged.duplicateBytes += report.duplicateBytes;
    merged.deepBytes += report.deepBytes;
    merged.rows += report.rows;
    if (report.json) merged.jsonResults++;
    for (const key of Object.keys(report.classes) as NoiseClass[]) merged.classes[key] += report.classes[key];
  }
  return merged;
}
