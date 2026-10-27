import { createServer, type ServerResponse } from "node:http";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext { authAdmissionServer: string }
}

export default async function setup(project: TestProject) {
  const bindingHeld = new Map<string, ServerResponse>();
  let bindingCalls = 0;
  let bindingPeak = 0;
  const held = new Map<string, ServerResponse>();
  let calls = 0;
  let sdkCalls = 0;
  let sdkPeak = 0;
  const sdkHeld = new Map<string, ServerResponse>();
  const submissionHeld = new Map<string, ServerResponse>();
  const server = createServer(async (req, res) => {
    // A slow downstream for overlapping Worker programs: each host call is a
    // real TCP request answered only after its own delay.
    if (req.url?.startsWith("/executor/slow")) {
      const url = new URL(req.url, "http://fixture");
      const timer = setTimeout(() => res.end(JSON.stringify({ id: url.searchParams.get("id") })), Number(url.searchParams.get("ms") ?? 0));
      res.on("close", () => clearTimeout(timer));
      return;
    }
    // Independent of admission's counted waves: a submitted native operation
    // must let another real request run while its TCP response is pending.
    if (req.url?.startsWith("/submission/")) {
      const url = new URL(req.url, "http://fixture");
      if (url.pathname === "/submission/status") {
        res.end(JSON.stringify({ ids: [...submissionHeld.keys()] }));
      } else if (url.pathname === "/submission/release") {
        submissionHeld.get(url.searchParams.get("id")!)?.end("done");
        res.end("{}");
      } else {
        submissionHeld.set(url.pathname, res);
        res.on("close", () => submissionHeld.delete(url.pathname));
      }
      return;
    }
    // A native binding stand-in: each held id ends only on explicit release,
    // never because its Worker caller disconnected.
    if (req.url?.startsWith("/binding/")) {
      const url = new URL(req.url, "http://fixture");
      if (url.pathname === "/binding/status") {
        res.end(JSON.stringify({ calls: bindingCalls, peak: bindingPeak, ids: [...bindingHeld.keys()] }));
        return;
      }
      if (url.pathname === "/binding/release" || url.pathname === "/binding/reset") {
        const id = url.searchParams.get("id");
        if (id) bindingHeld.get(id)?.end("done");
        else bindingHeld.forEach((response) => response.end("done"));
        if (url.pathname === "/binding/reset") {
          bindingCalls = 0;
          bindingPeak = 0;
        }
        res.end("{}");
        return;
      }
      if (url.pathname === "/binding/fast") {
        res.end("done");
        return;
      }
      bindingCalls++;
      bindingHeld.set(url.pathname, res);
      bindingPeak = Math.max(bindingPeak, bindingHeld.size);
      res.on("close", () => bindingHeld.delete(url.pathname));
      return;
    }
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
    bindingHeld.forEach((res) => res.end());
    held.forEach((res) => res.end());
    sdkHeld.forEach((res) => res.destroy());
    submissionHeld.forEach((res) => res.end());
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
}
