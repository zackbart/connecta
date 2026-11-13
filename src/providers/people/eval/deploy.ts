/** Node-free: the agent Worker bundles this into workerd. */
import { people } from "@zackbart/connecta/providers/people";
import type { ProviderDeploy } from "../../../../eval/support/provider-eval.js";

/** The fixed Workspace user every eval call acts as; agents need no pool owner for a fixed subject. */
const SUBJECT = "alice@example.com";

export const evalDeploy: ProviderDeploy = {
  connector: (spec, options) =>
    people(spec.id, {
      ...options,
      // The world's own service account, from its deployment secret.
      serviceAccount: spec.credential!.value!,
      subject: SUBJECT,
    }),
};
