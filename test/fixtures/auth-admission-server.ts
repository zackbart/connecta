import { randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext { authAdmissionServer: string }
}

export default async function setup(project: TestProject) {
  const mcpWrites = new Map<string, string[]>();
  const bindingHeld = new Map<string, ServerResponse>();
  let bindingCalls = 0;
  let bindingPeak = 0;
  const held = new Map<string, ServerResponse>();
  let calls = 0;
  let sdkCalls = 0;
  let sdkPeak = 0;
  const sdkHeld = new Map<string, ServerResponse>();
  const submissionHeld = new Map<string, ServerResponse>();
  const prefix = `/trial-${randomUUID()}`;
  const server = createServer(async (req, res) => {
    const attributed = req.url?.startsWith(`${prefix}/`) === true;
    if (attributed) req.url = req.url!.slice(prefix.length);
    // A stateful MCP downstream for program writes, answering over SSE. Each
    // tools/call is logged as it arrives; `iserror` answers id "refused" with
    // the tool's own error, as a hosted server does, without applying it.
    if (req.url?.startsWith("/executor/mcp/")) {
      const mode = req.url.split("/")[3]!;
      if (req.url.endsWith("/writes")) {
        res.end(JSON.stringify(mcpWrites.get(mode) ?? []));
        return;
      }
      if (req.method === "GET") {
        res.writeHead(405).end();
        return;
      }
      if (req.method === "DELETE") {
        res.end();
        return;
      }
      let body = "";
      for await (const chunk of req) body += String(chunk);
      const rpc = JSON.parse(body) as {
        id?: number;
        method: string;
        params?: { protocolVersion?: string; arguments?: { id?: string } };
      };
      if (rpc.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      if (rpc.method === "initialize") res.setHeader("Mcp-Session-Id", randomUUID());
      else if (!req.headers["mcp-session-id"]) {
        res.writeHead(400).end("{}");
        return;
      }
      const written = rpc.params?.arguments?.id;
      if (rpc.method === "tools/call") mcpWrites.set(mode, [...(mcpWrites.get(mode) ?? []), String(written)]);
      const result =
        rpc.method === "initialize"
          ? {
              protocolVersion: rpc.params?.protocolVersion ?? "2025-11-25",
              capabilities: { tools: {} },
              serverInfo: { name: "fixture", version: "1" },
            }
          : rpc.method === "tools/list"
            ? {
                tools: [
                  {
                    name: "create",
                    inputSchema: { type: "object" },
                    annotations: { readOnlyHint: false, destructiveHint: true },
                  },
                ],
              }
            : rpc.method === "tools/call" && written === "refused"
              ? { isError: true, content: [{ type: "text", text: "Vendor refused this request" }] }
              : rpc.method === "tools/call" && written === "approval"
                ? {
                    isError: true,
                    content: [
                      { type: "text", text: `Approval required. ${"This write needs a person. ".repeat(40)}` },
                      { type: "text", text: "Request apr_7Hq2: https://vendor.example/approve/apr_7Hq2?sig=c0ffee" },
                    ],
                  }
              : rpc.method === "tools/call"
                ? { content: [{ type: "text", text: JSON.stringify({ created: written }) }] }
                : undefined;
      if (!result) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "Method not found" } }));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result })}\n\n`);
      return;
    }
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
      if (!attributed) { req.resume(); res.writeHead(421).end(); return; }
      calls++;
      const id = req.url!;
      held.set(id, res);
      res.on("close", () => held.delete(id));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing auth fixture address");
  project.provide("authAdmissionServer", `http://127.0.0.1:${address.port}${prefix}`);
  return async () => {
    bindingHeld.forEach((res) => res.end());
    held.forEach((res) => res.end());
    sdkHeld.forEach((res) => res.destroy());
    submissionHeld.forEach((res) => res.end());
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
}
