import { createConnecta, customExecutor, memoryStorage } from "../../src/index.js";
import type { Connector } from "../../src/types.js";
import { silentLogger } from "../helpers.js";

export interface ContractFixture {
  name: string;
  create(id?: string, overrides?: Record<string, unknown>): Connector;
  cases: readonly { label: string; options: Record<string, unknown> }[];
}

/** Offline observations through the production registry, including hosted manifests. */
export async function providerContract(fixture: ContractFixture) {
  const rows = [];
  for (const scenario of [...fixture.cases, { label: "instructions", options: { instructions: "  Local deployment instructions.  ", title: "Fixture title", maxResultBytes: 12000 } }]) {
    const connector = fixture.create("fixture", scenario.options);
    const raw = connector.staticTools ?? Object.keys(connector.classification?.tools ?? {}).map((name) => ({ name }));
    const deployment = createConnecta({
      connectors: [{ ...connector, listTools: async () => raw }],
      storage: memoryStorage(), logger: silentLogger,
      executor: customExecutor({ execute: async () => ({ result: null }) }, { lifecycle: "self-managed" }),
    });
    try {
      const tools = await deployment.registry.getTools("fixture", "https://connecta.example");
      rows.push({
        label: scenario.label,
        metadata: { id: connector.id, kind: connector.kind, title: connector.title, description: connector.description, authScope: connector.authScope, maxResultBytes: connector.maxResultBytes, callAdmission: connector.callAdmission, credential: connector.credential },
        guide: connector.usageGuide,
        classification: connector.classification,
        tools: tools.map((tool) => ({ name: tool.name, annotations: tool.annotations })),
        describe: connector.describe?.(),
      });
    } finally {
      await deployment.close();
    }
  }
  return rows;
}
