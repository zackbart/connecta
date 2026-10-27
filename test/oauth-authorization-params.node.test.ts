// Node-only: construction-time string-map validation and description policy.
import { describe, expect, it } from "vitest";
import { api } from "../src/connectors/api.js";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { ConfigError } from "../src/config-schema.js";

const factories = {
  remoteMcp: (authorizationParams: unknown) =>
    remoteMcp("svc", {
      url: "https://mcp.example/mcp",
      auth: { type: "oauth", authorizationParams: authorizationParams as Record<string, string> },
    }),
  api: (authorizationParams: unknown) =>
    api("svc", {
      oauth: {
        authorizationEndpoint: "https://auth.example/authorize",
        tokenEndpoint: "https://auth.example/token",
        clientId: "client",
        apiOrigins: ["https://api.example"],
        authorizationParams: authorizationParams as Record<string, string>,
      },
      tools: [],
    }),
};
for (const [kind, build] of Object.entries(factories))
  describe(`${kind} authorization parameters`, () => {
    const reserved = [
      "response_type",
      "client_id",
      "client_secret",
      "redirect_uri",
      "state",
      "code_challenge",
      "code_challenge_method",
      "scope",
      "resource",
      "request",
      "request_uri",
    ];
    it.each(reserved.flatMap((name) => [name, name.toUpperCase(), name[0]!.toUpperCase() + name.slice(1)]))(
      "refuses reserved %s at construction",
      (name) => {
        expect(() => build({ [name]: "override" })).toThrow(ConfigError);
      },
    );
    it.each([
      null,
      1,
      "prompt=consent",
      [],
      new Map([["prompt", "consent"]]),
      { "": "value" },
      { "bad name": "value" },
      { "bad&name": "value" },
      { "scope%00": "value" },
      { ["a".repeat(129)]: "value" },
      { prompt: 3 },
      { prompt: null },
      { prompt: undefined },
      { prompt: true },
      { prompt: {} },
      { prompt: "" },
      { prompt: " " },
      { prompt: "a\nb" },
      { prompt: "a\u0000b" },
      { prompt: "a\u007fb" },
      { prompt: "a".repeat(2049) },
      { prompt: "consent", Prompt: "login" },
      Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`p${i}`, "value"])),
    ])("refuses malformed map %#", (value) => {
      expect(() => build(value)).toThrow(ConfigError);
    });
    it("accepts bounded, non-secret provider parameters and refuses accessors without running them", () => {
      expect(() => build({ prompt: "consent", access_type: "offline", "vendor.option-1": "é & + =" })).not.toThrow();
      expect(() =>
        build({
          get prompt() {
            throw new Error("getter ran");
          },
        }),
      ).toThrow(/plain value/);
    });
  });

it("keeps unknown auth options closed", () => {
  expect(() =>
    remoteMcp("svc", { url: "https://mcp.example/mcp", auth: { type: "oauth", authorizationParam: {} } } as never),
  ).toThrow(/Unknown option/);
});

it("describes only authorization parameter names and snapshots the configured map", () => {
  const authorizationParams = { prompt: "consent", access_type: "offline" };
  const connector = factories.remoteMcp(authorizationParams);
  authorizationParams.prompt = "login";
  expect(connector.describe!().auth).toMatchObject({
    mode: "oauth",
    authorizationParamNames: ["access_type", "prompt"],
  });
  expect(JSON.stringify(connector.describe!())).not.toContain("consent");
});
