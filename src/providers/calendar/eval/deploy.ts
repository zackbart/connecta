/** Node-free: the agent Worker bundles this into workerd. */
import { calendar } from "@zackbart/connecta/providers/calendar";
import type { ProviderDeploy } from "../../../../eval/support/provider-eval.js";

export const evalDeploy: ProviderDeploy = {
  connector: (spec, options) => {
    if (!spec.google?.serviceAccount) throw new Error("The Calendar eval spec needs its world's service account.");
    // Each admitted caller (the agent acts as its pool's owner) maps to alice's calendar.
    return calendar(spec.id, {
      ...options,
      serviceAccount: spec.google.serviceAccount,
      subject: () => "alice@example.com",
    });
  },
};
