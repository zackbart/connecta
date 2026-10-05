// JSON as the artifacts module stores and injects it.

/**
 * `JSON.stringify`, with `<`, U+2028, and U+2029 escaped. The result is the
 * same JSON value, and it can sit inside a `<script>` element as a literal:
 * no `</script>` or `<!--` can end or bend the element it lives in. Documents
 * are stored in this form, so the bytes a limit counts are the bytes a page
 * receives.
 */
export function scriptSafeJson(value: unknown): string {
  return (JSON.stringify(value) ?? "null")
    .replace(/</g, "\\u003c")
    .replace(/[\u2028\u2029]/g, (c) => (c === "\u2028" ? "\\u2028" : "\\u2029"));
}

/**
 * Why `value` cannot be a document, or undefined when it can: plain JSON with
 * finite numbers, nested at most `maxDepth`, and no `__proto__` key — a page
 * reads documents as JavaScript objects, where that key sets a prototype
 * instead of holding data.
 */
export function jsonProblem(value: unknown, maxDepth: number): string | undefined {
  const pointer = (path: readonly (string | number)[]) =>
    path.length
      ? `/${path.map((part) => String(part).replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}`
      : "/";
  const stack: { value: unknown; path: (string | number)[]; depth: number }[] = [
    { value, path: [], depth: 0 },
  ];
  while (stack.length) {
    const item = stack.pop();
    if (!item) break;
    const current = item.value;
    if (current === null || typeof current === "string" || typeof current === "boolean") continue;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) {
        return `${pointer(item.path)} is ${String(current)}, which has no JSON form; use null or a string`;
      }
      continue;
    }
    if (typeof current !== "object") {
      return `${pointer(item.path)} is ${current === undefined ? "undefined" : `a ${typeof current}`}, which has no JSON form`;
    }
    if (item.depth >= maxDepth) {
      return `${pointer(item.path)} nests deeper than ${maxDepth} levels`;
    }
    if (Array.isArray(current)) {
      for (let index = current.length - 1; index >= 0; index--) {
        stack.push({ value: current[index], path: [...item.path, index], depth: item.depth + 1 });
      }
      continue;
    }
    const proto = Object.getPrototypeOf(current) as unknown;
    if (proto !== Object.prototype && proto !== null) {
      return `${pointer(item.path)} is not a plain object`;
    }
    for (const key of Object.keys(current)) {
      if (key === "__proto__") {
        return `${pointer([...item.path, key])} is a "__proto__" key, which a page would read as a prototype; rename it`;
      }
      stack.push({
        value: (current as Record<string, unknown>)[key],
        path: [...item.path, key],
        depth: item.depth + 1,
      });
    }
  }
  return undefined;
}

const encoder = new TextEncoder();

/** A string's size in UTF-8 bytes: what every artifact limit counts. */
export function utf8Bytes(text: string): number {
  return encoder.encode(text).byteLength;
}

/** SHA-256 as lowercase hex: the content address of a stored body. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")).join("");
}
