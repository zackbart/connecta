/**
 * How big one tool result may be, measured the way it is delivered: as UTF-8
 * JSON. Every Workspace read must reach the agent both ways it can be called.
 * Inside `execute_code` the QuickJS bridge refuses any single host result over
 * 256 KiB (`MAX_HOST_RESULT_BYTES` in `src/executors/quickjs-runtime.ts`);
 * through `call_tool` a large result is stashed and paged, up to the
 * deployment's stash size (8 MiB by default). A result built to stay under
 * {@link RESULT_BUDGET_BYTES} clears both, so a product never has to know which
 * route called it. Shared by the Workspace products; never its own export.
 *
 * The budget leaves 64 KiB of the bridge's 256 for the envelope a tool adds
 * around its rows — page objects, counts, ids — so a product sizes its rows
 * against this and its envelope never needs measuring.
 */

/** The size one Workspace result is built to stay under, in UTF-8 JSON bytes. */
export const RESULT_BUDGET_BYTES = 192 * 1024;

const encoder = new TextEncoder();

/** The UTF-8 length of a value's JSON — what both delivery routes measure. */
export function jsonBytes(value: unknown): number {
  const json = JSON.stringify(value);
  return json === undefined ? 0 : encoder.encode(json).length;
}

/**
 * `text` cut so that its JSON string encoding — quotes and escapes included —
 * takes at most `maxBytes` UTF-8 bytes, with `marker(dropped)` appended when
 * anything was cut. The cut never splits a surrogate pair, and the marker is
 * counted inside the bound, so the result always fits.
 */
export function clampText(
  text: string,
  maxBytes: number,
  marker: (droppedCharacters: number) => string,
): string {
  if (jsonBytes(text) <= maxBytes) return text;
  const fits = (length: number) => {
    const cut = safePrefix(text, length);
    return jsonBytes(cut + marker(text.length - cut.length)) <= maxBytes;
  };
  // The largest prefix that fits, by binary search over its length.
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(middle)) low = middle;
    else high = middle - 1;
  }
  const cut = safePrefix(text, low);
  const clamped = cut + marker(text.length - cut.length);
  // A marker longer than the bound itself leaves nothing honest to return
  // but the cut alone, which is empty here.
  return jsonBytes(clamped) <= maxBytes ? clamped : "";
}

/** The first `length` UTF-16 units, minus a dangling high surrogate. */
function safePrefix(text: string, length: number): string {
  const cut = text.slice(0, length);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}
