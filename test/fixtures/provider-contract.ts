import type { Connector } from "../../src/types.js";

export interface ContractFixture {
  name: string;
  create(id?: string, overrides?: Record<string, unknown>): Connector;
  cases: readonly { label: string; options: Record<string, unknown> }[];
}
