import type { QueryType, RetrievalQuery } from "./queries.js";

export interface RankedRow {
  address: string;
  alsoOn: readonly string[];
}

export interface Metrics {
  n: number;
  r1: number;
  r5: number;
  r8: number;
  mrr: number;
}

export type QuerySet = "main" | "holdout";

export interface ScoredQuery {
  set: QuerySet;
  query: RetrievalQuery;
  all: number;
  readOnly?: number;
}

interface SetSummary {
  all: Metrics;
  readOnly: Metrics;
  types: Partial<Record<QueryType, Metrics>>;
  certain: Metrics;
}

export type Summary = Record<QuerySet, SetSummary>;

export const MRR_DEPTH = 20;

const split = (address: string) => {
  const dot = address.lastIndexOf(".");
  return { connector: address.slice(0, dot), tool: address.slice(dot + 1) };
};

export function matchesAnswer(pattern: string, address: string): boolean {
  const want = split(pattern);
  const got = split(address);
  if (want.tool !== got.tool) return false;
  if (!want.connector.endsWith("*")) return want.connector === got.connector;
  const base = want.connector.slice(0, -1);
  return got.connector === base || got.connector.startsWith(`${base}_`);
}

export function firstRank(answers: readonly string[], rows: readonly RankedRow[]): number {
  const index = rows
    .slice(0, MRR_DEPTH)
    .findIndex((row) =>
      answers.some(
        (pattern) =>
          matchesAnswer(pattern, row.address) ||
          (pattern.includes("*") && row.alsoOn.some((other) => matchesAnswer(pattern, other))),
      ),
    );
  return index + 1;
}

function metrics(ranks: readonly number[]): Metrics {
  const n = ranks.length;
  const round = (value: number) => Math.round(value * 1e4) / 1e4;
  const share = (k: number) => (n ? round(ranks.filter((rank) => rank > 0 && rank <= k).length / n) : 0);
  const mrr = n ? round(ranks.reduce((sum, rank) => sum + (rank > 0 ? 1 / rank : 0), 0) / n) : 0;
  return { n, r1: share(1), r5: share(5), r8: share(8), mrr };
}

const TYPES: readonly QueryType[] = ["intent", "precise", "write", "hatch", "vague", "multi"];

export function summarize(scored: readonly ScoredQuery[]): Summary {
  const one = (set: QuerySet): SetSummary => {
    const rows = scored.filter((row) => row.set === set);
    const types: SetSummary["types"] = {};
    for (const type of TYPES) {
      const ofType = rows.filter((row) => row.query.type === type);
      if (ofType.length) types[type] = metrics(ofType.map((row) => row.all));
    }
    return {
      all: metrics(rows.map((row) => row.all)),
      readOnly: metrics(rows.flatMap((row) => (row.readOnly === undefined ? [] : [row.readOnly]))),
      types,
      certain: metrics(rows.filter((row) => !row.query.uncertain).map((row) => row.all)),
    };
  };
  return { main: one("main"), holdout: one("holdout") };
}

const TOLERANCE = { r5: 0.02, mrr: 0.01 } as const;

export interface GateResult {
  failures: string[];
  improvements: string[];
}

export function gate(current: Summary, baseline: Summary): GateResult {
  const failures: string[] = [];
  const improvements: string[] = [];
  for (const set of ["main", "holdout"] as const) {
    for (const scope of ["all", "readOnly"] as const) {
      for (const metric of ["r5", "mrr"] as const) {
        const now = current[set][scope][metric];
        const was = baseline[set][scope][metric];
        const label = `${set} ${scope} ${metric === "r5" ? "R@5" : "MRR"} ${was.toFixed(3)} -> ${now.toFixed(3)}`;
        if (current[set][scope].n !== baseline[set][scope].n)
          failures.push(
            `${set} ${scope}: ${current[set][scope].n} queries scored, baseline has ${baseline[set][scope].n}`,
          );
        else if (was - now > TOLERANCE[metric] + 1e-9) failures.push(label);
        else if (now - was > TOLERANCE[metric] + 1e-9) improvements.push(label);
      }
    }
  }
  return { failures: [...new Set(failures)], improvements };
}

export const queryKey = (row: Pick<ScoredQuery, "set" | "query">) =>
  `${row.set}:${row.query.deployment}:${row.query.query}`;
