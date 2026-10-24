import { ConnectorCallError } from "../../errors.js";
import type { SafetyOptions } from "../../http/safety.js";
import type { Operation } from "../../http/vendor.js";
import { googleSafety } from "../_shared/google/kit.js";
import { index, verdicts, refusalReasons } from "./lib/index.js";

/** Mail headers and page tokens are data; only the reviewed mailbox routes execute. */
export function gmailSafety(operations: readonly Operation[]): SafetyOptions {
  const base = googleSafety("Gmail", operations);
  return {
    ...base,
    reviewed: {
      ...base.reviewed!,
      resolve: (method, path) => {
        const { op } = index.resolve(method, path);
        const key = `${op.method} ${op.path}` as keyof typeof verdicts;
        // The two MIME writers are named-only. The hatch refuses them before send.
        if (verdicts[key] !== "read" && key !== "POST /drafts" && key !== "PUT /drafts/{id}")
          throw new ConnectorCallError("invalid_args", refusalReasons[key] ?? "This Gmail operation is refused.");
        return base.reviewed!.resolve!(method, path);
      },
    },
  };
}
