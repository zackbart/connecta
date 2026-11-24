/**
 * The `eval:perf` baseline: its shape, its file format and the exact
 * comparison the gate applies.
 */
import { COUNTERS, OPERATIONS, PHASES, reportedCounters, type Cell, type CellCounts, type Counts } from "./matrix.js";

interface BaselineCell {
  config: Omit<Cell, "id" | "why">;
  reported: string[];
  requests: Record<string, Record<string, Partial<Counts>>>;
}
export interface Baseline {
  cells: Record<string, BaselineCell>;
}

/** Only the gated counters of each request; `reported` names the rest. */
export function baselineOf(cells: { cell: Cell; counts: CellCounts }[]): Baseline {
  return {
    cells: Object.fromEntries(
      cells.map(({ cell, counts }) => {
        const { id: _id, why: _why, ...config } = cell;
        const reported = reportedCounters(cell);
        const operations = OPERATIONS.map((operation) => [
          operation,
          Object.fromEntries(
            PHASES.map((phase) => [
              phase,
              Object.fromEntries(
                COUNTERS.filter((counter) => !reported.includes(`${operation}.${counter}`)).map((counter) => [
                  counter,
                  counts[operation][phase][counter],
                ]),
              ),
            ]),
          ),
        ]);
        return [cell.id, { config, reported, requests: Object.fromEntries(operations) }];
      }),
    ),
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Every difference between a stored baseline and the current one, in both
 * directions: a cell, request, phase or counter on one side only differs, as
 * does any value. Arrays and scalars compare whole.
 */
export function baselineDifferences(stored: unknown, current: unknown, path: string[] = []): string[] {
  const at = path.join(" ") || "baseline";
  if (isRecord(stored) && isRecord(current)) {
    const keys = [...new Set([...Object.keys(stored), ...Object.keys(current)])];
    return keys.flatMap((key) => {
      if (!(key in stored)) return [`${[...path, key].join(" ")}: measured but not in the baseline`];
      if (!(key in current)) return [`${[...path, key].join(" ")}: in the baseline but no longer measured`];
      return baselineDifferences(stored[key], current[key], [...path, key]);
    });
  }
  return JSON.stringify(stored) === JSON.stringify(current)
    ? []
    : [`${at}: ${JSON.stringify(stored) ?? "absent"} -> ${JSON.stringify(current) ?? "absent"}`];
}

/** One line per phase, so a baseline diff names the request that moved. */
export function formatBaseline(baseline: Baseline): string {
  const cells = Object.entries(baseline.cells).map(([id, cell]) => {
    const operations = OPERATIONS.map(
      (operation) =>
        `        ${JSON.stringify(operation)}: {\n` +
        PHASES.map((phase) => `          "${phase}": ${JSON.stringify(cell.requests[operation]![phase])}`).join(",\n") +
        "\n        }",
    );
    return `    ${JSON.stringify(id)}: {\n      "config": ${JSON.stringify(cell.config)},\n      "reported": ${JSON.stringify(cell.reported)},\n      "requests": {\n${operations.join(",\n")}\n      }\n    }`;
  });
  return `{\n  "cells": {\n${cells.join(",\n")}\n  }\n}\n`;
}
