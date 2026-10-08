import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolDef } from "../../types.js";
import {
  guideOf,
  itClassifiesLikeARelease,
  mockRemoteMcp,
  servedTools,
} from "../../../test/fixtures/hosted-provider.js";

const mocks = vi.hoisted(() => ({
  listTools: vi.fn<() => Promise<ToolDef[]>>(),
  remoteMcp: vi.fn(),
}));

vi.mock("../../connectors/remote-mcp.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../connectors/remote-mcp.js")>()),
  remoteMcp: mocks.remoteMcp,
}));

import {
  BASECAMP_MCP_ENDPOINT,
  BASECAMP_VETTED_CATALOG,
  basecamp,
} from "./index.js";
import { connectorGuideSummary } from "../../skills.js";

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
    expect(guideOf(connector)).toContain(
      "Post client-facing updates as messages, never as chat.",
    );
  });

  it("omits the account section when no instructions are given", () => {
    expect(guideOf(connection())).not.toContain("## Account instructions");
  });

  it("requires a client metadata document URL at construction", () => {
    // Basecamp restricts dynamic registration for HTTPS redirect URIs, so a
    // deployment without one would boot and then fail at its first consent,
    // where nobody in the conversation can repair it.
    for (const clientMetadataUrl of [undefined, "", "   "]) {
      expect(() =>
        basecamp("basecamp", {
          purpose: "Projects",
          clientMetadataUrl,
        } as never),
      ).toThrow(
        'basecamp("basecamp") requires clientMetadataUrl: Basecamp restricts dynamic client registration for HTTPS redirect URIs',
      );
    }
    expect(() =>
      basecamp("studio", { purpose: "Projects" } as never),
    ).toThrow("redirect_uris include <publicUrl>/oauth/callback/studio.");
    expect(mocks.remoteMcp).not.toHaveBeenCalled();
  });

  it("rejects an empty purpose at construction (P2)", () => {
    expect(() => connection({ purpose: "  " })).toThrow(
      "a non-empty purpose",
    );
  });

  it("INV-11: offers no headless credential and no access mode", () => {
    // Not part of the options type: OAuth is the only shape this provider
    // builds, so a stray auth option is refused rather than swapping the
    // credential out or being silently ignored.
    expect(() => connection({
      ...({ auth: { type: "headers", headers: { Authorization: "Bearer x" } } } as object),
    })).toThrow('Unknown option: basecamp("basecamp").auth.');
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
    const defaults = mocks.remoteMcp.mock.calls[0]?.[1] as Record<
      string,
      unknown
    >;
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
    expect(personal).toContain(
      "two people can reach different accounts through it",
    );
    expect(personal).not.toContain("One shared authorization");
  });

  it("names each account in a bounded, purpose-bearing summary", () => {
    expect(connectorGuideSummary(connection())).toBe(
      "One account per grant; get_me names it: The studio's client projects",
    );
    const clipped = connectorGuideSummary(
      connection({
        purpose:
          "Every client engagement the studio runs, including retainers, launches, audits, and the internal operations account",
      }),
    );
    expect(clipped?.length).toBeLessThanOrEqual(120);
    expect(clipped?.endsWith("…")).toBe(true);
  });

  it("carries id resolution, reduction, and catalog-varies advice (P6–P8)", () => {
    const guide = guideOf(connection());
    expect(guide).toContain("`get_me` returns the signed-in person");
    expect(guide).toContain("read that as wrong connector");
    expect(guide).toContain("`get_basecamp_guide` with `topic`");
    expect(guide).toContain("`deleting-and-trash`");
    expect(guide).toContain("never guess one");
    expect(guide).toContain("`get_by_url` reads any link");
    expect(guide).toContain("`list_projects` then `get_project`");
    expect(guide).toContain("`create_comment`'s `mentions`");
    expect(guide).toContain("rather than raising the limit");
    expect(guide).toContain("reduce inside `execute_code`");
    expect(guide).toContain("restorable for 25 days");
    expect(guide).toContain("are permanent");
    expect(guide).toContain("full replaces");
    expect(guide).toContain("Do not call `create_stream_ticket`");
    expect(guide).toContain("not a fixed set");
    expect(guide).toContain("`Retry-After`");
    expect(guide).toContain("call_destructive_tool");
    expect(guide).toContain("authorize_connector");
  });

  it("classifies the whole reviewed live catalog (P5)", () => {
    const verdicts = BASECAMP_VETTED_CATALOG.tools;
    const counts = { "read-only": 0, additive: 0, destructive: 0 };
    for (const { verdict } of verdicts.values()) counts[verdict] += 1;
    // The 2026-10-05 live tools/list: 227 tools, every one classified.
    expect(counts).toEqual({ "read-only": 105, additive: 34, destructive: 88 });
    expect(verdicts.size).toBe(227);
    // No digests: no release has a reviewed schema set to compare against.
    for (const record of verdicts.values()) {
      expect(record.schemaDigest).toBeUndefined();
    }
  });

  it("keeps the argued verdicts where the release put them", () => {
    const verdictFor = (name: string) =>
      BASECAMP_VETTED_CATALOG.tools.get(name)?.verdict;
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

  it("applies the argued verdicts to the server's explicit annotations", async () => {
    mocks.listTools.mockResolvedValue([
      {
        name: "create_stream_ticket",
        annotations: { readOnlyHint: true, destructiveHint: false },
      },
      {
        name: "create_folder",
        annotations: { readOnlyHint: false, destructiveHint: false },
      },
      {
        name: "watch_column",
        annotations: { readOnlyHint: false, destructiveHint: true },
      },
    ]);
    const tools = await servedTools(connection());
    expect(tools[0]?.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
    });
    // A vetted destructive verdict tightens.
    expect(tools[1]?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
    });
    // An additive verdict fills silence only, so the server's own
    // destructive annotation is what a caller still sees.
    expect(tools[2]?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
    });
  });

  itClassifiesLikeARelease(() => connection(), mocks, {
    read: ["list_projects", "get_me", "get_by_url"],
    write: "create_todo",
    destructive: "trash_project",
    unknown: ["summon_new_thing", "peek_at_new_thing", "wreck_new_thing"],
  });

  it("lets an operator title override the default", () => {
    connection({ title: "Client Basecamp" });
    expect(mocks.remoteMcp).toHaveBeenLastCalledWith(
      "basecamp",
      expect.objectContaining({ title: "Client Basecamp" }),
    );
  });
});
