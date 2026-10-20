// Runs in Vitest's Node coordinator. A stand-in for Clerk's Backend API that
// the `clerk-organization` Worker reaches over TCP: the workers project sends
// that Worker's outbound fetches here (vitest.config.ts), so a lookup goes
// through workerd's own Request and fetch. Tests script and inspect it per
// user through `/control/`.
import { createServer, type ServerResponse } from "node:http";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    clerkBackendServer: string;
  }
}

type Step = "member" | "non-member" | "redirect" | "hold" | "valid";

interface Exchange {
  path: string;
  outcome: "pending" | "answered" | "closed";
}

interface User {
  /** Answers for this user's lookups, in order; then `non-member` (`valid` for verification). */
  script: Step[];
  verifications: Step[];
  exchanges: Exchange[];
  held: Map<number, (member: boolean) => void>;
}

export default async function setup(project: TestProject) {
  const users = new Map<string, User>();
  const user = (id: string): User => {
    let found = users.get(id);
    if (!found) {
      found = { script: [], verifications: [], exchanges: [], held: new Map() };
      users.set(id, found);
    }
    return found;
  };

  // A held answer may be released after its caller has gone.
  const json = (response: ServerResponse, status: number, value: unknown, headers = {}) => {
    if (response.destroyed) return;
    response.writeHead(status, { "content-type": "application/json", ...headers });
    response.end(JSON.stringify(value));
  };

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url!, "http://localhost");
      let body = "";
      for await (const chunk of request) body += String(chunk);
      const control = /^\/control\/(script|verifications|release|log)\/([^/]+)(?:\/(\d+))?$/.exec(url.pathname);
      if (control) {
        const [, operation, id, index] = control;
        const target = user(id!);
        if (operation === "script") target.script.push(...(JSON.parse(body) as Step[]));
        if (operation === "verifications") target.verifications.push(...(JSON.parse(body) as Step[]));
        if (operation === "release") target.held.get(Number(index))?.(body === "member");
        json(response, 200, operation === "log" ? target.exchanges : {});
        return;
      }

      // Everything else is the Clerk Backend API, which the Worker asked for
      // by its own host name.
      const exchange: Exchange = { path: `${request.headers.host}${url.pathname}${url.search}`, outcome: "pending" };
      response.on("close", () => {
        exchange.outcome = response.writableFinished ? "answered" : "closed";
      });
      const membership = /^\/v1\/organizations\/([^/]+)\/memberships$/.exec(url.pathname);
      if (membership) {
        const id = url.searchParams.get("user_id")!;
        const target = user(id);
        const index = target.exchanges.push(exchange) - 1;
        let step = target.script.shift() ?? "non-member";
        if (step === "hold") {
          step = await new Promise<boolean>((resolve) => target.held.set(index, resolve)).then((member) =>
            member ? "member" : "non-member",
          );
        }
        if (step === "redirect") {
          json(response, 302, {}, { location: `https://api.clerk.com/v1/followed/${id}` });
          return;
        }
        const data =
          step === "member"
            ? [
                {
                  object: "organization_membership",
                  organization: { object: "organization", id: membership[1] },
                  public_user_data: { user_id: id },
                },
              ]
            : [];
        json(response, 200, { data, total_count: data.length });
        return;
      }
      if (url.pathname === "/v1/oauth_applications/access_tokens/verify") {
        const token = (JSON.parse(body) as { access_token: string }).access_token;
        const id = token.slice("oat_".length);
        const target = user(id);
        target.exchanges.push(exchange);
        if ((target.verifications.shift() ?? "valid") === "redirect") {
          json(response, 302, {}, { location: `https://api.clerk.com/v1/followed/${id}` });
          return;
        }
        json(response, 200, {
          object: "clerk_idp_oauth_access_token",
          client_id: "client_connecta",
          subject: id,
          aud: ["https://connecta.test/mcp"],
          revoked: false,
          expired: false,
        });
        return;
      }
      // A followed redirect, or anything else, is recorded against the user
      // the path names and refused.
      const followed = /^\/v1\/followed\/([^/]+)$/.exec(url.pathname)?.[1];
      if (followed) user(followed).exchanges.push(exchange);
      json(response, 404, {});
    } catch {
      response.destroy();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Clerk Backend API fixture has no TCP address.");
  project.provide("clerkBackendServer", `127.0.0.1:${address.port}`);
  return async () => {
    for (const target of users.values()) for (const release of target.held.values()) release(false);
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  };
}
