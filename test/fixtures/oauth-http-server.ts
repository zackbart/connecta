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
        sessions.set(id, { mode: body, redeemed: [], released, release });
        response.end(JSON.stringify({ id }));
        return;
      }
      const [, , id, operation] = url.pathname.split("/");
      const session = sessions.get(id!);
      if (!session) { response.writeHead(404).end(); return; }
      if (operation === "finish") {
        session.release();
        response.end("{}");
        return;
      }
      if (operation !== "token") {
        response.end(JSON.stringify({ redeemed: session.redeemed }));
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
