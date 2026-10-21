import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolDef } from "../../types.js";
import { guideOf, itClassifiesLikeARelease, mockRemoteMcp } from "../../../test/fixtures/hosted-provider.js";

const mocks = vi.hoisted(() => ({
  listTools: vi.fn<() => Promise<ToolDef[]>>(),
  remoteMcp: vi.fn(),
}));

vi.mock("../../connectors/remote-mcp.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../connectors/remote-mcp.js")>()),
  remoteMcp: mocks.remoteMcp,
}));

import { BASECAMP_MCP_ENDPOINT, BASECAMP_VETTED_CATALOG, basecamp } from "./index.js";

const CLIENT_METADATA_URL = "https://connecta.example/oauth/basecamp-client";

function connection(overrides: Partial<Parameters<typeof basecamp>[1]> = {}) {
  return basecamp("basecamp", {
    purpose: "The studio's client projects",
    clientMetadataUrl: CLIENT_METADATA_URL,
    ...overrides,
  });
}

describe("basecamp()", () => {
  beforeEach(() => {
    mockRemoteMcp(mocks);
  });

  it("owns the endpoint and OAuth through a client metadata document (P9)", () => {
    const connector = connection({
      instructions: "Post client-facing updates as messages, never as chat.",
    });

    expect(mocks.remoteMcp).toHaveBeenCalledWith(
      "basecamp",
      expect.objectContaining({
        url: BASECAMP_MCP_ENDPOINT,
        title: "Basecamp",
        description:
          "Basecamp projects, to-dos, messages, cards, schedules, and files (one account per authorization) — The studio's client projects",
        // The scope is a fallback: the MCP client asks for what Basecamp's
        // challenge names first, so this only matters if Basecamp stops
        // advertising scopes.
        auth: {
          type: "oauth",
          clientMetadataUrl: CLIENT_METADATA_URL,
          scope: "full mcp offline_access",
        },
        requireHttps: true,
      }),
    );
    expect(BASECAMP_MCP_ENDPOINT).toBe("https://mcp.basecamp.com/mcp");
    expect(guideOf(connector)).toContain("## Account instructions");
    expect(guideOf(connector)).toContain("Post client-facing updates as messages, never as chat.");
  });

  it("INV-11: defaults to the deployment's self-hosted client metadata document", () => {
    basecamp("basecamp", { purpose: "Projects" });
    expect(mocks.remoteMcp).toHaveBeenCalledWith(
      "basecamp",
      expect.objectContaining({
        auth: { type: "oauth", scope: "full mcp offline_access" },
      }),
    );
  });

  it("INV-11: offers no headless credential and no access mode", () => {
    // Not part of the options type: OAuth is the only shape this provider
    // builds, so a stray auth option is refused rather than swapping the
    // credential out or being silently ignored.
    expect(() =>
      connection({
        ...({ auth: { type: "headers", headers: { Authorization: "Bearer x" } } } as object),
      }),
    ).toThrow('Unknown option: basecamp("basecamp").auth.');
    expect(mocks.remoteMcp).not.toHaveBeenCalled();
    const connector = connection();
    expect(mocks.remoteMcp.mock.calls[0]?.[1]).toMatchObject({
      auth: { type: "oauth" },
    });
    expect(connector.credential).toBeUndefined();
    expect(connector.testCredential).toBeUndefined();
    expect(connector.testCredentials).toBeUndefined();
  });

  it("declares no admission budget and passes an operator's through (P12)", () => {
    connection();
    const defaults = mocks.remoteMcp.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(defaults).not.toHaveProperty("callAdmission");
    expect(defaults).not.toHaveProperty("maxResultBytes");

    const callAdmission = {
      rules: [
        {
          budget: {
            kind: "rolling-window" as const,
            maxCalls: 50,
            windowMs: 10_000,
          },
        },
      ],
    };
    connection({ callAdmission, maxResultBytes: 25_000, authScope: "personal" });
    expect(mocks.remoteMcp).toHaveBeenLastCalledWith(
      "basecamp",
      expect.objectContaining({
        callAdmission,
        maxResultBytes: 25_000,
        authScope: "personal",
      }),
    );
  });

  it("leads the guide with the account a grant reached (P3)", () => {
    const shared = guideOf(connection());
    expect(shared.split("\n")[2]).toBe(
      "One account per authorization: The studio's client projects. Basecamp's hosted server acts in the single account the grant was made for, and no tool takes an account id. One shared authorization, made on Basecamp's consent screen, decides that account for everyone who uses this connector. Another account is another connector, never an argument.",
    );
    const personal = guideOf(connection({ authScope: "personal" }));
    expect(personal).toContain("two people can reach different accounts through it");
    expect(personal).not.toContain("One shared authorization");
  });

  it("keeps the argued verdicts where the release put them", () => {
    const verdictFor = (name: string) => BASECAMP_VETTED_CATALOG.tools.get(name)?.verdict;
    // Agrees with the server after review: no record written, and the feed
    // the ticket opens is already readable here.
    expect(verdictFor("create_stream_ticket")).toBe("read-only");
    // Destructive where the server says additive: filing projects moves them.
    expect(verdictFor("create_folder")).toBe("destructive");
    // Additive where the server says destructive: membership added, nothing
    // removed; their opposite halves stay destructive.
    expect(verdictFor("prioritize_assignment")).toBe("additive");
    expect(verdictFor("watch_column")).toBe("additive");
    expect(verdictFor("subscribe_to_card_column")).toBe("additive");
    expect(verdictFor("deprioritize_assignment")).toBe("destructive");
    expect(verdictFor("unwatch_column")).toBe("destructive");
    expect(verdictFor("unsubscribe_from_card_column")).toBe("destructive");
    // Trash and permanent deletion share a verdict; the guide tells them apart.
    expect(verdictFor("trash_project")).toBe("destructive");
    expect(verdictFor("delete_boost")).toBe("destructive");
    expect(verdictFor("remove_account_logo")).toBe("destructive");
    expect(verdictFor("mark_as_read")).toBe("destructive");
    expect(verdictFor("update_project_access")).toBe("destructive");
  });

  itClassifiesLikeARelease(() => connection(), mocks, {
    read: ["list_projects", "get_me", "get_by_url"],
    write: "create_todo",
    destructive: "trash_project",
    unknown: ["summon_new_thing", "peek_at_new_thing", "wreck_new_thing"],
  });
});
