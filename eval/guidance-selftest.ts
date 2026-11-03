/** Model-free wire and guest-bridge controls for the guidance interventions. */
import assert from "node:assert/strict";
import { GUIDANCE_ARMS } from "./deploy/guidance.js";
import { startNodeDeployment } from "./deploy/node.js";
import { World } from "./fakes/world.js";
import { connectMcp } from "./support/mcp.js";

export async function guidanceSelftest() {
  const previous = process.env.CONNECTA_EVAL_GUIDANCE;
  try {
    for (const arm of GUIDANCE_ARMS) {
      process.env.CONNECTA_EVAL_GUIDANCE = arm;
      const world = new World({ prerequisites: true });
      await world.start();
      const deployment = await startNodeDeployment(world.connectorSpecs());
      try {
        const client = await connectMcp(deployment.mcpUrl, { Authorization: `Bearer ${deployment.token}` });
        try {
          assert.equal(client.instructions?.includes("Before working with revenuecat"), arm === "instruction-fetch");
          for (const [tool, args] of [
            ["search_tools", { query: "", connector: "supabase" }],
            ["execute_code", { code: 'async () => await connecta.search({query:"",connector:"supabase"})' }],
          ] as const) {
            const result = await client.call(tool, args);
            assert.equal(result.isError, false, `${arm}/${tool}: ${result.text}`);
            assert.ok(result.text.includes("connector:supabase"));
            assert.equal(result.text.includes("guideSummary"), arm === "summary");
            assert.equal(result.text.includes("guideConvention"), arm === "inline");
          }
          const fetched = await client.call("skills", { name: "connector:supabase" });
          assert.equal(fetched.isError, false);
          assert.ok(fetched.text.includes("project_ref, not project_id"));
        } finally {
          await client.close();
        }
      } finally {
        await deployment.close();
        await world.stop();
      }
      console.log(`ok   ${arm}: actual HTTP, guest discovery, bootstrap and fetched guide`);
    }
  } finally {
    if (previous === undefined) delete process.env.CONNECTA_EVAL_GUIDANCE;
    else process.env.CONNECTA_EVAL_GUIDANCE = previous;
  }
}
