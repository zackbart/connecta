// workerd releases since September 2026 bind each AsyncResource created
// during a request to that request: `runInAsyncScope` from any other request
// throws (Workers with compatibility date 2025-06-16 or later, or the
// `bind_asynclocalstorage_snapshot_to_request` flag). Effect captures one per
// suspended fiber and resumes the fiber through it. The test pool's pinned
// workerd predates that binding, so this fixture applies the same rule,
// keyed on the token every fixture request runs under. Import it first: Effect
// reads `process.getBuiltinModule("node:async_hooks")` when it evaluates.
// Under a newer workerd (MINIFLARE_WORKERD_PATH) the native check applies too.
import { AsyncLocalStorage, AsyncResource } from "node:async_hooks";

export const requestToken = new AsyncLocalStorage<object>();

const message = "Cannot call this AsyncLocalStorage bound function outside of the request in which it was created.";

class RequestBoundAsyncResource extends AsyncResource {
  readonly #owner = requestToken.getStore();

  override runInAsyncScope<This, Result>(
    fn: (this: This, ...args: unknown[]) => Result,
    thisArg?: This,
    ...args: unknown[]
  ): Result {
    const current = requestToken.getStore();
    if (this.#owner && current && current !== this.#owner) throw new Error(message);
    return super.runInAsyncScope(fn, thisArg, ...args);
  }
}

const runtime = globalThis as unknown as { process: { getBuiltinModule(name: string): unknown } };
const builtin = runtime.process.getBuiltinModule.bind(runtime.process);
runtime.process.getBuiltinModule = (name: string) =>
  name === "node:async_hooks" || name === "async_hooks"
    ? { ...(builtin(name) as object), AsyncResource: RequestBoundAsyncResource }
    : builtin(name);
