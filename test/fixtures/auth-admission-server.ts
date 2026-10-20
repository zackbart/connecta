import { createServer, type ServerResponse } from "node:http";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext { authAdmissionServer: string }
}

export default async function setup(project: TestProject) {
  const held = new Map<string, ServerResponse>();
  let calls = 0;
  const server = createServer((req, res) => {
    if (req.url === "/status") {
      res.end(JSON.stringify({ calls, ids: [...held.keys()] }));
    } else if (req.url === "/release") {
      held.forEach((response) => response.end("done"));
      res.end("{}");
    } else {
      calls++;
      const id = req.url!;
      held.set(id, res);
      res.on("close", () => held.delete(id));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing auth fixture address");
  project.provide("authAdmissionServer", `http://127.0.0.1:${address.port}`);
  return async () => {
    held.forEach((res) => res.end());
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
}
