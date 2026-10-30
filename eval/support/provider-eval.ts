/**
 * The provider-local eval contract. A maintained provider keeps its eval
 * wiring in `src/providers/<name>/eval/`, never shipped:
 *
 *   fake.ts    `evalFake`: its fake vendor world (Node)
 *   tasks.ts   `evalTasks`: tasks, check classification, outcome and smoke enrollment (Node)
 *   deploy.ts  `evalDeploy`: the published connector for its fake specs; Node-free,
 *              because the agent Worker bundles it into workerd
 *   worker.ts  optional: the dedicated `worker-<name>` smoke composition wrangler loads
 *
 * `providers:generate` discovers these files and writes the shared
 * registrations (`eval/{fakes,tasks,deploy}/providers.generated.ts`), so adding
 * a provider edits no shared eval file. Providers whose eval wiring predates
 * this layout stay hand-wired in eval/ until they move.
 */
import type { createConnecta } from "@zackbart/connecta";
import type { Ledger } from "../fakes/service.js";
import type { ConnectorSpec, World } from "../fakes/world.js";
import type { ActiveTask } from "../tasks/types.js";

/** One provider's fake vendor, created fresh for every world. */
export interface ProviderFakeWorld {
  /** Independent vendor state the graders read and saved grading inputs carry. */
  readonly state: object;
  /** The loopback origin, once started. */
  readonly url: string;
  /** Starts serving and registers its credential routes with eval/fakes/transport.ts. */
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Enabled by `world: { <name>: true }`, reached as `world.fakes.<name>`. The fake
 * records ledger calls under `service: "<name>"`.
 */
export interface ProviderFake<Fake extends ProviderFakeWorld = ProviderFakeWorld> {
  /** An unstarted fake sharing the world's ledger. */
  create(ledger: Ledger): Fake;
  /** Connector specs for the agent's deployment; the world stamps `provider: "<name>"`. */
  specs(fake: Fake): Omit<ConnectorSpec, "provider">[];
  /** Whether saved grading state carries every field the graders read. */
  saved(state: Fake["state"]): boolean;
}

type Connector = Parameters<typeof createConnecta>[0]["connectors"][number];

/** Turns this provider's fake specs into its published connector, on Node and on workerd. */
export interface ProviderDeploy {
  connector(spec: ConnectorSpec, options: { purpose: string }): Connector;
}

/** One task's `eval:outcomes` enrollment. */
interface ProviderOutcome {
  /** The outcome scenario's description. */
  scenario: string;
  /** Names the answer for a control that empties the vendor ledger and must then fail. */
  withoutCalls?: string;
  /** Joins the control that strips the facts delivered over MCP and must then fail. */
  withoutDeliveredFacts?: boolean;
}

export interface ProviderTasks {
  /** Active tasks, ahead of the hand-wired ones in ACTIVE_TASKS. */
  tasks: ActiveTask[];
  /** Every task's check classification (eval/tasks/grading.ts). */
  checkKinds: Record<string, { route: string[]; outcome: string[] }>;
  /** Task ids `eval:outcomes` plays, in order. */
  outcomes?: Record<string, ProviderOutcome>;
  /** `eval:smoke` journeys: `node-<name>` and, with eval/worker.ts, `worker-<name>`. */
  smoke?: {
    description: string;
    tasks: ActiveTask[];
    /** The `worker-<name>` wrangler name and the fake's location as `NAME:value` vars. */
    worker?: { name: string; vars(world: World): string[] };
  };
  /** Task ids the selftest's worker vendor-gateway control plays. */
  gatewayControls?: string[];
}
