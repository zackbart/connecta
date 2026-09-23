import { describe, expect, it, vi } from "vitest";
import { bearerToken } from "../src/auth/bearer.js";
import { api } from "../src/connectors/api.js";
import { memoryStorage } from "../src/storage/memory.js";
import { isExplicitlyReadOnly } from "../src/tool-safety.js";
import type { Connector, ToolDef } from "../src/types.js";
import { uiProblemFor, uiToolSafety } from "../src/ui.js";
import type { UiConnector, UiData, UiProblem } from "../src/operator-ui/model.js";
import {
  clientServerName,
  clientSetupCommands,
  poolEndpointUrl,
} from "../src/operator-ui/setup-commands.js";
import { problemCopy, TOOL_SAFETY_BADGE } from "../src/operator-ui/view.js";
import { createTestConnecta, fetchTestUiDetails, silentLogger } from "./helpers.js";

const BASE = "https://connecta.test";
const TOKEN = "model-token";

function docsApi() {
  return api("docs", {
    description: "Docs",
    tools: [
      {
        name: "read",
        description: "Read a document",
        annotations: { readOnlyHint: true },
        handler: () => ({}),
      },
      {
        name: "erase",
        description: "Erase a document",
        annotations: { readOnlyHint: false, destructiveHint: true },
        handler: () => ({}),
      },
    ],
  });
}

function throwingCatalog(): Connector {
  return {
    id: "flaky",
    async status() {
      return { state: "ok" };
    },
    async listTools() {
      throw new Error("catalog body: sk_live_leaked");
    },
    async callTool() {
      return {};
    },
  };
}

async function uiData(connecta: { fetch(request: Request): Promise<Response> }): Promise<UiData> {
  const res = await fetchTestUiDetails(
    connecta,
    new Request(`${BASE}/ui/data`, { headers: { Authorization: `Bearer ${TOKEN}` } }),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as UiData;
}

describe("tool safety classification", () => {
  const cases: Array<[string, ToolDef["annotations"]]> = [
    ["explicit read-only", { readOnlyHint: true }],
    ["read-only and destructive", { readOnlyHint: true, destructiveHint: true }],
    ["explicit write", { readOnlyHint: false }],
    ["destructive only", { destructiveHint: true }],
    ["no hints", {}],
    ["no annotations", undefined],
  ];

  it.each(cases)("agrees with the core predicate: %s", (_, annotations) => {
    const tool: ToolDef = { name: "t", ...(annotations ? { annotations } : {}) };
    expect(uiToolSafety(tool)).toBe(
      isExplicitlyReadOnly(tool) ? "runs_in_programs" : "needs_approval",
    );
  });

  it("fails closed on anything short of an explicit, uncontradicted read-only hint", () => {
    expect(uiToolSafety({ name: "t", annotations: { readOnlyHint: true } })).toBe("runs_in_programs");
    for (const [, annotations] of cases.slice(1)) {
      expect(uiToolSafety({ name: "t", ...(annotations ? { annotations } : {}) })).toBe("needs_approval");
    }
  });

  it("has a badge for every classification the server can send", () => {
    for (const safety of ["runs_in_programs", "needs_approval"] as const) {
      expect(TOOL_SAFETY_BADGE[safety].label.length).toBeGreaterThan(0);
    }
  });

  it("ships the classification in connector details", async () => {
    const connecta = createTestConnecta({
      connectors: [docsApi()],
      auth: bearerToken(TOKEN),
      storage: memoryStorage(),
      publicUrl: BASE,
    });
    const data = await uiData(connecta);
    const docs = data.connectors.find((c) => c.id === "docs")!;
    expect(docs.tools.map(({ address, safety }) => ({ address, safety }))).toEqual([
      { address: "docs.read", safety: "runs_in_programs" },
      { address: "docs.erase", safety: "needs_approval" },
    ]);
  });
});

describe("connector problem classification", () => {
  const oauth = { startAuth: async () => ({ state: "auth_required" as const }) };
  const credential = { credential: { label: "API key" } };
  const plain = {};
  const clean = { credentialDrift: false, catalogFailed: false };

  it("keys a problem off status and declared auth shape, never a message", () => {
    expect(uiProblemFor(plain, "ok", clean)).toBeUndefined();
    expect(uiProblemFor(plain, "error", clean)).toBe("connector_unavailable");
    expect(uiProblemFor(oauth, "auth_required", clean)).toBe("oauth_required");
    expect(uiProblemFor(credential, "auth_required", clean)).toBe("credential_required");
    expect(uiProblemFor(plain, "auth_required", clean)).toBe("auth_required");
    expect(uiProblemFor(credential, "auth_required", { ...clean, credentialDrift: true })).toBe(
      "credential_mismatch",
    );
    expect(uiProblemFor(plain, "ok", { ...clean, catalogFailed: true })).toBe("catalog_failed");
  });

  it("reports a failed catalog behind an ok status, and nothing for a healthy one", async () => {
    const connecta = createTestConnecta({
      connectors: [docsApi(), throwingCatalog()],
      auth: bearerToken(TOKEN),
      storage: memoryStorage(),
      publicUrl: BASE,
    });
    const byId = Object.fromEntries(
      (await uiData(connecta)).connectors.map((c): [string, UiConnector] => [c.id, c]),
    );
    expect(byId.docs!.problem).toBeUndefined();
    expect(byId.flaky!.status).toBe("ok");
    expect(byId.flaky!.problem).toBe("catalog_failed");
    expect(byId.flaky!.tools).toEqual([]);
  });
});

describe("connector status messages", () => {
  /** A downstream error body that quotes the secret it rejected. */
  const LEAK = "fetch failed: 503 upstream connect error (token sk_live_abc123)";
  const SECRET = "sk_live_abc123";

  function withStatus(id: string, status: NonNullable<Connector["status"]>): Connector {
    return {
      id,
      status,
      async listTools() {
        return [];
      },
      async callTool() {
        return {};
      },
    };
  }

  it("has fixed on-screen copy for every problem the server can classify, and nothing else", () => {
    const problems: UiProblem[] = [
      "connector_unavailable",
      "oauth_required",
      "credential_required",
      "auth_required",
      "credential_mismatch",
      "catalog_failed",
    ];
    for (const problem of problems) {
      const copy = problemCopy(problem);
      expect(copy, problem).toMatch(/\S/);
      expect(copy).not.toMatch(/https?:\/\//);
    }
    expect(problemCopy(undefined)).toBeNull();
  });

  it("classifies a status message into the payload and logs it instead of shipping it", async () => {
    const warn = vi.fn();
    const info = vi.fn();
    const connecta = createTestConnecta({
      connectors: [
        withStatus("down", async () => ({ state: "error", message: LEAK })),
        withStatus("thrown", async () => {
          throw new Error(LEAK);
        }),
        withStatus("locked", async () => ({ state: "auth_required", message: LEAK })),
        withStatus("fine", async () => ({ state: "ok", message: `Connected with ${SECRET}` })),
      ],
      auth: bearerToken(TOKEN),
      storage: memoryStorage(),
      publicUrl: BASE,
      logger: { ...silentLogger, warn, info },
    });
    warn.mockClear();
    info.mockClear();

    const headers = { Authorization: `Bearer ${TOKEN}` };
    const bodies: string[] = [];
    const summary = await connecta.fetch(new Request(`${BASE}/ui/data`, { headers }));
    bodies.push(await summary.text());
    const details: Record<string, UiConnector> = {};
    for (const id of ["down", "thrown", "locked", "fine"]) {
      const res = await connecta.fetch(new Request(`${BASE}/ui/connectors/${id}`, { headers }));
      expect(res.status).toBe(200);
      const text = await res.text();
      bodies.push(text);
      details[id] = JSON.parse(text) as UiConnector;
    }

    // Neither the summary nor any detail carries the text, or a field for it.
    for (const body of bodies) {
      expect(body).not.toContain(SECRET);
      expect(body).not.toContain("upstream connect error");
      expect(body).not.toContain('"message"');
    }
    expect(details.down).toMatchObject({ status: "error", problem: "connector_unavailable" });
    expect(details.thrown).toMatchObject({ status: "error", problem: "connector_unavailable" });
    expect(details.locked).toMatchObject({ status: "auth_required", problem: "auth_required" });
    expect(details.fine!.problem).toBeUndefined();

    // What the page renders for each is the fixed copy for its kind.
    for (const id of ["down", "thrown", "locked"]) {
      const copy = problemCopy(details[id]!.problem);
      expect(copy).toBeTruthy();
      expect(copy).not.toContain(SECRET);
    }

    // The raw detail is on the host, where an operator debugging it looks.
    const warned = warn.mock.calls.map((call) => String(call[0]));
    expect(warned.filter((line) => line.includes(LEAK)).map((line) => line.split(":")[0])).toEqual([
      '[connecta] connector "down" operator status error',
      '[connecta] connector "thrown" operator status error',
    ]);
    const informed = info.mock.calls.map((call) => String(call[0]));
    expect(informed).toContain(`[connecta] connector "locked" operator status auth_required: ${LEAK}`);
    // An ok status's message is informational and goes nowhere.
    expect([...warned, ...informed].some((line) => line.includes("Connected with"))).toBe(false);
  });
});

describe("pools on the operator page", () => {
  it("lists only the pools this identity's grant admits", async () => {
    const connecta = createTestConnecta({
      connectors: [docsApi()],
      auth: bearerToken(TOKEN),
      storage: memoryStorage(),
      publicUrl: BASE,
      pools: {
        support: { tools: ["docs"], grant: () => true },
        finance: { tools: ["docs.read"], grant: async () => true },
        closed: { tools: ["docs"], grant: () => false },
        broken: {
          tools: ["docs"],
          grant: () => {
            throw new Error("grant failed");
          },
        },
        ungranted: { tools: ["docs"] },
      },
    });
    expect((await uiData(connecta)).pools).toEqual(["support", "finance"]);
  });

  it("omits the field when no pool is declared", async () => {
    const connecta = createTestConnecta({
      connectors: [docsApi()],
      auth: bearerToken(TOKEN),
      storage: memoryStorage(),
      publicUrl: BASE,
    });
    expect((await uiData(connecta)).pools).toBeUndefined();
  });
});

describe("client setup commands", () => {
  it("renders Claude Code, Codex, and JSON for one endpoint", () => {
    const commands = clientSetupCommands("acme-tools", "https://mcp.example.com/mcp");
    expect(commands.map((c) => c.id)).toEqual(["claude", "codex", "json"]);
    expect(commands[0]!.text).toBe(
      "claude mcp add --transport http acme-tools https://mcp.example.com/mcp",
    );
    expect(commands[1]!.text).toBe(
      "codex mcp add acme-tools --url https://mcp.example.com/mcp",
    );
    expect(JSON.parse(commands[2]!.text)).toEqual({
      mcpServers: { "acme-tools": { type: "http", url: "https://mcp.example.com/mcp" } },
    });
  });

  it("builds a pool endpoint and a distinct server name for it", () => {
    const url = poolEndpointUrl("https://mcp.example.com/mcp", "support");
    expect(url).toBe("https://mcp.example.com/mcp/support");
    expect(clientServerName("Acme Tools!", "support")).toBe("acme-tools-support");
    expect(clientSetupCommands(clientServerName("acme", "support"), url)[0]!.text).toBe(
      "claude mcp add --transport http acme-support https://mcp.example.com/mcp/support",
    );
  });

  it("reduces any configured server name to a bare word", () => {
    expect(clientServerName(undefined)).toBe("connecta");
    expect(clientServerName("  ")).toBe("connecta");
    expect(clientServerName("$(rm -rf ~)")).toBe("rm-rf");
    expect(clientServerName("My MCP; echo hi")).toBe("my-mcp-echo-hi");
  });

  it("quotes a URL a shell would otherwise split, and carries no credential", () => {
    const [claude] = clientSetupCommands("acme", "http://localhost:8787/mcp?x=1&y=it's");
    expect(claude!.text).toBe(
      `claude mcp add --transport http acme 'http://localhost:8787/mcp?x=1&y=it'"'"'s'`,
    );
    for (const command of clientSetupCommands("acme", "https://mcp.example.com/mcp")) {
      expect(command.text).not.toMatch(/authorization|bearer|token|header/i);
    }
  });
});
