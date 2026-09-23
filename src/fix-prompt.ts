/**
 * The frame every copyable fix prompt shares: the operator page's failure
 * notices and the OAuth callback page both hand an operator text to paste into
 * a coding agent working in the deployment's repository.
 *
 * A prompt is assembled from fixed catalogue text and, at most, a configured
 * connector id. It has no parameter an error message, a downstream body, a
 * token, or a URL could arrive through — which is the whole guarantee: the
 * text leaves the page on a clipboard, into a tool the deployment does not
 * control, so it must be something the deployment would be content to publish.
 * The agent finds the underlying cause where it belongs, in the deployment's
 * own logs and a local reproduction.
 */

export interface FixPromptSpec {
  /** One sentence naming the failure. Fixed text, never an error message. */
  problem: string;
  /** Where the fix usually lives, most likely first. */
  steps: readonly string[];
}

const CONNECTOR_ID_RE = /^[a-z0-9_-]+$/;

/**
 * Render one prompt. A connector id is the only variable part, and only when
 * it has the shape configuration enforces; anything else is dropped rather
 * than escaped, since a value that is not a connector id is not config.
 */
export function renderFixPrompt(
  spec: FixPromptSpec,
  connectorId?: string,
): string {
  const id =
    connectorId !== undefined && CONNECTOR_ID_RE.test(connectorId)
      ? connectorId
      : undefined;
  return [
    "Diagnose and fix a problem in this connecta deployment (the @zackbart/connecta package). " +
      "It is configured as code: connectors, credential slots, OAuth clients, pools, and inbound auth " +
      "are declared in the deployment's source and environment, so the fix belongs there and not in the operator page.",
    `Problem: ${spec.problem}` + (id ? `\nConnector id: ${id}` : ""),
    `Where to look:\n${spec.steps.map((step) => `- ${step}`).join("\n")}`,
    "This prompt deliberately carries no error text, tokens, or URLs. Find the underlying cause in the deployment's " +
      "own logs (lines prefixed [connecta]) or by reproducing the failure locally. Never put a secret in source, " +
      "a log line, or your reply: secrets belong in the deployment's environment or its credential vault.",
    "Make the smallest change that fixes it, then verify it by redeploying and refreshing the connection on the " +
      "operator Connections page. If the fix needs something you cannot do yourself — a provider console setting, " +
      "a secret only the operator holds — name that exact step instead.",
  ].join("\n\n");
}
