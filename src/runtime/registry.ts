// Private native programs for the published Promise registry. Static class
// blocks install them without adding members to its published declaration.
import { Effect } from "effect";
import type { Registry, RegistryView } from "../registry.js";

type AsyncKey<T> = { [K in keyof T]: T[K] extends (...args: any[]) => Promise<any> ? K : never }[keyof T];
type Program<T, K extends keyof T> = T[K] extends (...args: infer P) => Promise<infer A>
  ? (self: T, ...args: P) => Effect.Effect<A, unknown>
  : never;
type Programs<T> = { [K in AsyncKey<T>]?: Program<T, K> };
const programs = new WeakMap<
  object,
  Map<PropertyKey, { own: unknown; run: (...args: any[]) => Effect.Effect<any, unknown> }>
>();
export function provideRegistryPrograms<T extends RegistryView>(prototype: T, entries: Programs<T>): void {
  programs.set(
    prototype,
    new Map(
      (Object.entries(entries) as Array<[string, (...args: any[]) => Effect.Effect<any, unknown>]>).map(
        ([name, run]) => [name, { own: Reflect.get(prototype, name), run }],
      ),
    ),
  );
}
/** A Promise method runs its own implementation, even when a wrapper calls the original. */
export function registryEdgeProgram<K extends AsyncKey<Registry>>(
  prototype: Pick<Registry, K>,
  view: Pick<Registry, K>,
  key: K,
  ...args: Parameters<Registry[K]>
): Effect.Effect<Awaited<ReturnType<Registry[K]>>, unknown> {
  return Effect.suspend(() =>
    programs
      .get(prototype)!
      .get(key)!
      .run(view, ...args),
  ).pipe(Effect.catchDefect((error) => Effect.fail(error)));
}
/** Custom registry methods are real Promise leaves; registered methods compose directly. */
export function registryProgram<K extends AsyncKey<Registry>>(
  view: Pick<Registry, K>,
  key: K,
  ...args: Parameters<Registry[K]>
): Effect.Effect<Awaited<ReturnType<Registry[K]>>, unknown> {
  return Effect.suspend(() => {
    const own = view[key];
    const entry = programs.get(Object.getPrototypeOf(view))?.get(key);
    return entry?.own === own
      ? entry.run(view, ...args)
      : Effect.tryPromise({
          try: () => Reflect.apply(own as (...args: any[]) => Promise<any>, view, args),
          catch: (error) => error,
        });
  }).pipe(Effect.catchDefect((error) => Effect.fail(error)));
}
