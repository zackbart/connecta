/**
 * Injection for the fixed smoke Worker compositions (worker-fakes, -granola,
 * -quickbooks). Node-free. `EVAL_INJECTED` carries the injected connector
 * specs as JSON and `EVAL_D1_LATENCY_MS` the D1 round-trip delay; both are
 * absent when the run injects nothing. See eval/fakes/injection.ts.
 */
import { remoteMcp } from "@zackbart/connecta";
import { withD1Latency } from "./d1-latency.js";

export interface InjectedEnv {
  EVAL_INJECTED?: string;
  EVAL_D1_LATENCY_MS?: string;
}

interface Spec {
  id: string;
  title: string;
  description: string;
  url: string;
  credential?: { label: string; value?: string };
}

const specs = (env: InjectedEnv): Spec[] => (env.EVAL_INJECTED ? (JSON.parse(env.EVAL_INJECTED) as Spec[]) : []);

function injectedIds(env: InjectedEnv): string[] {
  return specs(env).map((spec) => spec.id);
}

export function injectedConnectors(env: InjectedEnv) {
  return specs(env).map((spec) =>
    remoteMcp(spec.id, {
      url: spec.url,
      title: spec.title,
      description: spec.description,
      ...(spec.credential
        ? { auth: { type: "credential" as const, credential: { label: spec.credential.label } } }
        : {}),
    }),
  );
}

export async function presetInjected(
  vault: { set(id: string, value: string, actor: string): Promise<unknown> },
  env: InjectedEnv,
) {
  for (const spec of specs(env))
    if (spec.credential?.value) await vault.set(spec.id, spec.credential.value, "operator");
}

export function injectedD1(db: D1Database, env: InjectedEnv): D1Database {
  const ms = Number(env.EVAL_D1_LATENCY_MS ?? 0);
  return ms > 0 ? withD1Latency(db, ms) : db;
}

/** Add the injected connectors to every pool. */
export function withInjectedPools<T extends Record<string, { tools: string[] }>>(pools: T, env: InjectedEnv): T {
  const ids = injectedIds(env);
  if (!ids.length) return pools;
  return Object.fromEntries(
    Object.entries(pools).map(([id, pool]) => [id, { ...pool, tools: [...new Set([...pool.tools, ...ids])] }]),
  ) as T;
}
