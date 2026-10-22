import { describe, expect, it, vi } from "vitest";
import { activityHistory } from "../src/activity.js";
import { api } from "../src/connectors/api.js";
import { CredentialVault, encryptedCredentialVault } from "../src/credentials.js";
import type { UiConnector } from "../src/operator-ui/model.js";
import { clientSetupCommands } from "../src/operator-ui/setup-commands.js";
import { problemCopy } from "../src/operator-ui/view.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { Connector, ConnectorStatus } from "../src/types.js";
import { fakeClerkAuth } from "./fixtures/http.js";
import { connectRequest } from "./fixtures/oauth.js";
import { CLERK_OPTIONS, CREDENTIAL_KEY, credentialRequest } from "./fixtures/ui.js";
import { createTestConnecta, silentLogger } from "./helpers.js";
import { machineAuth } from "./helpers/machine-auth.js";

const BASE = "https://connecta.test";
const TOKEN = "model-token";

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

  it("INV-6: classifies a status message into the payload and keeps its text out of the log", async () => {
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
      auth: machineAuth(TOKEN),
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

    // The host records each state, and for a failure connecta described its
    // record; never a message, whatever a status seam or an error said (INV-6).
    const status = (spy: ReturnType<typeof vi.fn>) =>
      spy.mock.calls.filter((call) => call[0] === "[connecta] operator status").map((call) => call[1]);
    expect(status(warn)).toEqual([
      { connector: "down", state: "error" },
      { connector: "thrown", state: "error", errorClass: "Error" },
    ]);
    expect(status(info)).toEqual([{ connector: "locked", state: "auth_required" }]);
    const logged = JSON.stringify([...warn.mock.calls, ...info.mock.calls]);
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain("upstream connect error");
  });
});

describe("operator action notices", () => {
  /** A token endpoint's refusal that quotes the secret it was sent. */
  const SECRET = "sk_live_notice_leak";
  const LEAK = `invalid_grant: token ${SECRET} was revoked`;
  const CONSENT = "https://auth.example/consent?state=test-state";

  function oauthConnector(id: string, hooks: Partial<Pick<Connector, "startAuth" | "disconnectAuth">>): Connector {
    return {
      id,
      kind: "mcp",
      async listTools() {
        return [];
      },
      async callTool() {
        return null;
      },
      async disconnectAuth() {},
      async startAuth() {
        return { state: "auth_required", authorizationUrl: CONSENT };
      },
      async finishAuth() {},
      async verifyState() {
        return true;
      },
      ...hooks,
    };
  }

  function testedApi(
    id: string,
    testCredential: (value: string) => Promise<{ ok: boolean; message?: string }>,
  ): Connector {
    return api(id, {
      description: "Credential test",
      credential: { label: "API token" },
      testCredential,
      tools: [],
    });
  }

  it("INV-6: answers downstream failures in fixed words and logs only their records", async () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const recorded: unknown[] = [];
    const storage = memoryStorage();
    const vault = new CredentialVault(storage, CREDENTIAL_KEY);
    for (const id of ["rejected", "thrown", "accepted"]) {
      await vault.set(id, "stored-secret-1234", "user_123");
    }
    const connecta = createTestConnecta({
      connectors: [
        oauthConnector("oauththrows", {
          startAuth: async () => {
            throw new Error(LEAK);
          },
          disconnectAuth: async () => {
            throw new Error(LEAK);
          },
        }),
        oauthConnector("oautherror", {
          startAuth: async () => ({ state: "error", message: LEAK }),
        }),
        oauthConnector("oauthnourl", {
          startAuth: async () => ({ state: "auth_required", message: LEAK }),
        }),
        // A plugin's state is checked against the closed set before it is
        // recorded, never copied.
        oauthConnector("oauthbadstate", {
          startAuth: async () => ({ state: SECRET }) as unknown as ConnectorStatus,
        }),
        // A successful start's message is informational, and is dropped.
        oauthConnector("oauthok", {
          startAuth: async () => ({
            state: "auth_required",
            authorizationUrl: CONSENT,
            message: `consent pending for ${SECRET}`,
          }),
        }),
        testedApi("rejected", async () => ({ ok: false, message: LEAK })),
        testedApi("thrown", async () => {
          throw new Error(LEAK);
        }),
        testedApi("accepted", async () => ({
          ok: true,
          message: `Authenticated with ${SECRET}`,
        })),
      ],
      auth: fakeClerkAuth(CLERK_OPTIONS),
      storage,
      publicUrl: BASE,
      vault: encryptedCredentialVault(storage, CREDENTIAL_KEY),
      activity: activityHistory({
        store: {
          record(event) {
            recorded.push(event);
          },
        },
      }),
      logger,
    });

    const answers: Array<[string, "POST" | "DELETE", number, unknown]> = [
      ["/ui/oauth/oauththrows", "POST", 400, { error: "OAuth authorization could not start" }],
      ["/ui/oauth/oauththrows", "DELETE", 400, { error: "OAuth disconnect failed" }],
      ["/ui/oauth/oautherror", "POST", 502, { error: "OAuth authorization could not start" }],
      [
        "/ui/oauth/oauthnourl",
        "POST",
        502,
        { error: "OAuth authorization requires consent but no safe URL is available" },
      ],
      ["/ui/oauth/oauthbadstate", "POST", 502, { error: "OAuth authorization could not start" }],
      ["/ui/oauth/oauthok", "POST", 302, null],
      ["/ui/credentials/rejected/test", "POST", 200, { ok: false }],
      ["/ui/credentials/thrown/test", "POST", 200, { ok: false }],
      ["/ui/credentials/accepted/test", "POST", 200, { ok: true }],
    ];
    for (const [path, method, status, body] of answers) {
      const res = await (path.startsWith("/ui/oauth/") && method === "POST" ? connectRequest : credentialRequest)(
        connecta,
        path,
        { method },
      );
      const text = await res.text();
      expect(res.status, `${method} ${path}`).toBe(status);
      expect(text, `${method} ${path}`).not.toContain(SECRET);
      if (body === null) expect(res.headers.get("Location")).toBe(CONSENT);
      else expect(JSON.parse(text), `${method} ${path}`).toEqual(body);
    }

    // The host records each failure as typed facts, one line per failure,
    // and none of the downstream's words.
    const records = logger.warn.mock.calls.map((call) => [String(call[0]), call[1]]);
    expect(records).toEqual(
      expect.arrayContaining([
        ["[connecta] OAuth start failed", { connector: "oauththrows", errorClass: "Error" }],
        ["[connecta] OAuth disconnect failed", { connector: "oauththrows", errorClass: "Error" }],
        ["[connecta] OAuth start failed", { connector: "oautherror", mode: "restart", state: "error" }],
        ["[connecta] OAuth start failed", { connector: "oauthnourl", mode: "restart", state: "auth_required" }],
        ["[connecta] OAuth start failed", { connector: "oauthbadstate", mode: "restart" }],
        ["[connecta] credential test failed", { connector: "rejected" }],
        ["[connecta] credential test threw", { connector: "thrown", errorClass: "Error" }],
      ]),
    );
    const lines = (spy: ReturnType<typeof vi.fn>) => spy.mock.calls.map((call) => JSON.stringify(call));
    const everything = Object.values(logger).flatMap(lines);
    expect(everything.some((line) => line.includes("consent pending"))).toBe(false);
    expect(everything.join("\n")).not.toContain(SECRET);
    // And not in activity, which has nowhere to put them.
    expect(JSON.stringify(recorded)).not.toContain(SECRET);
  });
});

describe("client setup commands", () => {
  it("quotes a URL a shell would otherwise split, and carries no credential", () => {
    const [claude] = clientSetupCommands("acme", "http://localhost:8787/mcp?x=1&y=it's");
    expect(claude!.text).toBe(`claude mcp add --transport http acme 'http://localhost:8787/mcp?x=1&y=it'"'"'s'`);
    for (const command of clientSetupCommands("acme", "https://mcp.example.com/mcp")) {
      expect(command.text).not.toMatch(/authorization|bearer|token|header/i);
    }
  });
});
