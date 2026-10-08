import { describe, expect, it, vi } from "vitest";
import { api } from "../src/connectors/api.js";
import { createConnecta, customExecutor } from "../src/index.js";
import { Registry } from "../src/registry.js";
import { memoryStorage } from "../src/storage/memory.js";
import { calcConnector, silentLogger } from "./helpers.js";

const controls = Array.from({ length: 0xa0 }, (_, code) => code)
  .filter(code => code <= 0x1f || code >= 0x7f);
const executor = customExecutor({ execute: async () => ({ result: null }) }, { lifecycle: "self-managed" });

describe("static tool names", () => {
  it.each(controls)("INV-11: rejects control code %i in api() before rendering tool errors", code => {
    const name = `private-name${String.fromCharCode(code)}suffix`;
    const construct = () => api("crm", {
      tools: [
        { name: "first", description: "Read first", annotations: { readOnlyHint: true }, handler: () => null },
        { name: "second", description: "Read second", annotations: { readOnlyHint: true }, handler: () => null },
        // Missing metadata must not cause an error that includes the name.
        { name, description: "", annotations: { readOnlyHint: true }, handler: () => null },
      ],
    });
    expect(construct).toThrow('api("crm").tools[2].name contains a control character.');
    try { construct(); } catch (error) {
      expect((error as Error).message).not.toContain("private-name");
      expect((error as Error).message).not.toContain(name);
    }
  });

  it.each(controls)("INV-11: rejects control code %i in custom staticTools before startup logs", code => {
    const name = `private-name${String.fromCharCode(code)}suffix`;
    const connector = {
      ...calcConnector,
      staticTools: [
        { name: "safe" },
        { name },
      ],
    };
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const message = 'Connector("calc").staticTools[1].name contains a control character.';
    expect(() => new Registry([connector], {
      storage: memoryStorage(), logger, constructionChecks: false,
    })).toThrow(message);
    const construct = () => createConnecta({ connectors: [connector], executor, logger });
    expect(construct).toThrow(message);
    try { construct(); } catch (error) {
      expect((error as Error).message).not.toContain("private-name");
      expect((error as Error).message).not.toContain(name);
    }
    for (const log of Object.values(logger)) expect(log).not.toHaveBeenCalled();
  });

  it.each(["space name", "caf\u00e9", "lone\ud800", "line\u2028separator", "paragraph\u2029separator"])(
    "INV-11: leaves non-control static name %j unchanged", name => {
      const connector = api("crm", { tools: [{
        name, description: "Read value", annotations: { readOnlyHint: true }, handler: () => null,
      }] });
      expect(connector.staticTools?.[0]?.name).toBe(name);
      expect(() => new Registry([connector], { storage: memoryStorage(), logger: silentLogger })).not.toThrow();
    },
  );
});
