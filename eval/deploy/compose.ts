/**
 * The agent-eval composition both targets share: one task's connector specs
 * and deployment passthrough turned into a `createConnecta` configuration.
 * Node-free, so `eval/deploy/worker-agent.ts` bundles it for workerd and
 * `eval/deploy/node.ts` serves it with `listen()`. Only the platform slots
 * differ: storage, executor, vault key and, on Workers, Access.
 */
import { quickbooksConnectors, quickbooksAuth, quickbooksPools } from "./quickbooks.js";
import { granola } from "@zackbart/connecta/providers/granola";
import { gmail } from "@zackbart/connecta/providers/gmail";
import { drive } from "@zackbart/connecta/providers/drive";
import { docs } from "@zackbart/connecta/providers/docs";
import { sheets } from "@zackbart/connecta/providers/sheets";
import { slides } from "@zackbart/connecta/providers/slides";
import { forms } from "@zackbart/connecta/providers/forms";
import { github } from "@zackbart/connecta/providers/github";
import { stripe } from "@zackbart/connecta/providers/stripe";
import { cloudflare } from "@zackbart/connecta/providers/cloudflare";
import { vercel } from "@zackbart/connecta/providers/vercel";
import { ccb } from "@zackbart/connecta/providers/ccb";
import { overflow } from "@zackbart/connecta/providers/overflow";
import { breeze } from "@zackbart/connecta/providers/breeze";
import { planningCenter } from "@zackbart/connecta/providers/planning-center";
import { tithely } from "@zackbart/connecta/providers/tithely";
import { remoteMcp, type Connecta, type createConnecta } from "@zackbart/connecta";
import type { ConnectorSpec } from "../fakes/world.js";

type Config = Parameters<typeof createConnecta>[0];
type Vault = {
  set(id: string, value: string, actor: string): Promise<unknown>;
  setAll(id: string, values: Record<string, string>, actor: string): Promise<unknown>;
};

/** Fixture identifiers owned by Node-only fake modules, passed in so this file stays bundleable. */
interface EvalFixtures {
  alice: string;
  accountA: string;
  shopZone: string;
}

const QUIET = { debug() {}, info() {}, warn() {}, error() {} };

export interface EvalComposition {
  connectors: ConnectorSpec[];
  /** The task's untyped `deployment` passthrough. */
  extra: Record<string, unknown>;
  fixtures: EvalFixtures;
  readOnly: boolean;
  /** Connector ids the endpoint adds to every pool, such as injected faults. */
  everyPool?: string[];
}

/**
 * `extra` is a task's untyped passthrough, spread over the config last, so a
 * later phase's task can switch on a config key the adapters have never heard
 * of without a harness change. `pool`, `pools` and `quickbooksWrites` are the
 * adapter's own keys.
 */
export function evalConfig(
  composition: EvalComposition,
  slots: Pick<Config, "storage" | "executor" | "vault" | "publicUrl" | "accessTokens" | "ui"> & {
    auth?: Pick<Config, "auth" | "maintainers">;
    oauthConnector?: Config["connectors"][number];
  },
): Config {
  const { connectors, fixtures, everyPool = [] } = composition;
  const { pool: _pool, pools: taskPools, quickbooksWrites, ...passthrough } = composition.extra;
  const ids = [...(slots.oauthConnector ? ["oauth"] : []), ...connectors.map((spec) => spec.id)];
  const qb = connectors.find((spec) => spec.quickbooks);
  const withEvery = (pools: Record<string, { tools: string[] }> | undefined) =>
    pools &&
    Object.fromEntries(
      Object.entries(pools).map(([id, pool]) => [id, { ...pool, tools: [...new Set([...pool.tools, ...everyPool])] }]),
    );
  return {
    readOnly: composition.readOnly,
    storage: slots.storage,
    agents: ["eval-machine"],
    accessTokens: slots.accessTokens,
    ...slots.auth,
    pools: {
      eval: {
        tools: ids,
        members: ["agent:eval-machine"],
        ...(connectors.some((spec) => spec.google) ? { owner: fixtures.alice } : {}),
      },
      ...withEvery(taskPools as Record<string, { tools: string[]; members: string[]; readOnly?: boolean }> | undefined),
    },
    publicUrl: slots.publicUrl,
    executor: slots.executor,
    vault: slots.vault,
    ...(slots.ui ? { ui: slots.ui } : {}),
    logger: QUIET,
    connectors: [
      ...(slots.oauthConnector ? [slots.oauthConnector] : []),
      ...connectors.map((spec) => evalConnector(spec, fixtures)),
    ],
    ...(qb
      ? {
          auth: quickbooksAuth,
          maintainers: ["alice", "bob"],
          pools: withEvery(quickbooksPools(quickbooksWrites === true))!,
          connectors: [
            ...quickbooksConnectors(quickbooksWrites === true, qb.quickbooks!.clientId),
            ...connectors.filter((spec) => everyPool.includes(spec.id)).map((spec) => evalConnector(spec, fixtures)),
          ],
        }
      : {}),
    ...(passthrough as Partial<Config>),
  } as Config;
}

function evalConnector(spec: ConnectorSpec, fixtures: EvalFixtures) {
  const options = { purpose: spec.description };
  if (spec.granola) return granola(spec.id, options);
  if (spec.google) {
    const factory = { gmail, drive, docs, sheets, slides, forms }[spec.google.product];
    return factory(spec.id, {
      ...options,
      serviceAccount: spec.google.serviceAccount,
      subject: spec.google.subject === "fixed" ? fixtures.alice : () => fixtures.alice,
    });
  }
  if (spec.rest === "github")
    return github(spec.id, {
      ...options,
      app: spec.githubApp!,
      scopes: [
        { org: "alice", access: "read-write", workflows: "write" },
        { repo: "bob/one", access: "read" },
      ],
    });
  if (spec.rest === "ccb")
    return ccb(spec.id, {
      ...options,
      environment: "production",
      mode: "system",
      access: "read-write",
      ...JSON.parse(spec.credential!.value!),
    });
  if (spec.rest === "overflow") return overflow(spec.id, { ...options, environment: "staging", baseUrl: spec.url });
  if (spec.rest === "breeze") return breeze(spec.id, { ...options, subdomain: "church" });
  if (spec.rest === "planning-center") return planningCenter(spec.id, { ...options, baseUrl: spec.url });
  if (spec.rest === "stripe") return stripe(spec.id, { ...options, auth: { type: "apiKey" }, mode: "sandbox" });
  if (spec.rest === "tithely")
    return tithely(spec.id, { ...options, environment: "live", baseUrl: `${spec.url}/api/v1` });
  if (spec.rest === "vercel") return vercel(spec.id, { ...options, auth: { type: "token" }, teamId: "team_fake" });
  if (spec.rest === "cloudflare")
    return cloudflare(spec.id, {
      ...options,
      ...(spec.id === "cloudflare_legacy"
        ? { auth: { type: "globalApiKey" as const } }
        : { auth: { type: "apiToken" as const } }),
      pin: { accountIds: [fixtures.accountA] },
      ...(spec.id === "cloudflare_legacy"
        ? { instructions: `The operator's zone inventory reports shop.example.org as zone ${fixtures.shopZone}.` }
        : {}),
    });
  return remoteMcp(spec.id, {
    url: spec.url,
    title: spec.title,
    description: spec.description,
    ...(spec.usageGuide ? { usageGuide: spec.usageGuide } : {}),
    logger: QUIET,
    ...(spec.credential ? { auth: { type: "credential" as const, credential: { label: spec.credential.label } } } : {}),
  });
}

/** The operator's saved credentials when the trial starts. CCB connects through OAuth instead. */
export async function presetCredentials(vault: Vault, connectors: ConnectorSpec[]): Promise<void> {
  for (const spec of connectors) {
    if (spec.rest === "ccb" || !spec.credential?.value) continue;
    if (
      spec.id === "cloudflare_legacy" ||
      spec.rest === "tithely" ||
      spec.rest === "planning-center" ||
      spec.rest === "overflow"
    )
      await vault.setAll(spec.id, JSON.parse(spec.credential.value), "operator");
    else await vault.set(spec.id, spec.credential.value, "operator");
  }
}

/** Complete CCB's system OAuth against the fake, as an operator would before the trial. */
export async function connectCcb(connecta: Connecta, connectors: ConnectorSpec[], origin: string): Promise<void> {
  for (const spec of connectors.filter((entry) => entry.rest === "ccb")) {
    const connector = connecta.registry.getConnector(spec.id)!;
    const ctx = connecta.registry.contextFor(spec.id, origin);
    const start = await connector.startAuth!({ ...ctx, allowAuthorization: true });
    const state = new URL(start.authorizationUrl!).searchParams.get("state")!;
    if (!(await connector.verifyState!(state, ctx))) throw new Error("CCB eval OAuth state was refused.");
    await connector.finishAuth!("fake-code", ctx, new URLSearchParams({ code: "fake-code", state }));
  }
}

/** Agents use /agent/<pool>; human endpoints refuse their cta_ token (#837). */
export function evalMcpPath(extra: Record<string, unknown>, oauth: boolean): string {
  const pool = typeof extra.pool === "string" ? extra.pool : oauth ? undefined : "eval";
  return !oauth && typeof pool === "string" ? `/agent/${pool}` : `/mcp${typeof pool === "string" ? `/${pool}` : ""}`;
}
