/**
 * A stand-in for the Cloudflare Access edge under `wrangler dev`.
 *
 * In production Access authenticates the request before the Worker runs and
 * hands the Worker a trusted identity on `ctx.access`. Local dev has no Access
 * edge (and this wrangler ignores the config's `access.dev` block), so the
 * smoke wraps the Worker's fetch and attaches the identity Access would have.
 * Nothing about connecta is simulated: the Worker below still runs its own
 * `cloudflareAccessAuth()` against that `ctx.access`.
 */
type WorkerFetch = (request: Request, env: never, ctx: ExecutionContext) => Promise<Response>;

export function withAccess(inner: { fetch: WorkerFetch }) {
  return {
    fetch(request: Request, env: never, ctx: ExecutionContext): Promise<Response> {
      const access = {
        aud: "connecta-eval",
        getIdentity: async () => ({
          user_uuid: "eval-operator",
          email: "operator@example.com",
        }),
      };
      const forwarded = {
        waitUntil: (promise: Promise<unknown>) => ctx.waitUntil(promise),
        passThroughOnException: () => ctx.passThroughOnException(),
        props: ctx.props,
        access,
      } as unknown as ExecutionContext;
      return inner.fetch(request, env, forwarded);
    },
  };
}
