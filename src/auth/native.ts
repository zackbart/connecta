// Private auth programs. Promise methods are SDK/custom edges; owned programs
// compose directly by function identity, including inherited implementations.
import { Cause, Context, Effect, Exit } from "effect";
import { getNativeStorage } from "../runtime/native-storage.js";
import { causeError, detach, fromSignal, runEdge } from "../runtime/run.js";
import type { KVStorage } from "../types.js";

type Program = (this: any, ...args: any[]) => Effect.Effect<any, unknown>;
const programs = new WeakMap<Function, Program>();
const methods = new WeakMap<object, Map<string, Program>>();
export class AuthenticationWork extends Context.Service<
  AuthenticationWork,
  { track(pending: Promise<unknown>): void }
>()("connecta/auth/Work") {}
export function hasAuthProgram(edge: Function): boolean {
  return programs.has(edge);
}

/** A bounded coordinator/submitted platform operation has its own settlement. */
export function authDetached<A>(
  effect: Effect.Effect<A, unknown>,
  waitUntil?: (pending: Promise<unknown>) => void,
): Effect.Effect<A, unknown> {
  return Effect.flatMap(Effect.serviceOption(AuthenticationWork), (work) =>
    Effect.callback<A, unknown>((resume) => {
      const settlement = detach(
        effect.pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => {
              resume(Exit.isSuccess(exit) ? Effect.succeed(exit.value) : Effect.failCause(exit.cause));
            }),
          ),
        ),
      );
      if (work._tag === "Some") work.value.track(settlement);
      try {
        waitUntil?.(settlement);
      } catch {
        /* The bounded coordinator is already running. */
      }
    }),
  );
}

export function registerAuth<F extends Program>(edge: Function, program: F): F {
  programs.set(edge, program);
  return program;
}
export function authProgram<A>(program: Program, args: any[]): Effect.Effect<A, unknown> {
  return Effect.suspend(() => program(...args)).pipe(Effect.catchDefect(Effect.fail));
}
export function registerAuthMethod(prototype: object, key: string, program: Program, own: Function): void {
  let entries = methods.get(prototype);
  if (!entries) methods.set(prototype, (entries = new Map()));
  entries.set(key, program);
  registerAuth(own, program);
}
export function authOwnMethod<A>(
  prototype: object,
  receiver: unknown,
  key: string,
  args: any[],
): Effect.Effect<A, unknown> {
  return Effect.suspend(() => methods.get(prototype)!.get(key)!.apply(receiver, args)).pipe(
    Effect.catchDefect(Effect.fail),
  );
}
function authOwn<A>(edge: Function, receiver: unknown, args: any[]): Effect.Effect<A, unknown> {
  return Effect.suspend(() => programs.get(edge)!.apply(receiver, args)).pipe(Effect.catchDefect(Effect.fail));
}
export function authMethod<P extends any[], A>(
  program: (...args: P) => Effect.Effect<A, unknown>,
): (...args: P) => Promise<A> {
  function edge(this: unknown, ...args: P): Promise<A> {
    return runEdge(authOwn<A>(edge, this, args));
  }
  registerAuth(edge, program);
  return edge;
}
export function authValue<A = any>(
  work: () => A | PromiseLike<A> | Effect.Effect<A, unknown>,
): Effect.Effect<A, unknown> {
  return Effect.suspend(() => {
    const value = work();
    if (Effect.isEffect(value)) return value;
    if (!value || typeof (value as any).then !== "function") return Effect.succeed(value as A);
    const pending = Promise.resolve(value as A);
    return Effect.flatMap(Effect.serviceOption(AuthenticationWork), (lifetime) => {
      if (lifetime._tag === "Some") lifetime.value.track(pending);
      return awaitAuthPromise(pending);
    });
  }).pipe(Effect.catchDefect(Effect.fail));
}

// Keep the platform wait separate from the synchronous service lookup.
// Accounting remains attached to the actual platform promise's settlement.
function awaitAuthPromise<A>(pending: Promise<A>): Effect.Effect<A, unknown> {
  return Effect.tryPromise({ try: () => pending, catch: (error) => error });
}
export function authCall<A = any>(
  fn: Function | undefined,
  args: any[],
  receiver?: unknown,
): Effect.Effect<A, unknown> {
  return fn === undefined
    ? Effect.succeed(undefined as A)
    : Effect.suspend(() =>
        programs.has(fn) ? authOwn<A>(fn, receiver, args) : authValue<A>(() => fn.apply(receiver, args)),
      );
}
export function authInvoke<A = any>(receiver: any, key: string, args: any[]): Effect.Effect<A, unknown> {
  return Effect.suspend(() => {
    const method = receiver[key];
    return typeof method === "function"
      ? authCall<A>(method, args, receiver)
      : authValue<A>(() => Reflect.apply(method, receiver, args));
  }).pipe(Effect.catchDefect(Effect.fail));
}
export function authStorage<A = any>(storage: KVStorage, key: keyof KVStorage, args: any[]): Effect.Effect<A, unknown> {
  return Effect.suspend(() => {
    const native = getNativeStorage(storage);
    if (!native) return authInvoke(storage, key, args);
    const operation = authValue<A>(() => (Reflect.get(native, key) as Function).apply(native, args));
    return Effect.flatMap(Effect.serviceOption(AuthenticationWork), (work) =>
      work._tag === "Some" ? authDetached(operation) : operation,
    );
  });
}
export function authThen(
  effect: Effect.Effect<any, unknown>,
  success?: Function,
  failure?: Function,
): Effect.Effect<any, unknown> {
  return Effect.matchEffect(effect, {
    onSuccess: (value) => (success ? authCall(success, [value]) : Effect.succeed(value)),
    onFailure: (error) => (failure ? authCall(failure, [error]) : Effect.fail(error)),
  });
}
export function authCatch(effect: Effect.Effect<any, unknown>, failure: Function): Effect.Effect<any, unknown> {
  return Effect.catch(effect, (error) => authCall(failure, [error]));
}
export function authAll(values: Iterable<any>, settled = false): Effect.Effect<any, unknown> {
  return Effect.all(
    Array.from(values, (value) => {
      const effect = authValue(() => value);
      return settled
        ? Effect.match(effect, {
            onSuccess: (value) => ({ status: "fulfilled", value }),
            onFailure: (reason) => ({ status: "rejected", reason }),
          })
        : effect;
    }),
    { concurrency: "unbounded" },
  );
}
export function authAwait<A>(effect: Effect.Effect<A, unknown>, signal?: AbortSignal): Effect.Effect<A, unknown> {
  return signal ? Effect.raceFirst(effect, fromSignal(signal)) : effect;
}

/**
 * Drive native auth control flow, delivering typed failures to its local
 * catch clauses. Interruption remains interruption and closes the generator;
 * its yielded finally blocks still run, including asynchronous body cleanup.
 * Every yielded operation is an Effect, never an async orchestration thunk.
 */
export function authFlow<A>(make: () => Generator<Effect.Effect<any, unknown>, A, any>): Effect.Effect<A, unknown> {
  return Effect.suspend(() => {
    const iterator = make();
    let done = false;
    const drive = (step: IteratorResult<Effect.Effect<any, unknown>, A>): Effect.Effect<A, unknown> =>
      Effect.gen(function* () {
        while (!step.done) {
          const result = yield* Effect.exit(step.value.pipe(Effect.catchDefect(Effect.fail)));
          if (Exit.isSuccess(result)) step = iterator.next(result.value);
          else {
            if (result.cause.reasons.some(Cause.isInterruptReason)) return yield* Effect.failCause(result.cause);
            step = iterator.throw(causeError(result.cause));
          }
        }
        done = true;
        return step.value;
      }).pipe(Effect.catchDefect(Effect.fail));
    return Effect.suspend(() => drive(iterator.next())).pipe(
      Effect.ensuring(
        Effect.suspend(() =>
          done ? Effect.void : drive(iterator.return(undefined as A)).pipe(Effect.orDie, Effect.asVoid),
        ),
      ),
    );
  });
}

/** Parallel native mapping without eagerly starting Promise shells. */
export function authMap(
  values: readonly any[],
  program: (value: any) => Effect.Effect<any, unknown>,
  settled = false,
): Effect.Effect<any, unknown> {
  return authAll(
    values.map((value) => program(value)),
    settled,
  );
}

/** The physical fetch leaf also owns cancellation of a late response body. */
export function authFetch(input: RequestInfo | URL, init?: RequestInit): Effect.Effect<Response, unknown> {
  return authValue(() =>
    fetch(input, init).then((response) => {
      if (init?.signal?.aborted) void response.body?.cancel().catch(() => {});
      return response;
    }),
  );
}
