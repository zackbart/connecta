import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CredentialVault } from "../src/credentials.js";
import { createConnecta } from "../src/index.js";
import { notion } from "../src/providers/notion.js";
import { memoryStorage } from "../src/storage/memory.js";
import { activityFor, activitySink, invokeTestCall, silentLogger } from "./helpers.js";
import type { KVStorage } from "../src/types.js";

// Unmocked on purpose. test/notion-provider.test.ts stubs the network to
// inspect requests and projections; it never boots a deployment, so it can
// never catch a connection the real Registry refuses to construct. This one
// hands the real connector to the real Registry — which is where the
// call-admission policy is validated, and where a budget declared with queue
// settings but no maxConcurrency would throw. Construction touches no network:
// fetch throws for the whole file.

const BASE_URL = "https://connecta.example";
const executor = { execute: async () => ({ result: null }) };

// 32 zero-ish bytes, base64 — btoa keeps this suite runnable on workerd.
const CREDENTIAL_KEY = btoa(
  String.fromCharCode(...new Uint8Array(32).fill(7)),
);

function twoWorkspaces(storage: KVStorage) {
  return createConnecta({
    executor,
    storage,
    logger: silentLogger,
    publicUrl: BASE_URL,
    credentials: { encryptionKey: CREDENTIAL_KEY },
    connectors: [
      notion("notion_eng", {
        purpose: "Engineering runbooks and specs",
      }),
      notion("notion_ops", {
        purpose: "Operations handbook",
        title: "Ops wiki",
        defaultPageSize: 50,
      }),
    ],
  });
}

describe("notion() inside a real deployment", () => {
  const realFetch = globalThis.fetch;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn(() => {
      throw new Error("network touched");
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("boots two workspaces without reaching the network", () => {
    const connecta = twoWorkspaces(memoryStorage());
    expect(
      connecta.registry.listConnectors().map((connector) => connector.id),
    ).toEqual(["notion_eng", "notion_ops"]);
    // The admission policy pairs a rolling budget with a concurrency cap and
    // queue settings; the controller validates that here or not at all.
    expect(Object.keys(connecta.registry.callAdmissionSnapshot()).sort()).toEqual(
      ["notion_eng", "notion_ops"],
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("gives each workspace its own address namespace", () => {
    const connecta = twoWorkspaces(memoryStorage());
    expect(
      connecta.registry.resolveAddress("notion_eng.query_data_source")
        ?.connector,
    ).toBe(connecta.registry.getConnector("notion_eng"));
    expect(
      connecta.registry.resolveAddress("notion_ops.query_data_source")
        ?.connector,
    ).toBe(connecta.registry.getConnector("notion_ops"));
    expect(connecta.registry.getConnector("notion_eng")).not.toBe(
      connecta.registry.getConnector("notion_ops"),
    );
    // Same maintained surface, two independently addressed instances.
    expect(
      connecta.registry.resolveAddress("notion_eng.trash_page")?.toolName,
    ).toBe("trash_page");
    expect(connecta.registry.resolveAddress("nope.trash_page")).toBeFalsy();
  });

  it("serves each workspace the same catalog from its own connector", async () => {
    const connecta = twoWorkspaces(memoryStorage());
    const eng = await connecta.registry.getTools("notion_eng", BASE_URL);
    const ops = await connecta.registry.getTools("notion_ops", BASE_URL);
    expect(eng.map((tool) => tool.name)).toEqual(ops.map((tool) => tool.name));
    expect(eng).toHaveLength(15);
    // A hand-written surface needs no catalog walk, so no deployment ever
    // pays a network round trip to discover it.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps credentials and storage in separate namespaces", async () => {
    const storage = memoryStorage();
    const connecta = twoWorkspaces(storage);
    const vault = new CredentialVault(storage, CREDENTIAL_KEY);
    await vault.set("notion_eng", "secret_eng_token", "operator@example.com");

    const eng = connecta.registry.contextFor("notion_eng", BASE_URL);
    const ops = connecta.registry.contextFor("notion_ops", BASE_URL);
    expect(await eng.credential?.get()).toBe("secret_eng_token");
    // One workspace's integration token is unreachable from the other's
    // context even though both connectors are the same provider.
    expect(await ops.credential?.get()).toBeNull();

    await eng.storage.set("cursor", "eng-cursor");
    expect(await ops.storage.get("cursor")).toBeNull();
    expect(await storage.get("conn:notion_eng:cursor")).toBe("eng-cursor");
    expect(await storage.get("conn:notion_ops:cursor")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("meters and observes each workspace separately", async () => {
    const connecta = twoWorkspaces(memoryStorage());
    const permit = await connecta.registry.admitCall("notion_eng", {
      toolName: "search",
      args: {},
    });
    permit.release();

    const budgets = connecta.registry.callAdmissionSnapshot();
    expect(budgets["notion_eng"]?.totals.admitted).toBe(1);
    expect(budgets["notion_ops"]?.totals.admitted).toBe(0);

    const activity = activitySink();
    await invokeTestCall(connecta.registry, activity, "notion_eng.search");
    expect(activityFor(activity.events, "notion_eng")?.outcome).toBe("error");
    expect(activityFor(activity.events, "notion_ops")).toBeUndefined();
  });

  it("carries a distinct guide per workspace", () => {
    const connecta = twoWorkspaces(memoryStorage());
    const eng = connecta.registry.getConnector("notion_eng")?.usageGuide as {
      content: string;
    };
    const ops = connecta.registry.getConnector("notion_ops")?.usageGuide as {
      content: string;
    };
    expect(eng.content).toContain("Engineering runbooks and specs");
    expect(ops.content).toContain("Operations handbook");
    expect(eng.content).not.toContain("Operations handbook");
  });
});
