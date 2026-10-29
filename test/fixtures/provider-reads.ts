// Maintained providers wired to reach their vendor through one stubbed fetch, so a
// test can serve any body to a real hatch read: credentials of each slot's shape,
// OAuth grants completed against a token stub, Google delegation with a fixed
// subject, and GitHub's App installation exchange.
import { expect, vi } from "vitest";
import { makeRegistry } from "../helpers.js";
import { providerFixtures } from "../providers.generated.js";
import type { Connector, ConnectorContext } from "../../src/types.js";
import { apiFixture, connection as githubConnection } from "./github-api.js";
import { connectorContext } from "./misc.js";
import { installOwnedTransport } from "./owned-transport.js";

export interface ReadWorld {
  readonly connector: Connector;
  readonly context: () => ConnectorContext;
  /** The body every later vendor read answers with. */
  serve(body: unknown): void;
}

const VALUES = {
  value: "sk_test_51fixture",
  publicKey: "pub_fixture",
  privateKey: "pri_fixture",
  clientId: "c77c8d57-7e1c-4a7e-ad46-e756e5f8dabd",
  apiKey: "fixture-api-key",
  applicationId: "fixture-application",
  secret: "fixture-secret",
};

const TOKEN = { access_token: "fixture-access", refresh_token: "fixture-refresh", expires_in: 3600, token_type: "bearer" };

/** Credential exchanges and grants answer with a token; everything else with the served body. */
function grant(url: URL, init: RequestInit | undefined): boolean {
  const body = typeof init?.body === "string" ? init.body : init?.body instanceof URLSearchParams ? `${init.body}` : "";
  return /grant_type=/.test(body) || /\/oauth2?\/.*token|\/token$/.test(url.pathname);
}

export async function readWorld(name: string): Promise<ReadWorld> {
  installOwnedTransport();
  let served: unknown = {};
  if (name === "github") {
    const api = apiFixture();
    api.respond((exchange) =>
      exchange.url.pathname.startsWith("/repos/acme/one") && exchange.method === "GET"
        ? Response.json(served)
        : undefined,
    );
    const connector = githubConnection();
    const context = connectorContext();
    return { connector, context: () => context, serve: (body) => void (served = body) };
  }
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return grant(url, init) ? Response.json(TOKEN) : Response.json(served);
  });
  const fixture = providerFixtures.find((entry) => entry.name === name)!;
  const google = "serviceAccount" in (fixture.options as object);
  const connector = (fixture.create as (id: string, overrides?: object) => Connector)(
    "fixture",
    google ? { subject: "alice@example.com" } : {},
  );
  const registry = makeRegistry([connector]);
  const credential = { get: async () => VALUES.value, getAll: async () => ({ ...VALUES }) };
  const context = () => ({ ...registry.contextFor("fixture", "https://connecta.example"), credential });
  if (connector.startAuth && connector.finishAuth) {
    const started = await connector.startAuth(context());
    const state = new URL(started.authorizationUrl!).searchParams.get("state")!;
    await connector.verifyState?.(state, context());
    await connector.finishAuth("fixture-code", context(), new URLSearchParams({ state, realmId: "123456789" }));
  }
  return { connector, context, serve: (body) => void (served = body) };
}

/** Every value at a `fields` path, through lists; a missing step reads as the marker. */
export function valuesAt(root: unknown, path: string): unknown[] {
  let values: unknown[] = [root];
  for (const name of path.split(".").map((part) => part.replace(/\[\]$/, ""))) {
    values = values
      .flatMap((value) => (Array.isArray(value) ? value : [value]))
      .map((value) =>
        value !== null && typeof value === "object" && Object.hasOwn(value, name)
          ? (value as Record<string, unknown>)[name]
          : "<missing>",
      );
  }
  return values;
}

/** A body holding `leaf(i)` at every declared path, one item per list, in the response's coordinates. */
export function populated(
  response: { readonly anchor: "data" | "data[]"; readonly fields: readonly string[]; readonly withheld?: readonly string[] },
  leaf: (index: number) => unknown,
  fixed: Readonly<Record<string, unknown>> = {},
): unknown {
  const root: Record<string, unknown> = {};
  const lists = new Set<string>();
  const paths = [...response.fields, ...(response.withheld ?? [])];
  for (const path of paths)
    path.split(".").forEach((part, at, parts) => {
      if (part.endsWith("[]"))
        lists.add(
          parts
            .slice(0, at + 1)
            .map((name) => name.replace(/\[\]$/, ""))
            .join("."),
        );
    });
  const containers = new Set(paths.flatMap((path) => path.split(".").slice(0, -1).map((_, at, parts) => parts.slice(0, at + 1).map((part) => part.replace(/\[\]$/, "")).join("."))));
  paths.forEach((path, index) => {
    const names = path.split(".").map((part) => part.replace(/\[\]$/, ""));
    let at: Record<string, unknown> = root;
    names.forEach((name, depth) => {
      const key = names.slice(0, depth + 1).join(".");
      const last = depth === names.length - 1;
      if (!Object.hasOwn(at, name)) {
        const value = containers.has(key) ? {} : Object.hasOwn(fixed, name) ? fixed[name] : leaf(index);
        at[name] = lists.has(key) ? [value] : value;
      }
      if (!last) {
        const next = at[name];
        at = (Array.isArray(next) ? next[0] : next) as Record<string, unknown>;
      }
    });
  });
  return response.anchor === "data[]" ? [root] : root;
}

/**
 * Hold one operation's details to an actual vendor body: each named path is a
 * selectable field (and in the `withheld` hint where `hinted`), the contract
 * makes no readability promise, and a real read selecting the paths returns
 * none of `secrets` and changes the value at each.
 */
export async function expectRedactedOnRead(options: {
  readonly details: () => Promise<any>;
  readonly read: (fields: readonly string[]) => Promise<any>;
  readonly body: unknown;
  readonly paths: readonly string[];
  readonly hinted?: readonly string[];
  readonly secrets: readonly string[];
}): Promise<void> {
  const response = (await options.details()).response;
  for (const path of options.paths) expect(response.fields, path).toContain(path);
  for (const path of options.hinted ?? []) expect(response.withheld, path).toContain(path);
  for (const path of response.withheld ?? []) expect(response.fields, path).toContain(path);
  const read = await options.read(options.paths);
  const text = JSON.stringify(read);
  for (const secret of options.secrets) expect(text).not.toContain(secret);
  for (const path of options.paths) expect(valuesAt(read.data, path), path).not.toEqual(valuesAt(options.body, path));
}
