import { UiSchema } from "@effect/ui";
import { Context, Effect, Layer, Queue, Schema, Stream } from "effect";
import { CandidateHandle, Prepared } from "./commands.js";

export const PageWrite = UiSchema.TaggedEnum({
  StartOAuth: { connector: Schema.String, mode: Schema.Literals(["continue", "restart"]), prepared: Prepared },
  DisconnectOAuth: { connector: Schema.String },
  SaveCredential: { connector: Schema.String, candidate: CandidateHandle, verify: Schema.Literals(["test", "skip"]) },
  RemoveCredential: { connector: Schema.String },
  TestCredential: { connector: Schema.String },
});
export type PageWrite = typeof PageWrite.Type;

export class PageWrites extends Context.Service<
  PageWrites,
  { readonly offer: (request: PageWrite) => void; readonly requests: Stream.Stream<PageWrite> }
>()("connecta/operator-ui/PageWrites") {
  static readonly layer = Layer.effect(
    PageWrites,
    Effect.map(Queue.unbounded<PageWrite>(), (queue) =>
      PageWrites.of({
        offer: (request) => void Queue.offerUnsafe(queue, request),
        requests: Stream.fromQueue(queue),
      }),
    ),
  );
}

export const pageWrites = Stream.unwrap(PageWrites.useSync((writes) => writes.requests));
