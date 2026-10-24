// Node-only: the shared safety harness reads the maintainer detector in scripts/.
import { beforeEach, afterEach, describe } from "vitest";
import { ccb } from "./index.js";
import { CCB_INDEX } from "./api.js";
import { CCB_VALUE_SAFETY } from "./safety.js";
import source from "./evidence/openapi.json";
import candidates from "./evidence/value-safety.json";
import { makeRegistry } from "../../../test/helpers.js";
import { installOwnedTransport } from "../../../test/fixtures/owned-transport.js";
import { describeValueSafety } from "../../../test/fixtures/value-safety.js";
import type { Connector, ConnectorContext } from "../../types.js";

const token = "fdc04953-b2ad-49eb-9f62-85f32a1d8d93";
let connector: ReturnType<typeof ccb>;
let context: ConnectorContext;
async function authorize(connector: Connector, context: ConnectorContext) {
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      Response.json({
        access_token: token,
        refresh_token: "15a524c8-6d75-4d89-9113-904ad56d748b",
        token_type: "bearer",
        expires_in: 7200,
      });
    const started = await connector.startAuth!({ ...context, allowAuthorization: true });
    const state = new URL(started.authorizationUrl!).searchParams.get("state")!;
    if (!(await connector.verifyState!(state, context))) throw new Error("CCB safety fixture state was refused.");
    await connector.finishAuth!("fixture-code", context, new URLSearchParams({ code: "fixture-code", state }));
    context.credential = { get: async () => token, getAll: async () => ({ value: token }) };
  } finally {
    globalThis.fetch = previous;
  }
}
describe("CCB authenticated safety", () => {
  const original = globalThis.fetch;
  beforeEach(async () => {
    installOwnedTransport();
    connector = ccb("crm", {
      purpose: "Safety fixture",
      environment: "production",
      mode: "system",
      access: "read-write",
      clientId: "2871de4b-a854-4180-93ab-c6df14d15752",
      clientSecret: "08bc709e-0f61-489d-b5a2-52a97b1532d4",
    });
    const registry = makeRegistry([connector]);
    context = registry.contextFor("crm", "https://connecta.example");
    await authorize(connector, context);
    globalThis.fetch = original;
  });
  afterEach(() => {
    globalThis.fetch = original;
  });
  describeValueSafety("CCB", {
    table: CCB_VALUE_SAFETY,
    index: CCB_INDEX,
    source,
    candidates,
    counts: { refuse: 2, redact: 36, safe: 8 },
    streamFormat: "json",
    prepare: authorize,
    connector: () => connector,
    ctx: () => context,
    fill: (template) => template.replace(/\{[^}]+\}/g, "1"),
    echo: {
      tool: "ccb_api_read",
      args: { path: "/files/1" },
      respond: (marker) => Response.json({ message: marker }, { status: 400 }),
    },
  });
});
