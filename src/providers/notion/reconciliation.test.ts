import { vi } from "vitest";
import type { ToolDef } from "../../types.js";
import { reconciliationTests } from "../../../test/fixtures/provider-reconciliation.js";
import before from "./reconciliation-before.json";
import after from "./reconciliation-after.json";
import ownership from "./reconciliation.json";
const mocks = vi.hoisted(() => ({ listTools: vi.fn<() => Promise<ToolDef[]>>(), remoteMcp: vi.fn() }));
vi.mock("../../connectors/remote-mcp.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../connectors/remote-mcp.js")>()), remoteMcp: mocks.remoteMcp,
}));
import { notion } from "./index.js";
reconciliationTests("notion", notion, mocks, before, after, ownership);
