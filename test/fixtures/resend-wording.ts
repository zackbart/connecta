// Wording that tells an agent to send a call again (#902 round 13). No
// Connecta-authored text attached to a write whose outcome is unknown may
// match it, apart from the reconcile-first and prohibiting sentences below.
export const RESEND_WORDING =
  /\b(?:retry|retrying|retried|resend|re-send|resubmit|reapply|try (?:it )?again|call (?:it )?again|send (?:it )?again|repeat(?:ing)? (?:it|this))\b/i;

/** Sentences that say not to resend, or to reconcile before anything else. */
export const RECONCILE_FIRST = [
  "This write may have partially run. Reconcile its target before retrying after the operator completes recovery.",
  "Do not retry automatically.",
  "Do not resend this write.",
  "check the target before repeating it",
  "Check the target before repeating this call.",
  "It will not be sent again.",
  "use the original arguments if reconciliation requires another call",
  "call authorize_connector again",
];

/** Every string an agent can read in `value`, with the reconcile-first sentences removed. */
export function resendWording(value: unknown): string[] {
  const found: string[] = [];
  const visit = (node: unknown): void => {
    if (typeof node === "string") {
      let text = node;
      for (const sentence of RECONCILE_FIRST) text = text.split(sentence).join("");
      if (RESEND_WORDING.test(text)) found.push(node);
    } else if (Array.isArray(node)) node.forEach(visit);
    else if (node !== null && typeof node === "object") Object.values(node).forEach(visit);
  };
  // A tool result's text block is the same object serialized, keys included.
  const structured = value !== null && typeof value === "object" && "structuredContent" in value;
  visit(
    value instanceof Error ? { message: value.message } : structured ? value.structuredContent : value,
  );
  return found;
}
