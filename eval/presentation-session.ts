/** One deployment under a presentation arm, behind a real SDK client, for the model-free tools. */
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { PresentationArm } from "./deploy/presentation.js";
import { startDeployment, type Target } from "./deploy/targets.js";
import { NO_INJECTION } from "./fakes/injection.js";
import type { PresentationFake } from "./fakes/presentation.js";
import { World } from "./fakes/world.js";
import type { ActiveTask } from "./tasks/types.js";

const taskFor = (fake?: PresentationFake): ActiveTask => ({
  status: "active",
  id: "presentation-control",
  title: "control",
  introducedIn: "#703",
  measures: "control",
  prompt: "control",
  ...(fake ? { world: { presentationFake: fake } } : {}),
  grade: () => [],
  reference: async () => {},
});

interface Session {
  client: Client;
  world: World;
  search(args?: Record<string, unknown>): Promise<Record<string, any>>;
  program(code: string): Promise<any>;
  close(): Promise<void>;
}

export async function presentationSession(
  arm: PresentationArm,
  target: Target,
  fake?: PresentationFake,
  catalogTools = 0,
): Promise<Session> {
  const world = new World(fake ? { presentationFake: fake } : {}, { ...NO_INJECTION, catalogTools });
  await world.start();
  const deployment = await startDeployment(target, world, taskFor(fake), "six", arm);
  const client = new Client({ name: "presentation-controls", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(deployment.mcpUrl), {
      requestInit: { headers: { Authorization: `Bearer ${deployment.token}` } },
    }),
  );
  await client.listTools();
  const result = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
  return {
    client,
    world,
    search: async (args = {}) => (await result("search_tools", args)).structuredContent as Record<string, any>,
    program: async (code) => (await result("execute_code", { code })).structuredContent,
    close: async () => {
      await client.close();
      await deployment.close();
      await world.stop();
    },
  };
}
