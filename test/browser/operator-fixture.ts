import type { UiData } from "../../src/ui.js";
import type { OperatorUiContractV2 } from "../../src/operator-ui/contract.js";
import { createTestConnecta } from "../helpers.js";

/**
 * The real server's maintainer contract for these connectors, with
 * deterministic, route-intercepted live facts. An open deployment's anonymous
 * caller is the maintainer, so nobody is listed and no owner is shown.
 */
export async function fixtureContract(data: UiData): Promise<OperatorUiContractV2> {
  const ids = data.connectors.map((c) => c.id);
  const app = createTestConnecta({
    logger: "silent",
    readOnly: true,
    connectors: data.connectors.map((c) => ({
      id: c.id,
      ...(c.title ? { title: c.title } : {}),
      authScope: c.authScope ?? "shared",
      listTools: async () => [],
      callTool: async () => null,
    })),
    ...(data.serverInfo ? { serverInfo: data.serverInfo } : {}),
    pools: Object.fromEntries(
      (data.pools ?? []).map((name) => [
        name,
        { tools: ids, readOnly: true, members: [{ namespace: "https://clerk.example.test", id: "user_operator" }] },
      ]),
    ),
  });
  try {
    const response = await app.fetch(new Request("https://connecta.example/ui/api/config"));
    if (!response.ok) throw new Error(`Fixture deployment refused its operator: HTTP ${response.status}`);
    const contract = (await response.json()) as OperatorUiContractV2;
    return {
      ...contract,
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
      you: { interactive: true, viewerKey: "opaque-viewer" },
    };
  } finally {
    await app.close();
  }
}
