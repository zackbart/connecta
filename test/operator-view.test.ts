import { describe, expect, it } from "vitest";
import {
  credentialManagementCapability,
  filterUiConnectors,
  operatorPageForPath,
  operatorPageTitle,
  type UiConnector,
} from "../src/ui.js";
import {
  activitySummary,
  credentialUnavailableCopy,
  driftCounts,
  driftSummary,
  failure,
  filterActivity,
  info,
  initialState,
  resetIdentity,
  safeHttpHref,
  withPage,
  type OperatorState,
  type UiActivityEvent,
} from "../src/operator-ui/view.js";
import { required } from "./helpers.js";

/** A connector whose listTools always throws — exercises broken-connector isolation. */
describe("status UI filtering", () => {
  const connectors: UiConnector[] = [
    {
      id: "notion",
      title: "Notion",
      description: "Company knowledgebase",
      status: "auth_required",
      toolCount: 0,
      tools: [],
    },
    {
      id: "billing",
      title: "Billing",
      description: "Client billing",
      status: "ok",
      toolCount: 1,
      tools: [
        {
          name: "list_invoices",
          address: "billing.list_invoices",
          description: "List invoices",
        },
      ],
    },
  ];

  it("keeps an identity-matching zero-tool connector and hides nonmatches", () => {
    expect(filterUiConnectors(connectors, "notion")).toEqual([
      { connector: connectors[0], tools: [] },
    ]);
    expect(filterUiConnectors(connectors, "missing")).toEqual([]);
  });

  it("matches tool metadata without losing connector context", () => {
    expect(filterUiConnectors(connectors, "invoices")).toEqual([
      {
        connector: connectors[1],
        tools: [required(connectors[1]).tools[0]],
      },
    ]);
  });
});

describe("operator page routing and capabilities", () => {
  it("maps only canonical shell paths and builds page-specific titles", () => {
    expect(operatorPageForPath("/")).toBe("overview");
    expect(operatorPageForPath("/credentials")).toBeUndefined();
    expect(operatorPageForPath("/tokens")).toBe("tokens");
    expect(operatorPageForPath("/activity")).toBe("activity");
    expect(operatorPageForPath("/ui")).toBeUndefined();
    expect(operatorPageForPath("/ui/data")).toBeUndefined();
    expect(operatorPageTitle("connections", "Acme Connecta")).toBe(
      "Connectors — Acme Connecta",
    );
  });

  it("orders credential capability states without revealing topology to bearer", () => {
    expect(
      credentialManagementCapability({
        eligibleOperator: false,
        hasCredentialSlots: true,
        hasCredentialVault: true,
      }),
    ).toBe("requires_operator");
    expect(
      credentialManagementCapability({
        eligibleOperator: true,
        hasCredentialSlots: false,
        hasCredentialVault: false,
      }),
    ).toBe("no_slots");
    expect(
      credentialManagementCapability({
        eligibleOperator: true,
        hasCredentialSlots: true,
        hasCredentialVault: false,
      }),
    ).toBe("vault_not_configured");
    expect(
      credentialManagementCapability({
        eligibleOperator: true,
        hasCredentialSlots: true,
        hasCredentialVault: true,
      }),
    ).toBe("available");
  });
});

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

  it("re-idles deferred collections so a new identity refetches its own", () => {
    const after = resetIdentity(loaded());
    expect(after.activityPhase).toBe("idle");
  });

  it("drops the one-time secret and the open credential form when a page changes", () => {
    const after = withPage(loaded(), "connections");
    expect(after.page).toBe("connections");
    expect(after.credentialEditing).toBeNull();
    expect(after.credentialNotice).toBeNull();
    // Loaded collections are this identity's own, so navigation keeps them.
  });

  it("filters loaded activity across labels, ids, and namespaces", () => {
    const events = [
      event("calc.add", {
        kind: "clerk",
        id: "user_1",
        namespace: "https://tenant-a.example",
        label: "Ada Lovelace",
      }),
      event("notes.list", {
        kind: "clerk",
        id: "user_2",
        namespace: "https://tenant-b.example",
        label: "Ada Lovelace",
      }),
      event("calc.add", { kind: "clerk", id: "user_fallback" }),
    ];
    expect(filterActivity(events, "ada lovelace")).toHaveLength(2);
    expect(filterActivity(events, "user_1")).toHaveLength(1);
    expect(filterActivity(events, "tenant-b.example")).toEqual([events[1]]);
    expect(filterActivity(events, "")).toEqual(events);
  });

  it("summarizes activity as counts and never as payloads", () => {
    expect(activitySummary([])).toBe("");
    expect(
      activitySummary([
        event("calc.add"),
        event("calc.add"),
        event("notes.list"),
      ]),
    ).toBe("3 loaded calls · 2 tools");
  });

  it("lets only http(s) values become an href", () => {
    expect(safeHttpHref("https://provider.test/oauth?x=1")).toBe(
      "https://provider.test/oauth?x=1",
    );
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
    expect(driftCounts(smuggled).every((c) => typeof c.count === "number")).toBe(
      true,
    );
    expect(rendered).not.toContain("billing.delete_customer");
    expect(rendered).not.toContain("inputSchema");
    expect(driftSummary(smuggled)).not.toContain("billing");
  });

  it("names each unavailable capability without revealing topology", () => {
    expect(credentialUnavailableCopy("no_slots")).toContain(
      "No connectors declare operator-managed credential slots",
    );
    expect(credentialUnavailableCopy("vault_not_configured")).toContain(
      "Configure a vault",
    );
    expect(credentialUnavailableCopy("requires_operator")).toContain(
      "interactive user",
    );


  });
});
