// Internal provider kit (decision 0011 S5). Unreachable from src/index.ts.
//
// A provider's own argument checks record every problem before refusing, so
// one invalid_args carries every finding and an agent repairs the call in one
// turn instead of one constraint per turn.
import { ConnectorCallError, issueSummary, type ArgumentValidationIssue } from "../errors.js";
import type { JsonSchema } from "../types.js";
import { schemaExample } from "../validate.js";

/** Every argument problem one call has, then a single refusal. */
export class ArgumentProblems {
  readonly #issues: ArgumentValidationIssue[] = [];

  /**
   * Record one problem. A refusal holds only what the published schema
   * declares and fixed text: `path` names declared properties and indices
   * (`<key>` for any other key), `expected` states the allowed shape or bound,
   * and `received` is a JSON type. Never a submitted string or key.
   */
  add(path: string, expected: string, received?: string): void {
    this.#issues.push({ path, expected, ...(received === undefined ? {} : { received }) });
  }

  /**
   * The one refusal for every recorded problem, or undefined when there is
   * none. With the tool's schema it carries the schema's synthesized example;
   * `withheld` states why a tool offers none.
   */
  refusal(lead: string, schema: JsonSchema | undefined, withheld?: string): ConnectorCallError | undefined {
    if (!this.#issues.length) return undefined;
    return new ConnectorCallError("invalid_args", `${lead}: ${issueSummary(this.#issues)}`, {
      validation: {
        issues: this.#issues,
        ...(withheld ? { exampleUnavailable: withheld } : schema ? schemaExample(schema) : {}),
      },
    });
  }
}
