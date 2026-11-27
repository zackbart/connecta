import { Mount } from "@effect/ui";
import type { Html } from "@effect/ui/html";
import { Effect, Queue, Schema, Stream } from "effect";
import type { CandidateHandle, CredentialBody } from "../services/controller.js";
import { OperatorController } from "../services/controller.js";

export type Verify = "test" | "skip";

export type Submission =
  | { readonly _tag: "Held"; readonly candidate: CandidateHandle }
  | { readonly _tag: "Refused"; readonly copy: string };

const SubmitArgs = { connector: Schema.String, fields: Schema.Array(Schema.String) };
type SubmitArgs = { readonly connector: string; readonly fields: ReadonlyArray<string> };

export const credentialSubmissions = (
  button: EventTarget,
  hold: (body: CredentialBody) => CandidateHandle,
  read: (id: string) => string,
  initial: SubmitArgs,
  changes: Stream.Stream<SubmitArgs>,
) =>
  Stream.callback<Submission>((queue) =>
    Effect.gen(function* () {
      let args = initial;
      yield* Stream.runForEach(changes, (next) => Effect.sync(() => (args = next))).pipe(Effect.forkScoped);
      const submit = (): Submission => {
        const { connector, fields } = args;
        if (!fields.length) {
          const value = read(`credential-input-${connector}`).trim();
          return value
            ? { _tag: "Held", candidate: hold({ value }) }
            : { _tag: "Refused", copy: "Paste a credential before saving." };
        }
        const values: Record<string, string> = {};
        for (const [index, name] of fields.entries()) {
          const value = read(`credential-input-${connector}-${index}`).trim();
          if (!value) return { _tag: "Refused", copy: "Fill every field before saving." };
          values[name] = value;
        }
        return { _tag: "Held", candidate: hold({ values }) };
      };
      const onClick = () => void Queue.offerUnsafe(queue, submit());
      yield* Effect.acquireRelease(
        Effect.sync(() => button.addEventListener("click", onClick)),
        () => Effect.sync(() => button.removeEventListener("click", onClick)),
      );
    }),
  );

export const readField = (id: string) => {
  const field = document.getElementById(id);
  return field instanceof HTMLInputElement ? field.value : "";
};

export const SubmitCredential = Mount.makeStream(
  "SubmitCredential",
  { args: SubmitArgs },
  (button: HTMLElement, initial, changes) =>
    Stream.unwrap(
      OperatorController.useSync((controller) =>
        credentialSubmissions(button, controller.holdCredentialCandidate, readField, initial, changes),
      ),
    ),
);

export interface CredentialFormSlot {
  readonly label: string;
  readonly placeholder?: string | undefined;
  readonly testable?: boolean | undefined;
  readonly fields?:
    | ReadonlyArray<{
        readonly name: string;
        readonly label: string;
        readonly description?: string | undefined;
        readonly placeholder?: string | undefined;
        readonly inputType?: "email" | "password" | "text" | undefined;
      }>
    | undefined;
}

export const CredentialForm = <M>(
  h: Html.H<M>,
  options: {
    readonly connector: string;
    readonly credential: CredentialFormSlot;
    readonly busy: boolean;
    readonly untested: boolean;
    readonly held: (candidate: CandidateHandle, verify: Verify) => M;
    readonly refused: (copy: string) => M;
    readonly cancel: M;
  },
) => {
  const { connector, credential, busy } = options;
  const testable = credential.testable === true;
  const fields = credential.fields ?? [];
  const names = fields.map((field) => field.name);
  const inputId = `credential-input-${connector}`;
  const submitted = (verify: Verify) =>
    SubmitCredential({ connector, fields: names }).pipe(
      Mount.map((submission) =>
        submission._tag === "Held" ? options.held(submission.candidate, verify) : options.refused(submission.copy),
      ),
    );
  return h.div
    .key("credential-form")
    .class("credential-form")
    .attr("data-credential-form", connector)
    .children(
      fields.length === 0
        ? [
            h.label.key("label").class("visually-hidden").attr("for", inputId).children(credential.label),
            h.input
              .key("input")
              .attr("id", inputId)
              .attr("type", "password")
              .attr("aria-label", credential.label)
              .attr("placeholder", credential.placeholder || "Paste credential")
              .attr("autocomplete", "new-password")
              .attr("autocapitalize", "none")
              .attr("spellcheck", "false"),
          ]
        : h.div
            .key("fields")
            .class("credential-fields")
            .children(
              fields.map((field, index) => {
                const id = `${inputId}-${index}`;
                const kind = field.inputType ?? "password";
                return h.div
                  .key(field.name)
                  .class("credential-field")
                  .children(
                    h.label.attr("for", id).children(field.label),
                    field.description
                      ? h.p.class("meta").attr("id", `${id}-description`).children(field.description)
                      : null,
                    h.input
                      .attr("id", id)
                      .attr("aria-describedby", field.description ? `${id}-description` : undefined)
                      .attr("type", field.inputType || "password")
                      .attr("placeholder", field.placeholder || field.label)
                      .attr("autocomplete", kind === "password" ? "new-password" : "off")
                      .attr("autocapitalize", "none")
                      .attr("spellcheck", "false"),
                  );
              }),
            ),
      h.div
        .key("actions")
        .class("actions")
        .children(
          h.button
            .key("save")
            .class("btn", "primary")
            .attr("type", "button")
            .disabled(busy)
            .onMount(submitted(testable ? "test" : "skip"))
            .children(busy ? (testable ? "Testing…" : "Saving…") : testable ? "Test and save" : "Save"),
          testable && options.untested
            ? h.button
                .key("untested")
                .class("btn")
                .attr("type", "button")
                .attr("data-save-untested", connector)
                .disabled(busy)
                .onMount(submitted("skip"))
                .children("Save without testing")
            : null,
          h.button
            .key("cancel")
            .class("btn", "quiet")
            .attr("type", "button")
            .disabled(busy)
            .on("click", options.cancel)
            .children("Cancel"),
        ),
    );
};
