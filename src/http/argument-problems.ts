// Internal provider kit (decision 0011 S5). Unreachable from src/index.ts.
//
// A provider's own argument checks record every problem before refusing, so
// one invalid_args carries every fix and one corrected example call, and an
// agent repairs the call in one turn instead of one constraint per turn.
import { ConnectorCallError, issueSummary, boundedEchoText, type ArgumentValidationIssue } from "../errors.js";
import type { JsonSchema } from "../types.js";
import { exampleWith, type ArgumentFix } from "../validate.js";

export type { ArgumentFix };

/** Every argument problem one call has, then a single refusal. */
export class ArgumentProblems {
  readonly #found: { issue: ArgumentValidationIssue; fix: ArgumentFix | undefined }[] = [];

  /**
   * Record one problem at a JSON Pointer into the arguments. `expected` states
   * the allowed shape or bound; `received` is a JSON type or a non-secret
   * number, never a submitted string. `fix` is what the example call uses at
   * `path`: a value derived without guessing, a clearly placeholder value such
   * as `"<owner>/<repo>"`, or `"omit"`. A problem without a fix withholds the
   * example.
   */
  add(path: string, expected: string, options: { readonly received?: string; readonly fix?: ArgumentFix } = {}): void {
    this.#found.push({
      issue: { path, expected, ...(options.received === undefined ? {} : { received: options.received }) },
      fix: options.fix,
    });
  }

  /**
   * The one refusal for every recorded problem, or undefined when there is
   * none. `withheld` states why no example is offered, for a tool whose schema
   * cannot prove its arguments safe to echo; without a schema or a reason, the
   * invocation that owns the schema builds the example.
   */
  refusal(
    lead: string,
    args: unknown,
    schema: JsonSchema | undefined,
    withheld?: string,
  ): ConnectorCallError | undefined {
    if (!this.#found.length) return undefined;
    const issues = this.#found.map(({ issue }) => issue);
    const example =
      schema && !withheld
        ? exampleWith(
            schema,
            args,
            this.#found.map(({ issue, fix }) => [issue.path, fix]),
          )
        : undefined;
    const unavailable =
      withheld || schema
        ? { exampleUnavailable: withheld ?? "No corrected call could be built without guessing a value." }
        : {};
    return new ConnectorCallError("invalid_args", `${lead}: ${boundedEchoText(issueSummary(issues), 512)}`, {
      validation: { issues, ...(example ?? unavailable) },
    });
  }
}
