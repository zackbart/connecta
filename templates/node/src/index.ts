/**
 * Prescribed Connecta deployment. Configuration lives in src/connecta.config.ts;
 * this file only starts it. The environment it reads is in .env.example.
 */
import { createConnecta } from "@zackbart/connecta";
import { listen } from "@zackbart/connecta/node";
import connectaConfig from "./connecta.config.js";

const config = connectaConfig(process.env);
const connecta = createConnecta(config);
const port = Number(process.env.PORT || 8787);

listen(connecta, port);
console.log(`connecta listening on port ${port}; MCP at ${config.publicUrl}/mcp`);

// The deployment owns the artifact refresh timer; core starts no background
// work. Each tick starts at most 10 due pages.
const artifacts = config.artifacts;
if (artifacts?.runDue) {
  setInterval(() => {
    void artifacts.runDue!().catch((error) => console.error("artifact refresh failed", error));
  }, 60 * 60 * 1000).unref();
}
