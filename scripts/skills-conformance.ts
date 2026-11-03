// Optional contributor fixture; run the reviewed official runner outside this checkout.
import { createTestConnecta, silentLogger } from "../test/helpers.js";
import { api } from "../src/connectors/api.js";
import { listen } from "../src/node.js";

const connecta = createTestConnecta({
  connectors: Array.from({ length: 6 }, (_, index) =>
    api(`crm-${index}`, { tools: [], usageGuide: `# CRM\n\nLoad when working with CRM ${index}.` }),
  ),
  logger: silentLogger,
});
listen(connecta, { port: 39743, host: "127.0.0.1" });
