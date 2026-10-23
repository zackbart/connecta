/**
 * A world is one trial's downstream universe: six fake services sharing one
 * ledger and one clock, started fresh and thrown away afterwards.
 */
import { FakeRestService, restState, type RestVendor } from "./rest.js";
import type { ProgramObservation } from "../deploy/observed-executor.js";
import { FakeOAuth } from "./oauth.js";
import { assetTools, revenuecatTools, supabaseTools, PREREQUISITE_GUIDES } from "./prerequisites.js";
import { FakeService, Ledger } from "./service.js";
import {
  analyticsTools,
  auditTools,
  billingTools,
  chatState,
  chatTools,
  ciTools,
  ciState,
  type AuditState,
  type ChatState,
} from "./services.js";
import { trackerState, trackerTools, type TrackerState } from "./tracker.js";

export type ServiceId =
  | "tracker"
  | "chat"
  | "analytics"
  | "billing"
  | "ci"
  | "audit"
  | "revenuecat"
  | "supabase"
  | "assets";

/**
 * How a deployment should wire one fake. Deliberately connecta-agnostic: the
 * deployment adapters translate it, so a rewrite of connecta's config surface
 * changes one adapter rather than every task.
 */
export interface ConnectorSpec {
  id: string;
  title: string;
  description: string;
  url: string;
  usageGuide?: string;
  rest?: RestVendor;
  /** A credential the operator manages; absent means the fake is open. */
  credential?: { label: string; value?: string };
}

export interface WorldOptions {
  restVendor?: RestVendor;
  refundFault?: boolean;
  prerequisites?: boolean;
  assets?: boolean;
  oauth?: boolean;
  /** Whether the billing API key is already saved when the trial starts. */
  billingCredential?: "preset" | "missing";
}

const BILLING_TOKEN = "sk_eval_billing_7f3a91";

const META: Record<ServiceId, { title: string; description: string }> = {
  revenuecat: { title: "RevenueCat", description: "Production subscription access" },
  supabase: { title: "Supabase", description: "Production database orders" },
  assets: { title: "Brand assets", description: "Launch badges and images" },
  tracker: { title: "Issue tracker", description: "Issues across the web, api and mobile projects" },
  chat: { title: "Team chat", description: "Channels and messages" },
  analytics: { title: "Product analytics", description: "Customer accounts, revenue and usage metrics" },
  billing: { title: "Billing", description: "Billing customers and invoices" },
  ci: { title: "CI", description: "Continuous integration runs and logs" },
  audit: { title: "Audit log", description: "Workspace audit events and exports" },
};

export class World {
  readonly rest = restState();
  readonly restServices: FakeRestService[] = [];
  readonly now = Date.now();
  readonly ledger = new Ledger();
  readonly tracker: TrackerState;
  readonly chat: ChatState;
  readonly ci = ciState(this.now);
  readonly audit: AuditState = { exports: [] };
  readonly services: Map<ServiceId, FakeService>;
  readonly billingToken = BILLING_TOKEN;
  readonly oauth = new FakeOAuth(this.ledger);
  /** Host-observed guest calls, never inferred from model source text. */
  programs: ProgramObservation[] = [];

  constructor(readonly options: WorldOptions = {}) {
    if (options.restVendor) {
      const vendor = options.restVendor;
      const ids =
        vendor === "cloudflare"
          ? ["cloudflare_prod", "cloudflare_legacy"]
          : [vendor === "stripe" ? "stripe_sandbox" : "vercel_rest"];
      this.restServices = ids.map((id) => new FakeRestService(id, vendor, this.ledger, this.rest, options.refundFault));
    }
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
      ["ci", make("ci", ciTools(this.now, this.ci))],
      ["audit", make("audit", auditTools(this.audit, clock))],
      ...(options.prerequisites
        ? ([
            ["revenuecat", make("revenuecat", revenuecatTools())],
            ["supabase", make("supabase", supabaseTools())],
          ] as [ServiceId, FakeService][])
        : []),
      ...(options.assets ? ([["assets", make("assets", assetTools())]] as [ServiceId, FakeService][]) : []),
    ]);
  }

  service(id: ServiceId): FakeService {
    return this.services.get(id)!;
  }

  async start(): Promise<void> {
    await Promise.all([...this.services.values(), ...this.restServices].map((service) => service.start()));
  }

  async stop(): Promise<void> {
    await Promise.allSettled([...this.services.values(), ...this.restServices].map((service) => service.stop()));
  }

  connectorSpecs(): ConnectorSpec[] {
    if (this.options.restVendor)
      return this.restServices.map((service) => ({
        id: service.name,
        title: service.name,
        description: `Fake ${service.vendor} REST`,
        url: service.url,
        rest: service.vendor,
        credential: { label: "Fake vendor credential", value: service.credential },
      }));
    return [...this.services.values()].map((service) => {
      const id = service.name as ServiceId;
      return {
        id,
        ...META[id],
        ...(id in PREREQUISITE_GUIDES
          ? { usageGuide: PREREQUISITE_GUIDES[id as keyof typeof PREREQUISITE_GUIDES] }
          : {}),
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
