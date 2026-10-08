import type { UiData } from "../../src/ui.js";
import type { OperatorUiContract } from "../../src/operator-ui/contract.js";
import { createTestConnecta } from "../helpers.js";

/** A real allowlisted snapshot with deterministic, route-intercepted live facts. */
export async function fixtureContract(data: UiData): Promise<OperatorUiContract> {
  const app = createTestConnecta({ logger: "silent", connectors: data.connectors.map(c => ({
    id: c.id, ...(c.title ? { title: c.title } : {}), authScope: c.authScope ?? "shared",
    listTools: async () => [], callTool: async () => null,
  })), ...(data.serverInfo ? { serverInfo: data.serverInfo } : {}) });
  const config = structuredClone(app.describeConfig());
  await app.close();
  return {
    schemaVersion: 1, config,
    live: { activity: data.activityEnabled ? "available" : "unconfigured", connectors: data.connectors.map(c => ({
      id: c.id, status: c.status === "loading" ? "ok" : c.status,
      ...(c.problem ? { problem: c.problem } : {}), catalogAgeMs: null, lastCall: null,
      tools: c.tools.map(t => ({ ...t, classification: t.safety === "runs_in_programs" ? "read" : "write" })),
    })) },
    you: {
      interactive: true, trust: "read-only", grants: data.connectors.map(c => ({ connectorId: c.id, tools: "all" })),
      pools: (data.pools ?? []).map(name => ({ name, path: `/mcp/${name}`, trust: "read-only", grants: data.connectors.map(c => ({ connectorId: c.id, tools: "all" })) })),
      permissions: { activity: data.activityEnabled, artifacts: Boolean(data.artifactsEnabled), accessTokenManagement: data.accessTokenManagement === "available",
        connectors: data.connectors.map(c => ({ id: c.id, use: true, manageSharedAuth: c.permissions?.manageSharedAuth ?? false, connectPersonal: c.permissions?.connectPersonal ?? false })),
      },
    },
  };
}
