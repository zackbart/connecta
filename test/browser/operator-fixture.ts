import type { Page } from "@playwright/test";
import type { UiData } from "../../src/ui.js";
import type { OperatorUiContractV2 } from "../../src/operator-ui/contract.js";
import { createTestConnecta } from "../helpers.js";
import { contractV2 } from "../fixtures/operator-contract-v2-bridge.js";

/**
 * Serve the real server's `/ui/api/config` as contract v2. A pass-through once
 * P6b of #837 serves v2 itself; see operator-contract-v2-bridge.ts.
 */
export async function serveContractV2(page: Page): Promise<void> {
  // Match on the path: OAuth polling reads the scoped `?connector=<id>` form too.
  await page.route(
    (url) => url.pathname === "/ui/api/config",
    async (route) => {
      const response = await route.fetch();
      if (!response.ok()) return route.fulfill({ response });
      return route.fulfill({ response, json: contractV2(await response.json()) });
    },
  );
}

/** A real allowlisted snapshot with deterministic, route-intercepted live facts, as a maintainer's v2 view. */
export async function fixtureContract(data: UiData): Promise<OperatorUiContractV2> {
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
  return contractV2({
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
  });
}
