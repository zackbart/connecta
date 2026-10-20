import { createServer, type ServerResponse } from "node:http";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext { authAdmissionServer: string }
}

export default async function setup(project: TestProject) {
  const held = new Map<string, ServerResponse>();
  let calls = 0;
  let sdkCalls = 0;
  let sdkPeak = 0;
  const sdkHeld = new Map<string, ServerResponse>();
  const server = createServer(async (req, res) => {
    if (req.url === "/sdk/status") {
      res.end(JSON.stringify({ calls: sdkCalls, peak: sdkPeak, ids: [...sdkHeld.keys()] }));
      return;
    }
    if (req.url === "/sdk/reset" || req.url === "/sdk/release") {
      sdkHeld.forEach((response) => response.destroy());
      if (req.url === "/sdk/reset") { sdkCalls = 0; sdkPeak = 0; }
      res.end("{}");
      return;
    }
    if (req.url?.includes("/oauth_applications/access_tokens/verify") || req.url?.includes("/jwks") || req.url?.includes("/clients/handshake_payload")) {
      let body = "";
      for await (const chunk of req) body += String(chunk);
      const token = body ? (JSON.parse(body) as { access_token?: string }).access_token : undefined;
      const id = token ?? `${req.url}-${sdkCalls}`;
      sdkCalls++;
      sdkHeld.set(id, res);
      sdkPeak = Math.max(sdkPeak, sdkHeld.size);
      res.on("close", () => sdkHeld.delete(id));
      if (token?.includes("_body_")) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.write('{"errors":[');
      }
      return;
    }
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
    sdkHeld.forEach((res) => res.destroy());
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
}
