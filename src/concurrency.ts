import { CONFIG_DEFAULTS } from "./config-defaults.js";

const DEFAULT_DISCOVERY_CONCURRENCY = CONFIG_DEFAULTS.discovery.concurrency;

export function resolveDiscoveryConcurrency(value: number | undefined): number {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : DEFAULT_DISCOVERY_CONCURRENCY;
}
