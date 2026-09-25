/**
 * A world is one trial's downstream universe: six fake services sharing one
 * ledger and one clock, started fresh and thrown away afterwards.
 */
import { FakeService, Ledger } from "./service.js";
import {
  analyticsTools,
  auditTools,
  billingTools,
  chatState,
  chatTools,
  ciTools,
  type AuditState,
  type ChatState,
} from "./services.js";
import { trackerState, trackerTools, type TrackerState } from "./tracker.js";

export type ServiceId = "tracker" | "chat" | "analytics" | "billing" | "ci" | "audit";

/**
 * How a deployment should wire one fake. Deliberately connecta-agnostic: the
 * deployment adapters translate it, so a rewrite of connecta's config surface
 * changes one adapter rather than every task.
 */
export interface ConnectorSpec {
  id: ServiceId;
  title: string;
  description: string;
  url: string;
  /** A credential the operator manages; absent means the fake is open. */
  credential?: { label: string; value?: string };
}

/**
 * The deployment's artifacts as plain data, taken after the conversation so
 * graders — which are synchronous over the world — can read them. Filled in
 * by the runner only when the deployment has the artifacts module.
 */
export interface ArtifactSnapshot {
  artifacts: {
    id: string;
    title: string;
    kind: string;
    archived: boolean;
    revision: number;
    /** The current view's source. */
    source: string;
    /** Every view version, newest first, each with its source. */
    views: { version: number; op: string; source: string; by: { kind: string; id?: string } }[];
    /** Current value of every live document. */
    documents: Record<string, unknown>;
    /** Every version of every document ever set, newest first. */
    documentHistory: Record<string, { version: number; op: string; runId?: string; value: unknown }[]>;
    /** The refresh set on it, if any. */
    refresh?: { schedule: string; document: string; programVersion: number };
    runs: { runId: string; status: string; documentVersion?: number; errorCode?: string }[];
  }[];
}

export interface WorldOptions {
  /** Whether the billing API key is already saved when the trial starts. */
  billingCredential?: "preset" | "missing";
}

const BILLING_TOKEN = "sk_eval_billing_7f3a91";

const META: Record<ServiceId, { title: string; description: string }> = {
  tracker: { title: "Issue tracker", description: "Issues across the web, api and mobile projects" },
  chat: { title: "Team chat", description: "Channels and messages" },
  analytics: { title: "Product analytics", description: "Customer accounts, revenue and usage metrics" },
  billing: { title: "Billing", description: "Billing customers and invoices" },
  ci: { title: "CI", description: "Continuous integration runs and logs" },
  audit: { title: "Audit log", description: "Workspace audit events and exports" },
};

export class World {
  readonly now = Date.now();
  readonly ledger = new Ledger();
  readonly tracker: TrackerState;
  readonly chat: ChatState;
  readonly audit: AuditState = { exports: [] };
  readonly services: Map<ServiceId, FakeService>;
  readonly billingToken = BILLING_TOKEN;
  /** Set by the runner before grading, when the deployment has artifacts. */
  artifacts?: ArtifactSnapshot;

  constructor(readonly options: WorldOptions = {}) {
    this.tracker = trackerState(this.now);
    this.chat = chatState(this.now);
    const clock = () => Date.now();
    const make = (id: ServiceId, tools: ConstructorParameters<typeof FakeService>[2], bearer?: () => string) =>
      new FakeService(id, META[id].description, tools, this.ledger, bearer ? { bearer } : {});
    this.services = new Map<ServiceId, FakeService>([
      ["tracker", make("tracker", trackerTools(this.tracker, clock))],
      ["chat", make("chat", chatTools(this.chat, clock))],
      ["analytics", make("analytics", analyticsTools())],
      ["billing", make("billing", billingTools(this.now), () => BILLING_TOKEN)],
      ["ci", make("ci", ciTools(this.now))],
      ["audit", make("audit", auditTools(this.audit, clock))],
    ]);
  }

  service(id: ServiceId): FakeService {
    return this.services.get(id)!;
  }

  async start(): Promise<void> {
    await Promise.all([...this.services.values()].map((service) => service.start()));
  }

  async stop(): Promise<void> {
    await Promise.allSettled([...this.services.values()].map((service) => service.stop()));
  }

  connectorSpecs(): ConnectorSpec[] {
    return [...this.services.values()].map((service) => {
      const id = service.name as ServiceId;
      return {
        id,
        ...META[id],
        url: service.url,
        ...(id === "billing"
          ? {
              credential: {
                label: "Billing API key",
                ...(this.options.billingCredential === "missing" ? {} : { value: BILLING_TOKEN }),
              },
            }
          : {}),
      };
    });
  }

  /** Messages the agent posted, in order. */
  posts(channel?: string) {
    return this.chat.messages.filter(
      (message) => message.byAgent && (channel === undefined || message.channel === channel),
    );
  }
}
