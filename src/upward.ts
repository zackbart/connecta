// authFlow delivers ordinary failures to generator catch clauses. Effect's
// own iterator has no throw method, so delegate through a real generator to
// retain both the yielded value's type and the original failure identity.
import type { Effect } from "effect";

export function* upwardStep<A, E, R>(effect: Effect.Effect<A, E, R>): Generator<Effect.Effect<A, E, R>, A, any> {
  return yield effect;
}
