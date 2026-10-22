// Candidate credential tests are anonymous read calls, never context copies
// that borrow an admitted caller, budget, or served write classification.
import { callFromContext, contextView, operationView, viewLease } from "./call.js";
import type { ConnectorContext, ConnectorCredentialValues } from "../types.js";
export function credentialProbeContext(ctx: ConnectorContext, values: ConnectorCredentialValues): ConnectorContext {
  const operation = operationView(
    {
      storage: ctx.storage,
      logger: ctx.logger,
      baseUrl: ctx.baseUrl,
      ...(ctx.publicUrl !== undefined ? { publicUrl: ctx.publicUrl } : {}),
      ...(ctx.oauthClientName !== undefined ? { oauthClientName: ctx.oauthClientName } : {}),
      ...(ctx.requestScope ? { requestScope: ctx.requestScope } : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      ...(ctx.timeoutMs !== undefined ? { timeoutMs: ctx.timeoutMs } : {}),
      ...(ctx.defer ? { defer: ctx.defer } : {}),
      credential: { getAll: async () => values, get: async (field = "value") => values[field] ?? null },
    },
    undefined,
  );
  const parent = viewLease(ctx);
  const lease = callFromContext(operation, "read", {
    anonymous: true,
    charge: async () => {},
    record: () => {},
    ...(parent ? { parent } : {}),
  });
  return contextView(lease, operation);
}
export async function credentialProbe<A>(
  ctx: ConnectorContext,
  values: ConnectorCredentialValues,
  work: (view: ConnectorContext) => Promise<A>,
): Promise<A> {
  const view = credentialProbeContext(ctx, values);
  try {
    return await work(view);
  } finally {
    viewLease(view)!.close();
  }
}
