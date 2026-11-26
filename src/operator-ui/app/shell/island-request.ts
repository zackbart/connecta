import { UiSchema } from "@effect/ui";
import { Schema } from "effect";
import { CandidateHandle, Prepared } from "./commands.js";

export const IslandRequest = UiSchema.TaggedEnum({
  StartOAuth: { connector: Schema.String, mode: Schema.Literals(["continue", "restart"]), prepared: Prepared },
  DisconnectOAuth: { connector: Schema.String },
  SaveCredential: { connector: Schema.String, candidate: CandidateHandle, verify: Schema.Literals(["test", "skip"]) },
  RemoveCredential: { connector: Schema.String },
  TestCredential: { connector: Schema.String },
  RotateAgentToken: { name: Schema.String },
  ConfirmTokenAction: {},
});
export type IslandRequest = typeof IslandRequest.Type;
