// Types for the part of drift-validate.mjs the provider-standard and drift-check suites import.

/**
 * Every structural problem `providers:check` would report for a record
 * before reading a vendor. `recording` admits endpoint rows awaiting the contract `--record` writes.
 */
export function driftRecordProblems(
  record: unknown,
  name: string,
  options?: { today?: string; recording?: boolean },
): string[];

export function generatedProblems(record: unknown, options?: { kind?: string; files?: readonly string[] }): string[];
export function supplementalDocument(pin: unknown): string | undefined;
export function validSupplementalPin(pin: unknown): boolean;

/** A check as the version-1 checkers read it: version 2 endpoint rows become method and path, and pages join. */
export function checkView(record: unknown, check: unknown, options?: { catalog?: unknown; today?: string }): any;
