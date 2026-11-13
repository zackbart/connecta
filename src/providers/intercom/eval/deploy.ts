import { intercom } from "@zackbart/connecta/providers/intercom";
import type { ProviderDeploy } from "../../../../eval/support/provider-eval.js";

export const evalDeploy: ProviderDeploy = {
  connector: (spec, options) => intercom(spec.id, { ...options, admin: "1001" }),
};
