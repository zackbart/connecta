import { expect } from "vitest";

// The unchanged scan took 6–9 s with two CPU burners. Twenty seconds keeps
// scheduling/instrumentation headroom while still bounding unobservable native
// regex backtracking. The runner guard also allows the assertion to report it.
const NATIVE_SCAN_CEILING_MS = 20_000;
export const SCAN_HANG_GUARD_MS = 30_000;

/** ECMAScript search positions: truncate, then clamp to the supplied string. */
function position(value: number | undefined, length: number, fallback: number): number {
  const integer = value === undefined || Number.isNaN(value) ? fallback : Math.trunc(value);
  return Math.min(length, Math.max(0, integer));
}

/** Logical search span, including the found needle or the entire failed suffix. */
function forwardSpan(length: number, needle: string, from: number | undefined, found: number): number {
  const start = position(from, length, 0);
  if (needle.length === 0 || needle.length > length - start) return 0;
  return found < 0 ? length - start : found - start + needle.length;
}

/**
 * Count reads, copied/normalized code units and native literal-search spans.
 * Native regex APIs cannot expose backtracking steps; linearWork also checks
 * elapsed time after the synchronous call, rather than relying on a timer
 * callback that cannot run during CPU work. This is a test-only measurement.
 */
export function stringWork<T>(work: () => T, limit = Infinity): { value: T; units: number } {
  const native = {
    charCodeAt: String.prototype.charCodeAt,
    slice: String.prototype.slice,
    replace: String.prototype.replace,
    toLowerCase: String.prototype.toLowerCase,
    indexOf: String.prototype.indexOf,
    lastIndexOf: String.prototype.lastIndexOf,
    includes: String.prototype.includes,
    startsWith: String.prototype.startsWith,
    endsWith: String.prototype.endsWith,
    search: String.prototype.search,
    match: String.prototype.match,
    split: String.prototype.split,
  };
  let units = 0;
  const charge = (amount: number) => {
    units += amount;
    if (units > limit) throw new RangeError(`Scanner character-work budget exceeded: ${units} > ${limit}`);
  };
  // Per-character reads must not allocate argument arrays or spy histories.
  const counted = {
    charCodeAt(this: string, index: number) {
      charge(1);
      return native.charCodeAt.call(this, index);
    },
    slice(this: string, start?: number, end?: number) {
      const result = native.slice.call(this, start, end);
      charge(result.length);
      return result;
    },
    replace(this: string, ...args: unknown[]) {
      charge(this.length);
      return Reflect.apply(native.replace, this, args);
    },
    toLowerCase(this: string) {
      charge(this.length);
      return native.toLowerCase.call(this);
    },
    indexOf(this: string, needle: string, from?: number) {
      const found = native.indexOf.call(this, needle, from);
      charge(forwardSpan(this.length, needle, from, found));
      return found;
    },
    lastIndexOf(this: string, needle: string, from?: number) {
      const found = native.lastIndexOf.call(this, needle, from);
      if (needle.length > 0 && needle.length <= this.length) {
        const start = Math.min(position(from, this.length, this.length), this.length - needle.length);
        charge(start + needle.length - (found < 0 ? 0 : found));
      }
      return found;
    },
    includes(this: string, needle: string, from?: number) {
      const result = native.includes.call(this, needle, from);
      const found = result ? native.indexOf.call(this, needle, from) : -1;
      charge(forwardSpan(this.length, needle, from, found));
      return result;
    },
    startsWith(this: string, needle: string, from?: number) {
      const result = native.startsWith.call(this, needle, from);
      if (needle.length <= this.length - position(from, this.length, 0)) charge(needle.length);
      return result;
    },
    endsWith(this: string, needle: string, end?: number) {
      const result = native.endsWith.call(this, needle, end);
      if (needle.length <= position(end === undefined ? this.length : end, this.length, 0)) charge(needle.length);
      return result;
    },
    search(this: string, ...args: unknown[]) {
      charge(this.length);
      return Reflect.apply(native.search, this, args);
    },
    match(this: string, ...args: unknown[]) {
      charge(this.length);
      return Reflect.apply(native.match, this, args);
    },
    split(this: string, ...args: unknown[]) {
      charge(this.length);
      return Reflect.apply(native.split, this, args);
    },
  };
  const originals = (Object.keys(native) as Array<keyof typeof native>).map((name) => {
    const descriptor = Object.getOwnPropertyDescriptor(String.prototype, name);
    if (!descriptor) throw new Error(`Missing String.${name}`);
    return { name, descriptor };
  });
  try {
    for (const { name, descriptor } of originals)
      Object.defineProperty(String.prototype, name, { ...descriptor, value: counted[name] });
    const value = work();
    return { value, units };
  } finally {
    for (const { name, descriptor } of originals) Object.defineProperty(String.prototype, name, descriptor);
  }
}

/** Deterministic work bound plus a generous backstop for opaque native scans. */
export function linearWork<T>(input: string, work: (text: string) => T): T {
  const started = performance.now();
  const { value, units } = stringWork(() => work(input), input.length * 64 + 1_000);
  const elapsed = performance.now() - started;
  expect(units, "the scanner must exercise the work counter").toBeGreaterThan(0);
  expect(elapsed, "native scanning/backtracking wall-clock backstop").toBeLessThan(NATIVE_SCAN_CEILING_MS);
  return value;
}
