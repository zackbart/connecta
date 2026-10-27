// workerd releases since September 2026 bind each AsyncResource created
// during a request to that request: `runInAsyncScope` from any other request
// throws (Workers with compatibility date 2025-06-16 or later, or the
// `bind_asynclocalstorage_snapshot_to_request` flag). Effect captures one per
// suspended fiber and resumes the fiber through it. The test pool's pinned
// workerd predates that binding, so this fixture applies the same rule. Import
// it first: Effect reads `process.getBuiltinModule("node:async_hooks")` when it
// evaluates. Under a newer workerd (MINIFLARE_WORKERD_PATH) the native check
// applies too.
//
// Like workerd, the check compares requests, not async-context values: a
// resource remembers a signal its request created, and workerd refuses to read
// that signal from any other request, whatever that request's async context
// holds. A resource created outside any request token is unbound, as workerd
// leaves one created outside any async-context frame.
import { AsyncLocalStorage, AsyncResource } from "node:async_hooks";

/** Run each fixture request inside `requestToken.run(ownedByThisRequest(), ...)`. */
export const requestToken = new AsyncLocalStorage<{ readonly signal: AbortSignal }>();
export const ownedByThisRequest = () => ({ signal: new AbortController().signal });

const message = "Cannot call this AsyncLocalStorage bound function outside of the request in which it was created.";

class RequestBoundAsyncResource extends AsyncResource {
  readonly #owner = requestToken.getStore();

  override runInAsyncScope<This, Result>(
    fn: (this: This, ...args: unknown[]) => Result,
    thisArg?: This,
    ...args: unknown[]
  ): Result {
    if (this.#owner) {
      try {
        void this.#owner.signal.aborted;
      } catch {
        throw new Error(message);
      }
    }
    return super.runInAsyncScope(fn, thisArg, ...args);
  }
}

const runtime = globalThis as unknown as { process: { getBuiltinModule(name: string): unknown } };
const builtin = runtime.process.getBuiltinModule.bind(runtime.process);
runtime.process.getBuiltinModule = (name: string) =>
  name === "node:async_hooks" || name === "async_hooks"
    ? { ...(builtin(name) as object), AsyncResource: RequestBoundAsyncResource }
    : builtin(name);
