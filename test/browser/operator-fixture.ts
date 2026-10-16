import type { UiData } from "../../src/ui.js";
import type { OperatorUiContract } from "../../src/operator-ui/contract.js";
import { createTestConnecta } from "../helpers.js";

/** A real allowlisted snapshot with deterministic, route-intercepted live facts. */
export async function fixtureContract(data: UiData): Promise<OperatorUiContract> {
  const app = createTestConnecta({
    logger: "silent",
    connectors: data.connectors.map((c) => ({
      id: c.id,
      ...(c.title ? { title: c.title } : {}),
      authScope: c.authScope ?? "shared",
      listTools: async () => [],
      callTool: async () => null,
    })),
    ...(data.serverInfo ? { serverInfo: data.serverInfo } : {}),
  });
  // v1 alone adds hasGrant: whether maintainers gate plain /mcp, which they
  // do only with inbound auth, and this snapshot has none (#837).
  const config = { ...structuredClone(app.describeConfig()), hasGrant: false };
  await app.close();
  return {
    schemaVersion: 1,
    config,
    live: {
      activity: data.activityEnabled ? "available" : "unconfigured",
      connectors: data.connectors.map((c) => ({
        id: c.id,
        status: c.status === "loading" ? "ok" : c.status,
        ...(c.registrationPath ? { auth: { registrationPath: c.registrationPath } } : {}),
        ...(c.problem ? { problem: c.problem } : {}),
        catalogAgeMs: null,
        lastCall: null,
        tools: c.tools.map((t) => ({ ...t, classification: t.safety === "runs_in_programs" ? "read" : "write" })),
      })),
    },
    you: {
      interactive: true,
      readOnly: true,
      grants: data.connectors.map((c) => ({ connectorId: c.id, tools: "all" })),
      pools: (data.pools ?? []).map((name) => ({
        name,
        path: `/mcp/${name}`,
        readOnly: true,
        grants: data.connectors.map((c) => ({ connectorId: c.id, tools: "all" })),
      })),
      permissions: {
        activity: data.activityEnabled,
        accessTokenManagement: data.accessTokenManagement === "available",
        connectors: data.connectors.map((c) => ({
          id: c.id,
          use: true,
          manageSharedAuth: c.permissions?.manageSharedAuth ?? false,
          connectPersonal: c.permissions?.connectPersonal ?? false,
        })),
      },
    },
  };
}
