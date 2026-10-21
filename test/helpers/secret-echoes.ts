// Sent secrets echoed where connecta cuts downstream text short: every form
// SentSecrets registers, placed across the cut, and a check that decodes the
// result itself rather than trusting redaction's own list of forms.
import { expect } from "vitest";

/** Contains `/`, `+` and `=`, so its percent and base64url forms differ from the raw and base64 ones. */
export const SECRET = "ya29.echoed/delegated+token=value-0123456789";

function base64(value: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Every form SentSecrets registers for a sent value, as a vendor might echo it, by name. */
export function echoForms(value: string): [name: string, form: string][] {
  const percent = encodeURIComponent(value);
  const encoded = base64(value);
  const escaped = value
    .split("")
    .map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)
    .join("");
  const forms: [string, string][] = [
    ["raw", value],
    ["percent (upper hex)", percent],
    ["percent (lower hex)", percent.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase())],
    ["base64", encoded],
    ["base64url", encoded.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")],
    ["\\u-escaped (lower hex)", escaped],
    ["\\u-escaped (upper hex)", escaped.toUpperCase().replace(/\\U/g, "\\u")],
  ];
  return forms.filter(([, form], index) => forms.findIndex(([, other]) => other === form) === index);
}

/** The forms of an HTTP Basic pair a vendor might echo: its header value and the pair's base64. */
export function basicForms(user: string, password: string): [name: string, form: string][] {
  const pair = base64(`${user}:${password}`);
  return [
    ["Basic header", `Basic ${pair}`],
    ["Basic pair base64", pair],
    ["Basic pair base64url", pair.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")],
  ];
}

/** The part of `form` a cut keeps when the cut falls at its middle. */
export function head(form: string): string {
  return form.slice(0, Math.ceil(form.length / 2));
}

/** `form` after `x` filler, placed so that a cut at `cap` code units keeps its first `kept`
 * units, by default its first half. */
export function straddling(form: string, cap: number, kept = head(form).length): string {
  return `${"x".repeat(cap - kept)}${form} tail`;
}

/** `form` between `x` filler and a `z` tail, placed so that a cut to `maxBytes` of JSON, the
 * marker for what it dropped included, keeps the form's first half: the measure a Workspace
 * product cuts its fields by. */
export function straddlingJson(
  form: string,
  maxBytes: number,
  marker: (dropped: number) => string = () => "…",
): string {
  const escaped = (text: string) => new TextEncoder().encode(JSON.stringify(text)).length - 2;
  const after = ` ${"z".repeat(255)}`;
  const shown = escaped(marker(form.length - head(form).length + after.length));
  return `${"x".repeat(maxBytes - 2 - shown - escaped(head(form)))}${form}${after}`;
}

/** One layer of JSON string escapes, percent escapes (either hex case), or a base64 or
 * base64url run decoded at one of its four alignments. */
function decodings(text: string): string[] {
  const views = [
    text.replace(/\\(u[0-9a-fA-F]{4}|["\\/bfnrt])/g, (_, escape: string) =>
      escape.length > 1 ? String.fromCharCode(parseInt(escape.slice(1), 16)) : escape,
    ),
    text.replace(/%([0-9a-fA-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))),
  ];
  for (const run of text.match(/[A-Za-z0-9+/_-]{16,}/g) ?? []) {
    for (let offset = 0; offset < 4; offset++) {
      const aligned = run.slice(offset).replace(/-/g, "+").replace(/_/g, "/");
      try {
        views.push(atob(aligned.slice(0, aligned.length - (aligned.length % 4))));
      } catch {
        // Not base64 at this alignment.
      }
    }
  }
  return views.filter((view) => view !== text);
}

/** Whether `text`, decoded up to three layers deep, holds the first 12 units of `secret`. */
export function leaks(text: string, secret = SECRET): boolean {
  const start = secret.slice(0, 12);
  let layer = [text];
  for (let depth = 0; depth <= 3 && layer.length; depth++) {
    if (layer.some((view) => view.includes(start))) return true;
    layer = layer.flatMap(decodings);
  }
  return false;
}

/** The filler before an echo survived, and no part of the echoed form, nor the secret it
 * encodes, did: not the `kept` units a cut would keep, by default its first half. */
export function expectNoFragment(
  text: string,
  form: string,
  { secret = SECRET, kept = head(form).length }: { secret?: string; kept?: number } = {},
): void {
  expect(text).toContain("x".repeat(10));
  expect(text).not.toContain(`x${form.slice(0, kept)}`);
  expect(leaks(text, secret)).toBe(false);
}

/** Every view of `text` an agent could decode, three layers deep: JSON escapes, percent
 * escapes in either hex case, and base64 or base64url runs of `minRun` characters or more (by
 * default 11, eight bytes) at every alignment, read as bytes and as UTF-8. */
export function decodedViews(text: string, minRun = 11): string[] {
  const views = new Set([text]);
  let layer = [text];
  for (let depth = 0; depth < 3 && layer.length; depth++) {
    const next: string[] = [];
    for (const view of layer) {
      const decoded = [
        view.replace(/\\(u[0-9a-fA-F]{4}|["\\/bfnrt])/g, (_, escape: string) =>
          escape.length > 1 ? String.fromCharCode(parseInt(escape.slice(1), 16)) : escape,
        ),
        view.replace(/%([0-9a-fA-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))),
      ];
      for (const run of view.match(new RegExp(`[A-Za-z0-9+/_-]{${minRun},}`, "g")) ?? []) {
        for (let offset = 0; offset < 4; offset++) {
          const aligned = run.slice(offset).replace(/-/g, "+").replace(/_/g, "/");
          try {
            const bytes = atob(aligned.slice(0, aligned.length - (aligned.length % 4)));
            decoded.push(bytes, new TextDecoder().decode(Uint8Array.from(bytes, (unit) => unit.charCodeAt(0))));
          } catch {
            // Not base64 at this alignment.
          }
        }
      }
      for (const found of decoded) {
        if (views.has(found)) continue;
        views.add(found);
        next.push(found);
      }
    }
    layer = next;
  }
  return [...views];
}

/** The first run of `units` code units of `secret` that some decoded view of `text` holds,
 * found independently of redaction's own forms: the output-boundary guarantee's K. */
export function leakedRun(text: string, secret: string, units = 8): string | undefined {
  const views = decodedViews(text);
  for (let at = 0; at + units <= secret.length; at++) {
    const run = secret.slice(at, at + units);
    if (views.some((view) => view.includes(run))) return run;
  }
  return undefined;
}

/** Whether some decoded view of `text`, base64 runs from six characters (four bytes) included,
 * holds `value` whole: the check for a private value shorter than K. */
export function holdsValue(text: string, value: string): boolean {
  return decodedViews(text, 6).some((view) => view.includes(value));
}
