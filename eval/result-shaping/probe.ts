/**
 * No model, no vendors: boot the real Worker composition per arm and prove the
 * presentation reaches the wire, a program still sees the exact value, the
 * handle pages to the original bytes and a write is untouched.
 *
 *   node --import tsx eval/result-shaping/probe.ts [--arm preview] [--task truncated-read-paging]
 */
import { startDeployment } from "../deploy/targets.js";
import { World } from "../fakes/world.js";
import { connectMcp } from "../support/mcp.js";
import { ACTIVE_TASKS } from "../tasks/index.js";
import { flags } from "../support/meta.js";
import { parseResultArm } from "./shape.js";

const args = flags(process.argv.slice(2));
const arm = parseResultArm(args.get("arm") ?? "preview");
const taskId = args.get("task") ?? "tithely-recurring-join";
const task = ACTIVE_TASKS.find((candidate) => candidate.id === taskId);
if (!task) throw new Error(`Unknown task ${taskId}`);
const world = new World(task.world);
await world.start();
const deployment = await startDeployment("worker", world, task, "six", arm);
try {
  const session = await connectMcp(deployment.mcpUrl, { Authorization: `Bearer ${deployment.token}` });
  const address = args.get("address") ?? "tithely.list_charges";
  const callArgs = JSON.parse(args.get("args") ?? "{}") as Record<string, unknown>;
  const direct = await session.call("call_tool", { address, args: callArgs });
  console.log(`arm=${arm} ${address}: bytes=${direct.text.length} isError=${direct.isError}`);
  console.log(direct.text.slice(0, 1_200));
  const newline = direct.text.indexOf("\n");
  const notice = direct.text.startsWith('{"truncated"') ? JSON.parse(direct.text.slice(0, newline)) : undefined;
  if (notice?.nextAction) {
    console.log("\nnextAction program:");
    const followed = await session.call(notice.nextAction.tool, notice.nextAction.arguments);
    console.log(followed.text.slice(0, 600));
    const code = `async () => { const { data } = await connecta.call(${JSON.stringify(address)}, ${JSON.stringify(callArgs)}); let text = "", offset = 0, page; do { page = await connecta.result(${JSON.stringify(notice.resultId)}, { offset, maxBytes: 16000 }); text += page.text; offset = page.nextOffset; } while (page.hasMore); return { same: (typeof data === "string" ? data : JSON.stringify(data)) === text, pagedBytes: text.length }; }`;
    const compared = await session.call("execute_code", { code });
    console.log("\nprogram value vs paged handle:", compared.text.slice(0, 300));
  }
  await session.close();
} finally {
  await deployment.close();
  await world.stop();
}
