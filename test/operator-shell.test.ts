import { Component } from "@effect/ui";
import { Story } from "@effect/ui/testing";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
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
const { Gate } = await import("../src/operator-ui/app/shell/gate.js");
const bridge = await import("../src/operator-ui/app/bridge.js");
const { OperatorNav } = await import("../src/operator-ui/app/shell/nav.js");
const { OperatorRoute } = await import("../src/operator-ui/app/shell/routes.js");

const story = (body: Effect.Effect<void, never, import("effect").Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(body));

const view = (patch: Partial<OperatorState> = {}): OperatorView =>
  projectView(
    { ...initialState("connections"), ...patch },
    { navHint: { activity: false }, account: "alice@example.com", sessionPresumed: false, clerkSignedIn: false },
  );

const route = OperatorRoute.Connectors({ search: {} });

const contentStory = (initial: OperatorView = view()) =>
  Effect.gen(function* () {
    const s = yield* Story.make(OperatorContent, { route, view: initial });
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
        s.send({ _tag: "ChangedOperatorView", view: recovering })
          .expectExact(commands.CloseForRecovery, commands.FocusRecoveryRetry)
          .resolve(commands.CloseForRecovery, Component.noop)
          .resolve(commands.FocusRecoveryRetry, Component.noop);
        expect(s.model.recovering).toBe(true);
        s.send({ _tag: "ChangedOperatorView", view: recovering }).expectNone();
      }),
    ));

  it("spends a gate focus request through the focus Command, and leaves a page's to the page", () =>
    story(
      Effect.gen(function* () {
        const s = yield* contentStory();
        s.send({ _tag: "ChangedOperatorView", view: view({ pendingFocus: "gateHeading" }) })
          .expectExact(commands.FocusPendingTarget)
          .resolve(commands.FocusPendingTarget, Component.noop);
        s.send({
          _tag: "ChangedOperatorView",
          view: view({ session: "ready", pendingFocus: "confirm-cancel-token-alice" }),
        }).expectNone();
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
        s.send({ _tag: "ChangedOperatorView", view: tokensPage("idle") })
          .expectExact(commands.LoadPageCollections)
          .resolve(commands.LoadPageCollections, Component.noop);
        s.send({ _tag: "ChangedOperatorView", view: tokensPage("loading") }).expectNone();
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
        content.send({ _tag: "ChangedOperatorView", view: issued });
        const nav = yield* Story.make(OperatorNav, { view: view() });
        nav.send({ _tag: "ChangedOperatorView", view: issued });
        expect(serialized(content.model, content.pending, nav.model, nav.pending)).not.toContain(ISSUED);
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
