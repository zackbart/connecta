// Every /mcp request builds a fresh McpServer, and the SDK renders each
// registered tool's input schema at registration and again for tools/list.
// The seven meta-tool inputs are module constants, so that rendering is
// derived once per process and reused. This suite counts zod's own JSON
// Schema conversions to prove it, and checks that what legitimately varies —
// descriptions by deployment and by identity-scoped view — still does.

import { describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { api } from "../src/connectors/api.js";
import type { Connector, Executor, InboundAuth } from "../src/types.js";
import { calcApi, makeDeployment, mcpRpc, readJsonRpc } from "./fixtures/http.js";

const conversions = vi.hoisted(() => ({ count: 0 }));

// Count every JSON Schema conversion of a zod object built through the "zod"
// specifier connecta's source imports. Only roots are wrapped: converting a
// root walks its fields internally, so one root conversion counts once.
vi.mock("zod", async (importOriginal) => {
  const actual = await importOriginal<typeof import("zod")>();
  type Converter = Record<"input" | "output", (options: unknown) => unknown>;
  const counted =
    <A extends unknown[], S extends z.ZodType>(make: (...args: A) => S) =>
    (...args: A): S => {
      const schema = make(...args);
      const converter = schema["~standard"].jsonSchema as unknown as Converter;
      for (const io of ["input", "output"] as const) {
        const convert = converter[io];
        converter[io] = (options) => {
          conversions.count++;
          return convert(options);
        };
      }
      return schema;
    };
  return {
    ...actual,
    z: {
      ...actual.z,
      object: counted(actual.z.object),
      strictObject: counted(actual.z.strictObject),
    },
  };
});

const TOKEN = "test-token-123";
const META_TOOLS = 7;

const stubExecutor: Executor = {
  execute: async () => ({ result: null }),
};

type ListedTool = { name: string; description: string; inputSchema: unknown };
type Listing = Record<
  | "skills"
  | "search_tools"
  | "call_tool"
  | "call_destructive_tool"
  | "authorize_connector"
  | "get_result"
  | "execute_code",
  ListedTool
>;

async function listTools(
  deployment: Parameters<typeof mcpRpc>[0],
  token = TOKEN,
): Promise<Listing> {
  const body = await readJsonRpc(
    await mcpRpc(deployment, "tools/list", {}, { token }),
  );
  return Object.fromEntries(
    (body.result.tools as ListedTool[]).map((tool) => [tool.name, tool]),
  ) as Listing;
}

function schemasOf(tools: Listing) {
  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => [name, tool.inputSchema]),
  );
}

function guided(id: string): Connector {
  return api(id, {
    description: id,
    usageGuide: `Read ${id} records newest first.`,
    tools: [],
  });
}

describe("meta-tool input schema rendering", () => {
  it("converts each meta-tool input schema once across many requests, and still validates calls", async () => {
    const deployment = makeDeployment({ executor: stubExecutor });
    const first = schemasOf(await listTools(deployment));
    expect(Object.keys(first)).toHaveLength(META_TOOLS);

    for (let i = 0; i < 20; i++) {
      expect(schemasOf(await listTools(deployment))).toStrictEqual(first);
      const valid = await readJsonRpc(
        await mcpRpc(
          deployment,
          "tools/call",
          { name: "call_tool", arguments: { address: "calc.add", args: { a: 1, b: 2 } } },
          { token: TOKEN },
        ),
      );
      expect(valid.result.isError).toBeFalsy();
      // call_tool's input is strict: an unknown key is still refused by the
      // cached schema's validation, exactly as zod refused it before.
      const invalid = await readJsonRpc(
        await mcpRpc(
          deployment,
          "tools/call",
          { name: "call_tool", arguments: { address: "calc.add", extra: true } },
          { token: TOKEN },
        ),
      );
      expect(JSON.stringify(invalid)).toContain("Input validation error");
    }

    expect(conversions.count).toBe(META_TOOLS);
    await deployment.close();
  });

  it("keeps per-deployment and per-identity descriptions while sharing one rendering", async () => {
    const plain = makeDeployment({ executor: stubExecutor });
    const tuned = makeDeployment({
      executor: stubExecutor,
      connectors: [calcApi(), guided("notes")],
      execute: { maxHostCalls: 7 },
    });
    const users: InboundAuth = {
      kind: "test-users",
      authorize(request) {
        const user = /^Bearer (alice|bob)$/u.exec(
          request.headers.get("authorization") ?? "",
        )?.[1];
        return user
          ? { ok: true, userId: user, subjectId: user }
          : { ok: false, response: new Response(null, { status: 401 }) };
      },
    };
    const scoped = makeDeployment({
      executor: stubExecutor,
      connectors: [calcApi(), guided("notes")],
      auth: users,
      identity: {
        connectorAccess: ({ subject }) =>
          subject?.id === "alice" ? ["calc", "notes"] : ["calc"],
      },
    });

    const base = await listTools(plain);
    const variant = await listTools(tuned);
    const alice = await listTools(scoped, "alice");
    const bob = await listTools(scoped, "bob");

    // Deployment configuration reaches descriptions...
    expect(base.skills.description).not.toContain("connector guides");
    expect(variant.skills.description).toContain("connector guides");
    expect(base.execute_code.description).not.toContain("7 host calls");
    expect(variant.execute_code.description).toContain("7 host calls");
    expect(variant.execute_code.description).toContain("notes");
    // ...and so does the identity's scoped view, request by request.
    expect(alice.search_tools.description).toContain("guideRequired");
    expect(bob.search_tools.description).not.toContain("guideRequired");
    expect(alice.execute_code.description).toContain("notes");
    expect(bob.execute_code.description).not.toContain("notes");
    // Bob's view matches a deployment that never had the guided connector.
    expect(bob.call_destructive_tool.description).toBe(
      base.call_destructive_tool.description,
    );

    // Input schemas never vary, so all four share the one rendering.
    for (const tools of [variant, alice, bob]) {
      expect(schemasOf(tools)).toStrictEqual(schemasOf(base));
    }
    expect(conversions.count).toBe(META_TOOLS);
    await Promise.all([plain.close(), tuned.close(), scoped.close()]);
  });
});
