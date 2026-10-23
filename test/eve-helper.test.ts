// `@zackbart/connecta/eve` against stand-ins for the three eve modules it
// imports: eve is the deployment's install, never this repository's. The V1
// Eve harness typechecks the emitted declarations against real eve 0.83.0.

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("eve/connections", () => ({
  defineMcpClientConnection: (definition: object) => ({ ...definition, defined: "mcp" }),
}));
vi.mock("eve/instructions", () => ({
  defineInstructions: (definition: object) => ({ ...definition, branded: true }),
  defineDynamic: (definition: { events: object }) => ({ kind: "dynamic", events: definition.events }),
}));
vi.mock("eve/tools/approval", () => ({ never: () => () => "not-applicable" }));

const { connectaConnection, connectaEndpoint, connectaInstructions, gateConnectaWrites } =
  await import("../src/eve.js");

afterEach(() => {
  vi.unstubAllEnvs();
});

function answering(instructions: unknown, status = 200) {
  const seen: Array<{ url: string; authorization: string | null; body: unknown }> = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({
      url: String(input),
      authorization: new Headers(init?.headers).get("Authorization"),
      body: JSON.parse(String(init?.body)),
    });
    return Response.json({ jsonrpc: "2.0", id: 1, result: { instructions } }, { status });
  };
  return { fetch: fetch as typeof globalThis.fetch, seen };
}

describe("@zackbart/connecta/eve", () => {
  it("names the agent endpoint from a base URL and pool", () => {
    expect(connectaEndpoint({ url: "https://connecta.example.com/", pool: "assistant" })).toBe(
      "https://connecta.example.com/agent/assistant",
    );
    expect(connectaEndpoint({ url: "https://connecta.example.com/agent/assistant" })).toBe(
      "https://connecta.example.com/agent/assistant",
    );
    vi.stubEnv("CONNECTA_URL", "https://connecta.example.com");
    expect(connectaEndpoint({ pool: "assistant" })).toBe("https://connecta.example.com/agent/assistant");
    expect(() => connectaEndpoint({ pool: "../mcp" })).toThrow("must match [a-z0-9_-]+");
    vi.stubEnv("CONNECTA_URL", "");
    expect(() => connectaEndpoint({ pool: "assistant" })).toThrow("CONNECTA_URL");
  });

  it("defines an app-owned connection whose token is read on every request", async () => {
    vi.stubEnv("CONNECTA_ACCESS_TOKEN", "cta_first");
    const connection = connectaConnection({
      url: "https://connecta.example.com",
      pool: "assistant",
      description: "CRM and tickets.",
    }) as unknown as {
      defined: string;
      url: string;
      description: string;
      auth: { credentialOwner: string; getToken: () => Promise<{ token: string }> };
      approval: (context: { toolName: string }) => unknown;
    };
    expect(connection).toMatchObject({
      defined: "mcp",
      url: "https://connecta.example.com/agent/assistant",
      description: "CRM and tickets.",
      auth: { credentialOwner: "app" },
    });
    expect(await connection.auth.getToken()).toEqual({ token: "cta_first" });
    vi.stubEnv("CONNECTA_ACCESS_TOKEN", "cta_rotated");
    expect(await connection.auth.getToken()).toEqual({ token: "cta_rotated" });
    // Approval defaults to never().
    expect(connection.approval({ toolName: "connecta__crm__create_person" })).toBe("not-applicable");
    vi.stubEnv("CONNECTA_ACCESS_TOKEN", "");
    await expect(connection.auth.getToken()).rejects.toThrow("CONNECTA_ACCESS_TOKEN");
  });

  it("gates every tool not annotated read-only when asked", () => {
    expect(gateConnectaWrites({ toolName: "a", toolAnnotations: { readOnlyHint: true } })).toBe("not-applicable");
    expect(gateConnectaWrites({ toolName: "b", toolAnnotations: { readOnlyHint: false, destructiveHint: true } })).toBe(
      "user-approval",
    );
    expect(gateConnectaWrites({ toolName: "c" })).toBe("user-approval");
    const gated = connectaConnection({ url: "https://c.example", description: "x", gateWrites: true }) as unknown as {
      approval: unknown;
    };
    expect(gated.approval).toBe(gateConnectaWrites);
    const custom = () => "approved" as const;
    const explicit = connectaConnection({
      url: "https://c.example",
      description: "x",
      gateWrites: true,
      approval: custom,
    }) as unknown as { approval: unknown };
    expect(explicit.approval).toBe(custom);
  });

  it("injects the endpoint's instructions at turn start and caches each success", async () => {
    const { fetch, seen } = answering("Each tool here is one downstream operation.");
    const sentinel = connectaInstructions({
      url: "https://connecta.example.com",
      pool: "assistant",
      getToken: () => "cta_agent",
      fetch,
    }) as unknown as { kind: string; events: { "turn.started": () => Promise<unknown> } };
    expect(sentinel.kind).toBe("dynamic");
    const first = await sentinel.events["turn.started"]();
    expect(first).toEqual({
      content: "Connecta guidance:\nEach tool here is one downstream operation.",
      branded: true,
    });
    expect(await sentinel.events["turn.started"]()).toEqual(first);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      url: "https://connecta.example.com/agent/assistant",
      authorization: "Bearer cta_agent",
      body: { method: "initialize" },
    });
  });

  it("adds nothing when instructions are unavailable, and keeps the last copy after a failure", async () => {
    const unavailable = connectaInstructions({
      url: "https://c.example",
      getToken: () => "cta_agent",
      fetch: answering(undefined, 503).fetch,
    }) as unknown as { events: { "turn.started": () => Promise<unknown> } };
    expect(await unavailable.events["turn.started"]()).toBeNull();

    let fail = false;
    const flaky = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (fail) throw new Error("network down");
      return answering("Guidance.").fetch(input, init);
    }) as typeof globalThis.fetch;
    const kept = connectaInstructions({
      url: "https://c.example",
      getToken: () => "cta_agent",
      fetch: flaky,
      ttlMs: 0,
    }) as unknown as { events: { "turn.started": () => Promise<unknown> } };
    const first = await kept.events["turn.started"]();
    fail = true;
    expect(await kept.events["turn.started"]()).toEqual(first);
  });
});
