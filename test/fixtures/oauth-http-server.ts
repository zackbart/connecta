// Runs in Vitest's Node coordinator; both projects use native fetch over TCP.
import { createServer } from "node:http";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    oauthHttpServer: string;
  }
}

interface Session {
  mode: string;
  redeemed: string[];
  requests: Array<{ path: string; grant: string | null; credential: string | null }>;
  released: Promise<void>;
  release(): void;
}

export default async function setup(project: TestProject) {
  const sessions = new Map<string, Session>();
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url!, "http://localhost");
      let body = "";
      for await (const chunk of request) body += String(chunk);
      if (url.pathname === "/new" && request.method === "POST") {
        const id = crypto.randomUUID();
        let release!: () => void;
        const released = new Promise<void>((resolve) => { release = resolve; });
        sessions.set(id, { mode: body, redeemed: [], requests: [], released, release });
        response.end(JSON.stringify({ id }));
        return;
      }
      const parts = url.pathname.split("/");
      const sessionIndex = parts.indexOf("session");
      const id = parts[sessionIndex + 1];
      const operation = parts[sessionIndex + 2];
      const session = sessions.get(id!);
      if (!session) { response.writeHead(404).end(); return; }
      if (operation === "finish") {
        session.release();
        response.end("{}");
        return;
      }
      if (operation === "mode") {
        session.mode = body;
        response.end("{}");
        return;
      }
      if (session.mode.startsWith("sdk-")) {
        const origin = `http://${request.headers.host}`;
        const issuer = `${origin}/session/${id}`;
        const json = (value: unknown, status = 200, headers = {}) => {
          response.writeHead(status, { "content-type": "application/json", ...headers });
          response.end(JSON.stringify(value));
        };
        if (url.pathname.includes("/.well-known/oauth-authorization-server/")) {
          json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, registration_endpoint: `${issuer}/register`, response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"] });
          return;
        }
        if (operation === "resource") {
          json({ resource: `${issuer}/mcp`, authorization_servers: [issuer] });
          return;
        }
        if (operation === "register") {
          json({ client_id: "native-client", redirect_uris: ["https://connecta.test/oauth/callback/svc"], token_endpoint_auth_method: "none" });
          return;
        }
        if (operation === "mcp") {
          if (request.method !== "POST") { response.writeHead(405).end(); return; }
          if (request.headers.authorization !== "Bearer new-access") {
            response.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${issuer}/resource"` }).end();
            return;
          }
          const rpc = JSON.parse(body);
          if (rpc.method === "notifications/initialized") { response.writeHead(202).end(); return; }
          json({ jsonrpc: "2.0", id: rpc.id, result: rpc.method === "initialize" ? { protocolVersion: rpc.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "native-oauth", version: "1" } } : { tools: [] } });
          return;
        }
        if (operation === "api") {
          json({ ok: request.headers.authorization === "Bearer new-access" }, request.headers.authorization === "Bearer new-access" ? 200 : 401);
          return;
        }
        if (operation === "token" || operation === "token-final") {
          const form = new URLSearchParams(body);
          session.requests.push({ path: operation, grant: form.get("grant_type"), credential: form.get("refresh_token") ?? form.get("code") ?? form.get("token") });
          if (operation === "token" && session.mode.startsWith("sdk-redirect-")) {
            // A valid-looking body must never turn a redirect into a rotation.
            json({ access_token: "new-access", refresh_token: "old-refresh", token_type: "Bearer" }, Number(session.mode.slice("sdk-redirect-".length)), { location: `${issuer}/token-final` });
            return;
          }
          json({ access_token: form.get("grant_type") === "authorization_code" ? "old-access" : "new-access", refresh_token: form.get("grant_type") === "authorization_code" ? "old-refresh" : "new-refresh", token_type: "Bearer" });
          return;
        }
      }
      if (operation !== "token") {
        response.end(JSON.stringify({ redeemed: session.redeemed, requests: session.requests }));
        return;
      }
      if (request.method !== "POST") { response.writeHead(405).end(); return; }
      const form = new URLSearchParams(body);
      if (form.get("grant_type") !== "refresh_token") { response.writeHead(400).end(); return; }
      session.redeemed.push(form.get("refresh_token") ?? "");
      if (session.mode === "body-lost") {
        response.writeHead(200, { "content-type": "application/json", "content-length": "150", "x-test-buffer-body": "1" });
        response.write('{"access_token":"new-access",');
      }
      await session.released;
      if (session.mode === "lost" || session.mode === "body-lost") {
        response.destroy();
        return;
      }
      response.writeHead(session.mode === "failure-with-tokens" ? 503 : 200, { "content-type": "application/json" });
      response.end(session.mode === "malformed-success" ? "{" : JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh", token_type: "Bearer" }));
    } catch {
      response.destroy();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("OAuth HTTP fixture has no TCP address.");
  project.provide("oauthHttpServer", `http://127.0.0.1:${address.port}`);
  return async () => {
    for (const session of sessions.values()) session.release();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  };
}
