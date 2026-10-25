import { Effect } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { registerAuth } from "../src/auth/native.js";
import * as cache from "../src/catalog-cache.js";
import { ConnectorCallError } from "../src/errors.js";
import { requestOwner } from "../src/runtime/request-scope.js";
import type { Connector, ConnectorContext, ToolDef } from "../src/types.js";
import { makeRegistry } from "./helpers.js";

afterEach(() => vi.restoreAllMocks());
const tools: ToolDef[] = ["read", "other"].map((name) => ({
  name,
  inputSchema: { type: "object" },
  annotations: { readOnlyHint: true },
}));
const RAW = "cache diagnostic containing payload must stay withheld";

it.each([false, true])("INV-8 INV-13: cached fallback remains complete through native selection %s", async (native) => {
  const program = vi.fn((_ctx: ConnectorContext, _id: string) => Effect.succeed(tools));
  const fallback = vi.spyOn(cache, "customCatalogFallback").mockResolvedValue(tools);
  if (native) registerAuth(fallback, program);
  vi.spyOn(cache, "storeCustomCatalogFallback").mockResolvedValue();
  vi.spyOn(cache, "observeUncachedCatalogRefresh").mockResolvedValue();
  const connector: Connector = {
    id: "crm",
    listTools: async () => {
      throw new ConnectorCallError("unavailable", "Catalog is temporarily unavailable.");
    },
    callTool: async () => null,
  };
  const scope = {},
    registry = makeRegistry([connector]);
  try {
    expect((await registry.getTools("crm", "https://connecta.test", scope)).map((tool) => tool.name)).toEqual([
      "read",
      "other",
    ]);
    expect(fallback).toHaveBeenCalledTimes(native ? 0 : 1);
    expect(program).toHaveBeenCalledTimes(native ? 1 : 0);
    if (native) expect(program.mock.calls[0]![0].requestScope).toBe(scope);
  } finally {
    requestOwner(scope).close();
  }
});

it.each(
  [false, true].flatMap((native) => (["fallback", "store", "refresh"] as const).map((stage) => ({ native, stage }))),
)(
  "INV-6 INV-8 INV-13: $stage failure retains existing catch/log policy with native selection $native",
  async ({ native, stage }) => {
    const failure = new Error(RAW),
      nativeFailure = vi.fn(() => Effect.fail(failure));
    const fallback = vi.spyOn(cache, "customCatalogFallback").mockResolvedValue(undefined);
    const store = vi.spyOn(cache, "storeCustomCatalogFallback").mockResolvedValue();
    const observe = vi.spyOn(cache, "observeUncachedCatalogRefresh").mockResolvedValue();
    const selected = stage === "fallback" ? fallback : stage === "store" ? store : observe;
    selected.mockRejectedValue(failure);
    if (native) registerAuth(selected, nativeFailure);
    const warnings: unknown[][] = [];
    const registry = makeRegistry(
      [
        {
          id: "crm",
          listTools: async () => {
            if (stage === "fallback")
              throw new ConnectorCallError("unavailable", "Catalog is temporarily unavailable.");
            return tools;
          },
          callTool: async () => null,
        },
      ],
      {
        logger: {
          debug() {},
          info() {},
          error() {},
          warn(...args) {
            warnings.push(args);
          },
        },
      },
    );
    const scope = {};
    try {
      if (stage === "fallback")
        await expect(registry.getTools("crm", "https://connecta.test", scope)).rejects.toMatchObject({
          code: "unavailable",
          message: "Catalog is temporarily unavailable.",
        });
      else {
        expect((await registry.getTools("crm", "https://connecta.test", scope)).map((tool) => tool.name)).toEqual([
          "read",
          "other",
        ]);
        expect(
          warnings.filter((entry) => String(entry[0]).includes("catalog refresh observation failed")),
        ).toHaveLength(1);
        expect(JSON.stringify(warnings)).not.toContain(RAW);
      }
      expect(selected).toHaveBeenCalledTimes(native ? 0 : 1);
      expect(nativeFailure).toHaveBeenCalledTimes(native ? 1 : 0);
    } finally {
      requestOwner(scope).close();
    }
  },
);
