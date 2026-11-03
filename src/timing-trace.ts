// Payload-free, request-owned aggregates. The sink accepts only fixed families
// and finite numeric facts; it never receives keys, identities or error objects.
import type { Logger } from "./types.js";
export type TimingFamily =
  | "catalog.cache.lookup"
  | "catalog.cache.hit"
  | "catalog.cache.expired"
  | "catalog.chunks"
  | "catalog.validated.hit"
  | "catalog.validated.miss"
  | "catalog.intake"
  | "catalog.decode"
  | "catalog.validate"
  | "catalog.accepted"
  | "catalog"
  | "admission"
  | "connector"
  | "result"
  | "d1.read"
  | "d1.write"
  | "d1.batch"
  | "memo.hit"
  | "memo.miss"
  | "memo.fresh";
interface Totals {
  count: number;
  // I/O-spanning elapsed observation on Workers; zero is ambiguous, not zero CPU.
  durationMs: number;
  bytes: number;
  statements: number;
  absent: number;
  items: number;
}
const families = new Set<TimingFamily>([
  "catalog.cache.lookup",
  "catalog.cache.hit",
  "catalog.cache.expired",
  "catalog.chunks",
  "catalog.validated.hit",
  "catalog.validated.miss",
  "catalog.intake",
  "catalog.decode",
  "catalog.validate",
  "catalog.accepted",
  "catalog",
  "admission",
  "connector",
  "result",
  "d1.read",
  "d1.write",
  "d1.batch",
  "memo.hit",
  "memo.miss",
  "memo.fresh",
]);
const traces = new WeakMap<object, TimingTrace>();
let active = 0;
let firstRequest = true;
export const hasTimingTraces = (): boolean => active > 0;
export const traceFor = (identity: object | undefined): TimingTrace | undefined =>
  identity ? traces.get(identity) : undefined;
const finite = (value: number): number => (Number.isFinite(value) && value >= 0 ? value : 0);
export class TimingTrace {
  private readonly started = performance.now();
  private readonly totals = new Map<TimingFamily, Totals>();
  private closed = false;
  constructor(private readonly first: boolean) {}
  record(family: TimingFamily, durationMs = 0, bytes = 0, statements = 0, absent = 0, items = 0): void {
    if (this.closed || !families.has(family)) return;
    const total = this.totals.get(family) ?? { count: 0, durationMs: 0, bytes: 0, statements: 0, absent: 0, items: 0 };
    total.count++;
    total.durationMs += finite(durationMs);
    total.bytes += finite(bytes);
    total.statements += finite(statements);
    total.absent += finite(absent);
    total.items += finite(items);
    this.totals.set(family, total);
  }
  finish(logger: Logger): void {
    if (this.closed) return;
    this.closed = true;
    try {
      logger.info("connecta.timing", {
        version: 1,
        isolateFirstRequest: this.first,
        durationMs: performance.now() - this.started,
        weakReferences: typeof WeakRef === "function" && typeof FinalizationRegistry === "function",
        operations: Object.fromEntries(this.totals),
      });
    } catch {
      /* Observability cannot change a request's outcome. */
    }
    this.totals.clear();
  }
}
/** Called for each MCP request, including those not sampled. */
export function startTimingTrace(identity: object, sampleRate: number, logger: Logger): (() => void) | undefined {
  const first = firstRequest;
  firstRequest = false;
  if (sampleRate <= 0 || (sampleRate < 1 && Math.random() >= sampleRate)) return undefined;
  const trace = new TimingTrace(first);
  traces.set(identity, trace);
  active++;
  return () => {
    if (traces.get(identity) !== trace) return;
    traces.delete(identity);
    active--;
    trace.finish(logger);
  };
}
