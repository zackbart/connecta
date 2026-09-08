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
  it("warns with a bounded downstream reason while activity stays payload-free", async () => {
    const warn = vi.fn();
    const reason = `downstream exploded ${"x".repeat(400)}`;
    const flaky = api("flaky", {
      tools: [
        {
          name: "read",
          description: "Read a value",
          annotations: { readOnlyHint: true },
          handler: () => {
            throw new Error(reason);
          },
        },
      ],
    });
    const registry = makeRegistry([flaky], {
      logger: { ...silentLogger, warn },
    });
    const target = activitySink();

    await invokeTestCall(registry, target, "flaky.read");

    // The registry may warn about connector conventions at construction; only
    // the failure line is under test here.
    const failures = warn.mock.calls.filter(
      ([line]) => line === "[connecta] call failed",
    );
    expect(failures).toHaveLength(1);
    const [, meta] = failures[0] as [string, Record<string, unknown>];
    expect(meta).toMatchObject({
      connector: "flaky",
      tool: "read",
      source: "call_tool",
      attempts: 1,
    });
    expect(typeof meta.code).toBe("string");
    expect(typeof meta.durationMs).toBe("number");
    expect(String(meta.message)).toContain("downstream exploded");
    expect(String(meta.message).length).toBeLessThanOrEqual(300);
    // The activity row carries the code, never the downstream text.
    expect(target.events).toHaveLength(1);
    expect(JSON.stringify(target.events)).not.toContain("downstream exploded");
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
