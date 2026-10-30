/** Node-free: the agent Worker bundles this into workerd. */
import { granola } from "@zackbart/connecta/providers/granola";
import type { ProviderDeploy } from "../../../../eval/support/provider-eval.js";

export const evalDeploy: ProviderDeploy = {
  connector: (spec, options) => granola(spec.id, options),
};

/** Eval-only interception: the provider's production origin remains fixed. */
export function interceptGranola(target: string): () => void {
  const forward = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    return forward(
      url.origin === "https://public-api.granola.ai"
        ? new Request(`${target}${url.pathname}${url.search}`, request)
        : request,
    );
  }) as typeof fetch;
  return () => {
    globalThis.fetch = forward;
  };
}
