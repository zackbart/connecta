import { Effect, Layer, type Context, type Fiber } from "effect";

export const launch = <E>(layer: Layer.Layer<never, E>): void => void Effect.runFork(Layer.launch(layer));

export const starterIn =
  <R>(services: Context.Context<R>) =>
  <A, E>(effect: Effect.Effect<A, E, R>): Fiber.Fiber<A, E> =>
    Effect.runForkWith(services)(effect);

export const runNow = <A>(effect: Effect.Effect<A>): A => Effect.runSync(effect);
