import { describe, expect, it } from "vitest";
import {
  driftCounts,
  driftSummary,
  failure,
  info,
  initialState,
  resetIdentity,
  safeHttpHref,
  type OperatorState,
  type UiActivityEvent,
} from "../src/operator-ui/view.js";

describe("operator app state", () => {
  function event(address: string, actor?: UiActivityEvent["actor"]) {
    return {
      occurredAt: "2026-07-23T12:00:00.000Z",
      ...(actor ? { actor } : {}),
      connectorId: address.split(".")[0] ?? address,
      toolName: address.split(".")[1] ?? address,
      address,
      source: "call_tool",
      outcome: "success",
      durationMs: 2,
      attempts: 1,
    } satisfies UiActivityEvent;
  }

  /** Every identity-scoped field carrying something an operator could read. */
  function loaded(): OperatorState {
    return {
      ...initialState("activity"),
      session: "ready",
      pendingFocus: "tokenNotice",
      data: {
        serverInfo: { name: "identity-a", version: "host" },
        connectaVersion: "package",
        connectors: [],
        activityEnabled: true,
        credentialManagement: "available",
        oauthManagement: true,
      },
      connectorFilter: "billing",
      oauthNotice: info("OAuth disconnected."),
      oauthNoticeFor: "crm",
      oauthBusy: "crm",
      oauthBlocked: "crm",
      confirming: { connectorId: "crm", action: "oauth_disconnect" },
      connectorFailures: { crm: "network" },
      loadFailure: "server",
      focusIfLost: "oauthNotice-crm",
      credentialNotice: info("identity-a secret-shaped notice"),
      credentialNoticeFor: "vaulted",
      credentialEditing: "vaulted",
      credentialBusy: "vaulted",
      activityPhase: "ready",
      activityNotice: info("loaded"),
      activityEvents: [event("calc.add")],
      activityCursor: "cursor-1",
      activitySearch: "ada",
    };
  }

  it("erases every identity-scoped field and fences work already in flight", () => {
    const before = loaded();
    const after = resetIdentity(before, failure("Signed out."));

    // The generation is the fence: a response that started under the previous
    // identity compares its captured value against this one and is dropped.
    expect(after.generation).toBe(before.generation + 1);
    expect(after.session).toBe("gated");
    expect(after.gate).toEqual({ message: "Signed out.", tone: "error" });
    // Field by field rather than by spot check: a value left behind here is one
    // operator's data on another operator's screen.
    expect(after).toMatchObject({
      data: null,
      connectorFilter: "",
      oauthNotice: null,
      oauthNoticeFor: null,
      oauthBusy: null,
      oauthBlocked: null,
      confirming: null,
      connectorFailures: {},
      loadFailure: null,
      focusIfLost: null,
      credentialNotice: null,
      credentialNoticeFor: null,
      credentialEditing: null,
      credentialBusy: null,
      pendingFocus: null,
      activityPhase: "idle",
      activityNotice: null,
      activityEvents: [],
      activityCursor: null,
      activitySearch: "",
    });
    // The page survives an identity change; only what the page *showed* does not.
    expect(after.page).toBe("activity");
    expect(JSON.stringify(after)).not.toContain("cta_one_time_secret");
    expect(JSON.stringify(after)).not.toContain("identity-a");
  });

  it("lets only http(s) values become an href", () => {
    expect(safeHttpHref("https://provider.test/oauth?x=1")).toBe("https://provider.test/oauth?x=1");
    expect(safeHttpHref("http://provider.test")).toBe("http://provider.test");
    for (const hostile of [
      "javascript:alert(1)",
      "data:text/plain,alert(1)",
      "//provider.test",
      "/relative",
      undefined,
    ]) {
      expect(safeHttpHref(hostile)).toBeNull();
    }
  });

  it("renders drift as counts and never as names, schemas, or payloads", () => {
    // A report that arrived carrying more than counts — the panel reads the
    // four categories it knows and nothing else, so extra fields cannot reach
    // an operator's screen even if something upstream stopped bounding them.
    const smuggled = {
      observedAt: "2026-08-12T12:00:00.000Z",
      unclassifiedTools: 4,
      unservedTools: 1,
      annotationConflicts: 0,
      schemaChanges: 2,
      toolNames: ["billing.delete_customer"],
      inputSchema: { type: "object" },
    } as unknown as Parameters<typeof driftCounts>[0];
    const rendered = JSON.stringify(driftCounts(smuggled));
    expect(driftCounts(smuggled).every((c) => typeof c.count === "number")).toBe(true);
    expect(rendered).not.toContain("billing.delete_customer");
    expect(rendered).not.toContain("inputSchema");
    expect(driftSummary(smuggled)).not.toContain("billing");
  });
});
