import { Component } from "@effect/ui";
import { HtmlLocator } from "@effect/ui/html/testing";
import { Locator, Scene, Story } from "@effect/ui/testing";
import { Context, Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { OperatorUiContractV2 } from "../src/operator-ui/contract.js";
import { steadyHealth } from "../src/operator-ui/health.js";
import type { UiData } from "../src/operator-ui/model.js";
import { initialState, type OperatorState } from "../src/operator-ui/view.js";
import { projectView, type OperatorView } from "../src/operator-ui/app/shell/operator-view.js";
import type { CandidateHandle, OperatorControllerShape } from "../src/operator-ui/app/services/controller.js";

vi.mock("../src/operator-ui/app/config.js", () => ({
  auth: { kind: "bearer" },
  initialPage: "connections",
  mcpUrl: "https://deployment.example/mcp",
  schemePinned: false,
  titleSuffix: "Connecta",
  productName: "Connecta",
  productDescription: "One MCP endpoint.",
  brandMark: "connecta",
  TOKEN_KEY: "connecta:token",
}));

const { AccountMenu } = await import("../src/operator-ui/app/shell/account-menu.js");
const commands = await import("../src/operator-ui/app/shell/commands.js");
const { OperatorContent } = await import("../src/operator-ui/app/shell/content.js");
const { Gate, GateMessage } = await import("../src/operator-ui/app/shell/gate.js");
const bridge = await import("../src/operator-ui/app/bridge.js");
const { OperatorNav } = await import("../src/operator-ui/app/shell/nav.js");
const { OperatorRoute } = await import("../src/operator-ui/app/shell/routes.js");
const { OverviewPageNoDeps, overviewProjection } = await import("../src/operator-ui/app/pages/overview.js");
const { CopyButton, CopyText, WaitBeforeReset } = await import("../src/operator-ui/app/components/copy-button.js");
const { HostConnectionMap } = await import("../src/operator-ui/app/shell/island.js");
const { ConnectorHealth } = await import("../src/operator-ui/app/services/health.js");
const { OperatorStore } = await import("../src/operator-ui/app/services/store.js");
const serverFixture = "./fixtures/operator-visual.js";
const { createOperatorVisualFixture } = (await import(serverFixture)) as {
  createOperatorVisualFixture: () => Promise<{ contract: OperatorUiContractV2; data: UiData }>;
};
const fixture = await createOperatorVisualFixture();

const story = (body: Effect.Effect<void, never, import("effect").Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(body));

const view = (patch: Partial<OperatorState> = {}): OperatorView =>
  projectView(
    { ...initialState("connections"), ...patch },
    { navHint: { activity: false }, account: "alice@example.com", sessionPresumed: false, clerkSignedIn: false },
  );

const route = OperatorRoute.Connectors({ search: {} });

const maintainerState = (patch: Partial<OperatorState> = {}): OperatorState => ({
  ...initialState("overview"),
  session: "ready",
  role: "maintainer",
  contract: fixture.contract,
  data: fixture.data,
  contractPhase: "ready",
  admissionValid: true,
  ...patch,
});

const overviewOf = (state: OperatorState, project = overviewProjection()) => project(state, steadyHealth(state, null));

const contentStory = (initial: OperatorView = view()) =>
  Effect.gen(function* () {
    const s = yield* Story.make(OperatorContent, { route, view: initial, overview: null });
    s.expectExact(commands.BootOperator, commands.CanonicalizeLocation)
      .resolve(commands.BootOperator, Component.noop)
      .resolve(commands.CanonicalizeLocation, Component.noop);
    return s;
  });

describe("operator content shell", () => {
  it("boots the controller and reads every source the store used to listen to", () =>
    story(
      Effect.gen(function* () {
        const s = yield* contentStory();
        expect(s.subscriptions).toEqual(expect.arrayContaining(["operatorView", "pageWrites", "hash", "visibility"]));
      }),
    ));

  it("closes page overlays and moves focus to Retry once, when recovery starts", () =>
    story(
      Effect.gen(function* () {
        const contract = { role: "maintainer", agents: [] } as unknown as OperatorState["contract"];
        const data = { connectors: [] } as unknown as OperatorState["data"];
        const s = yield* contentStory(
          view({ session: "ready", role: "maintainer", contract, data, admissionValid: true }),
        );
        const recovering = view({ session: "ready", role: "maintainer", contract: null, data, admissionValid: false });
        s.send({ _tag: "ChangedOperatorView", view: recovering, overview: null })
          .expectExact(commands.CloseForRecovery, commands.FocusRecoveryRetry)
          .resolve(commands.CloseForRecovery, Component.noop)
          .resolve(commands.FocusRecoveryRetry, Component.noop);
        expect(s.model.recovering).toBe(true);
        s.send({ _tag: "ChangedOperatorView", view: recovering, overview: null }).expectNone();
      }),
    ));

  it("spends a focus request through the focus Command only while no page island owns focus", () =>
    story(
      Effect.gen(function* () {
        const s = yield* contentStory();
        s.send({ _tag: "ChangedOperatorView", view: view({ pendingFocus: "gateHeading" }), overview: null })
          .expectExact(commands.FocusPendingTarget)
          .resolve(commands.FocusPendingTarget, Component.noop);
        s.send({
          _tag: "ChangedOperatorView",
          view: view({ session: "ready", pendingFocus: "confirm-cancel-token-alice" }),
          overview: null,
        }).expectNone();
        s.send({ _tag: "ChangedOperatorView", view: view({ session: "gated", pendingFocus: "token" }), overview: null })
          .expectExact(commands.FocusPendingTarget)
          .resolve(commands.FocusPendingTarget, Component.noop);
      }),
    ));

  it("asks for a page's collection only while that page's read is idle", () =>
    story(
      Effect.gen(function* () {
        const s = yield* contentStory();
        const tokensPage = (tokenPhase: OperatorState["tokenPhase"]) =>
          view({
            session: "ready",
            role: "maintainer",
            page: "tokens",
            tokenPhase,
            admissionValid: true,
            contractPhase: "ready",
            contract: { role: "maintainer", agents: [] } as unknown as OperatorState["contract"],
            data: { accessTokenManagement: "available" } as OperatorState["data"],
          });
        s.send({ _tag: "ChangedOperatorView", view: tokensPage("idle"), overview: null })
          .expectExact(commands.LoadPageCollections)
          .resolve(commands.LoadPageCollections, Component.noop);
        s.send({ _tag: "ChangedOperatorView", view: tokensPage("loading"), overview: null }).expectNone();
      }),
    ));

  it("runs every page write as its own Command, with the tab the click opened", () =>
    story(
      Effect.gen(function* () {
        const s = yield* contentStory();
        const prepared = { refused: false, tab: null } as const;
        const candidate = "candidate-1" as CandidateHandle;
        s.send({
          _tag: "RequestedPageWrite",
          request: { _tag: "StartOAuth", connector: "crm", mode: "continue", prepared },
        }).expectExact(commands.StartOAuth);
        expect(s.pending[0]!.command.args).toEqual({ connector: "crm", mode: "continue", prepared });
        s.resolve(commands.StartOAuth, Component.noop);
        s.send({ _tag: "RequestedPageWrite", request: { _tag: "ConfirmTokenAction" } })
          .expectExact(commands.ConfirmTokenAction)
          .resolve(commands.ConfirmTokenAction, Component.noop);
        s.send({
          _tag: "RequestedPageWrite",
          request: { _tag: "SaveCredential", connector: "crm", candidate, verify: "test" },
        }).expectExact(commands.SaveCredential);
        expect(s.pending[0]!.command.args).toEqual({ connector: "crm", candidate, verify: "test" });
        s.resolve(commands.SaveCredential, Component.noop);
      }),
    ));

  it("reports each route change by its canonical path", () =>
    story(
      Effect.gen(function* () {
        const s = yield* contentStory();
        s.send({ _tag: "ChangedRoute", route: OperatorRoute.LegacyTools({ search: {} }) }).expectExact(
          commands.ReportRoute,
          commands.CanonicalizeLocation,
        );
        expect(s.pending.map((entry) => entry.command.args)).toContainEqual({ path: "/connectors" });
        s.resolve(commands.ReportRoute, Component.noop).resolve(commands.CanonicalizeLocation, Component.noop);
      }),
    ));
});

describe("overview page", () => {
  it("is the content root's own component, so the shell spends its focus requests", () =>
    story(
      Effect.gen(function* () {
        const state = maintainerState({ pendingFocus: "overviewHeading" });
        const shell = { navHint: { activity: false }, account: null, sessionPresumed: false, clerkSignedIn: false };
        const overview = projectView(state, shell);
        expect([overview.content, overview.islandOwnsFocus]).toEqual(["overview", false]);
        expect(projectView({ ...state, page: "endpoints" }, shell)).toMatchObject({
          content: "island",
          islandOwnsFocus: true,
        });
        const pending = {
          ...state,
          session: "loading" as const,
          contract: null,
          data: null,
          contractPhase: "loading" as const,
        };
        expect(projectView(pending, { ...shell, sessionPresumed: true }).content).toBe("overview");
        expect(projectView(pending, shell).content).toBe("gate");
        const s = yield* contentStory();
        s.send({ _tag: "ChangedOperatorView", view: overview, overview: overviewOf(state) })
          .expectExact(commands.FocusPendingTarget)
          .resolve(commands.FocusPendingTarget, Component.noop);
        expect(s.model.overview?._tag).toBe("Ready");
      }),
    ));

  it("holds a connector's evidence while it is read again, for the overview and the island pages alike", () =>
    story(
      Effect.gen(function* () {
        let state = maintainerState();
        const listeners = new Set<() => void>();
        const store = Layer.succeed(OperatorStore, {
          get: () => state,
          subscribe: (listener: () => void) => {
            listeners.add(listener);
            return () => void listeners.delete(listener);
          },
        } as unknown as import("../src/operator-ui/app/services/store.js").OperatorStoreShape);
        const health = Context.get(yield* Layer.build(Layer.provide(ConnectorHealth.layer, store)), ConnectorHealth);
        const publish = (next: OperatorState) => {
          state = next;
          for (const listener of listeners) listener();
        };
        const settled = health.steady(state);
        const [first] = fixture.contract.live.connectors;
        const reading = maintainerState({
          contract: {
            ...fixture.contract,
            live: {
              ...fixture.contract.live,
              connectors: fixture.contract.live.connectors.map((live) =>
                live.id === first!.id ? { ...live, status: "error" as const } : live,
              ),
            },
          },
          data: {
            ...fixture.data,
            connectors: fixture.data.connectors.map((row) =>
              row.id === first!.id ? { ...row, status: "loading" as const } : row,
            ),
          },
        });
        publish(reading);
        expect(health.steady(reading).rows[first!.id]).toBe(settled.rows[first!.id]);
        publish({ ...reading, session: "gated" });
        publish(reading);
        expect(health.steady(reading).rows[first!.id]!.live.status).toBe("error");
      }),
    ));

  it("projects loading, contract failure and a ready overview, reusing one projection until its inputs change", () => {
    const project = overviewProjection();
    const state = maintainerState();
    const steady = steadyHealth(state, null);
    const ready = project(state, steady);
    expect(ready._tag).toBe("Ready");
    expect(project({ ...state, tokenBusy: !state.tokenBusy }, steady)).toBe(ready);
    expect(project(state, steadyHealth(state, null))).not.toBe(ready);
    expect(overviewOf(maintainerState({ contract: null, data: null, contractPhase: "loading" }))._tag).toBe("Loading");
    expect(
      overviewOf(maintainerState({ contract: null, data: null, contractPhase: "error", loadFailure: "network" })),
    ).toEqual({
      _tag: "Contract",
      contract: {
        _tag: "LoadFailure",
        title: "Couldn't reach Connecta",
        body: "Your browser couldn't connect. Retry.",
      },
    });
  });

  it("renders the headline, attention list and map host, and follows its links through the controller", () =>
    story(
      Effect.gen(function* () {
        const overview = overviewOf(maintainerState());
        if (overview._tag !== "Ready") throw new Error("expected a ready overview");
        const s = yield* Scene.make(OverviewPageNoDeps, { overview });
        s.expectMount(HostConnectionMap({ map: overview.map }))
          .expect(HtmlLocator.role("heading", { name: "Overview" }))
          .toExist()
          .expect(Locator.text("4 need attention"))
          .toExist()
          .expect(Locator.attr("data-attention", "connector:slot"))
          .toHaveText(/Empty slot needs a credential/)
          .click(HtmlLocator.role("link", { name: "View endpoints" }));
        expect(s.current.defaultPrevented).toBe(true);
        s.expectExact(commands.NavigateToPage.make({ page: "endpoints", href: "/endpoints" })).resolve(
          commands.NavigateToPage,
          Component.noop,
        );
      }),
    ));

  it("offers Retry for a failed configuration read", () =>
    story(
      Effect.gen(function* () {
        const overview = overviewOf(
          maintainerState({ contract: null, data: null, contractPhase: "error", loadFailure: "server" }),
        );
        const s = yield* Scene.make(OverviewPageNoDeps, { overview });
        s.expect(HtmlLocator.role("alert"))
          .toHaveText(/Couldn't reach Connecta/)
          .click(HtmlLocator.role("button", { name: "Retry" }))
          .expectExact(commands.RetryLoad)
          .resolve(commands.RetryLoad, Component.noop);
      }),
    ));

  it("copies a fix prompt and puts its label back after the copy settles", () =>
    story(
      Effect.gen(function* () {
        const props = {
          value: "prompt",
          label: "Copy fix prompt",
          className: "btn sm quiet",
          ariaLabel: "Copy fix prompt for crm",
        };
        const s = yield* Story.make(CopyButton, props);
        s.send({ _tag: "ClickedCopy" }).expectExact(CopyText.make({ value: "prompt" }));
        s.resolve(CopyText, { _tag: "SucceededCopyText" }).expectExact(WaitBeforeReset);
        expect(s.model.status).toBe("copied");
        s.resolve(WaitBeforeReset, { _tag: "CompletedWaitBeforeReset" });
        expect(s.model.status).toBe("idle");
        s.send({ _tag: "ClickedCopy" }).resolve(CopyText, { _tag: "FailedCopyText" }).expectExact(WaitBeforeReset);
        expect(s.model.status).toBe("failed");
        s.resolve(WaitBeforeReset, { _tag: "CompletedWaitBeforeReset" });
      }),
    ));
});

describe("secrets never enter Effect UI state", () => {
  const ISSUED = "issued-agent-secret";
  const CANDIDATE = "candidate-credential-secret";
  const serialized = (...values: unknown[]) => JSON.stringify(values);

  it("projects an issued agent token out of both shell Models", () =>
    story(
      Effect.gen(function* () {
        const issued = view({
          session: "ready",
          role: "maintainer",
          page: "tokens",
          createdToken: ISSUED,
          createdTokenFor: "triage",
        });
        expect(serialized(issued)).not.toContain(ISSUED);
        const content = yield* contentStory();
        content.send({ _tag: "ChangedOperatorView", view: issued, overview: null });
        const nav = yield* Story.make(OperatorNav, { view: view() });
        nav.send({ _tag: "ChangedOperatorView", view: issued });
        expect(serialized(content.model, content.pending, nav.model, nav.pending)).not.toContain(ISSUED);
      }),
    ));

  it("keeps an issued agent token out of the overview's props and the content Model", () =>
    story(
      Effect.gen(function* () {
        const state = maintainerState({ createdToken: ISSUED, createdTokenFor: "triage" });
        const shell = { navHint: { activity: false }, account: null, sessionPresumed: false, clerkSignedIn: false };
        const overview = overviewOf(state);
        expect(serialized(overview)).not.toContain(ISSUED);
        const content = yield* contentStory();
        content.send({ _tag: "ChangedOperatorView", view: projectView(state, shell), overview });
        expect(content.model.overview?._tag).toBe("Ready");
        expect(serialized(content.model, content.pending)).not.toContain(ISSUED);
      }),
    ));

  it("sends a credential candidate to its Command as an opaque one-shot handle", () =>
    story(
      Effect.gen(function* () {
        const held = new Map<CandidateHandle, unknown>();
        const requests: unknown[] = [];
        bridge.installIslandHost({
          controller: {
            holdCredentialCandidate: (body: unknown) => {
              const handle = `candidate-${held.size + 1}` as CandidateHandle;
              held.set(handle, body);
              return handle;
            },
          } as unknown as OperatorControllerShape,
          steadyHealth: () => ({ generation: 0, rows: {} }),
          run: () => {},
          request: (request) => void requests.push(request),
          navigate: () => {},
          location: () => ({ url: "/connectors/crm", hash: "" }),
        });
        bridge.saveCredential("crm", { values: { token: CANDIDATE } }, "test");
        bridge.saveCredential("crm", { value: CANDIDATE });
        expect(serialized(requests)).not.toContain(CANDIDATE);
        expect(serialized([...held.values()])).toContain(CANDIDATE);
        const s = yield* contentStory();
        for (const request of requests) {
          s.send({ _tag: "RequestedPageWrite", request: request as never }).expectExact(commands.SaveCredential);
          expect(serialized(s.model, s.pending)).not.toContain(CANDIDATE);
          s.resolve(commands.SaveCredential, Component.noop);
        }
      }),
    ));

  it("keeps the typed bearer token in the field: the gate has no Model and no message that carries it", () =>
    story(
      Effect.gen(function* () {
        const s = yield* Story.make(Gate, { view: view({ session: "gated" }) });
        expect(s.model).toBeNull();
        for (const [tag, message] of Object.entries(GateMessage.cases)) {
          expect([tag, Object.keys(message.fields)]).toEqual([tag, ["_tag"]]);
        }
        s.send({ _tag: "ClickedRetry" }).expectExact(commands.RetryLoad).resolve(commands.RetryLoad, Component.noop);
      }),
    ));
});

describe("top bar", () => {
  it("navigates a page link through the controller and the router", () =>
    story(
      Effect.gen(function* () {
        const s = yield* Story.make(OperatorNav, { view: view({ session: "ready", role: "maintainer" }) });
        s.send({ _tag: "ClickedPageLink", page: "activity" }).expectExact(commands.NavigateToPage);
        expect(s.pending[0]!.command.args).toEqual({ page: "activity", href: "/activity" });
        s.resolve(commands.NavigateToPage, Component.noop);
        s.send({ _tag: "RequestedSessionActionAccount" })
          .expectExact(commands.ForgetBearer)
          .resolve(commands.ForgetBearer, Component.noop);
      }),
    ));

  it("opens and closes the account menu and asks its owner for the session action", () =>
    story(
      Effect.gen(function* () {
        const s = yield* Story.make(AccountMenu, {
          account: "alice@example.com",
          role: "Maintainer, signed in with a bearer token",
          action: "changeToken",
        });
        s.send({ _tag: "ClickedTrigger" });
        expect(s.model.open).toBe(true);
        s.send({ _tag: "CompletedTrackOutside" });
        expect(s.model.open).toBe(false);
        s.send({ _tag: "ClickedSessionAction" }).emitted({ _tag: "RequestedSessionAction" });
      }),
    ));
});
