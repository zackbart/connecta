import { describe, expect, it, vi } from "vitest";
import { api } from "../src/connectors/api.js";
import { CatalogService } from "../src/catalog-service.js";
import { InvocationService } from "../src/invocation.js";
import {
  activitySink,
  invokeTestCall,
  makeRegistry,
  silentLogger,
} from "./helpers.js";

const BASE = "https://connecta.example";

describe("failed call logging", () => {
  it("INV-6: records a failure's typed facts, never its text, in the log and activity", async () => {
    const warn = vi.fn();
    const argument = "sentinel-argument-41c2";
    const credential = "sentinel-credential-9e1d";
    const result = "sentinel-result-6b0a";
    const code = "sentinel-code-3f77";
    const flaky = api("flaky", {
      tools: [
        {
          name: "read",
          description: "Read a value",
          inputSchema: { type: "object", properties: { q: { type: "string" } } },
          annotations: { readOnlyHint: true },
          handler: (args: { q: string }) => {
            // A downstream that echoes everything it was sent and holds.
            throw new TypeError(
              `downstream exploded: ${args.q} ${credential} ${result} ${code}`,
              { cause: new Error(credential) },
            );
          },
        },
      ],
    });
    const registry = makeRegistry([flaky], {
      logger: { ...silentLogger, warn },
    });
    const target = activitySink();

    await invokeTestCall(registry, target, "flaky.read", { q: argument });

    // The registry may warn about connector conventions at construction; only
    // the failure line is under test here.
    const failures = warn.mock.calls.filter(
      ([line]) => line === "[connecta] call failed",
    );
    expect(failures).toHaveLength(1);
    const [, meta] = failures[0] as [string, Record<string, unknown>];
    expect(meta).toEqual({
      connector: "flaky",
      tool: "read",
      source: "call_tool",
      attempts: 1,
      durationMs: expect.any(Number),
      code: "connector_call_failed",
      retryable: false,
      errorClass: "TypeError",
      step: "handler",
    });
    expect(target.events).toHaveLength(1);
    expect(target.events[0]).toMatchObject({ errorCode: "connector_call_failed" });
    for (const sentinel of [argument, credential, result, code, "downstream exploded"]) {
      expect(JSON.stringify(warn.mock.calls)).not.toContain(sentinel);
      expect(JSON.stringify(target.events)).not.toContain(sentinel);
    }
  });

  it("stays quiet for an approval reroute, which is not a failure", async () => {
    const warn = vi.fn();
    const dangerous = api("danger", {
      tools: [
        {
          name: "erase",
          description: "Erase the thing",
          annotations: { readOnlyHint: false, destructiveHint: true },
          handler: () => ({ erased: true }),
        },
      ],
    });
    const registry = makeRegistry([dangerous], {
      logger: { ...silentLogger, warn },
    });
    const target = activitySink();

    const outcome = await new InvocationService(
      registry,
      new CatalogService(registry, BASE),
      target.activity,
    ).invoke("danger.erase", {}, {
      source: "call_tool",
      allowDestructive: false,
    });

    expect(outcome.ok).toBe(false);
    expect(
      warn.mock.calls.filter(([line]) => line === "[connecta] call failed"),
    ).toHaveLength(0);
  });
});
