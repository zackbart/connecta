// The placeholder redaction leaves where it removed a value. Sent-secret redaction (sent-secrets.ts)
// and REST value safety (providers/_shared/rest/value-safety.ts) write the same text.

/** What a removed value reads as. */
export const REDACTED = "[redacted]";

/**
 * Whether redaction altered a value: it carries the placeholder. The provider kit redacts sent
 * secrets from every value of a vendor body before result safety reads it, so a rule that decides
 * on a value (a type discriminator, a record's label or type, a URL's scheme or parameter names,
 * a Content-Type) can find the placeholder where the vendor wrote what the rule matches.
 * Such a decision takes its most protective outcome (#703).
 */
export function redactionAltered(value: unknown): boolean {
  return typeof value === "string" && value.includes(REDACTED);
}

/**
 * A credential's data: the base64 and base64url alphabets (letters, digits, `+`, `/`, `=`, `-`,
 * `_`) and `%` escapes. A remainder of `+/` alone is still the end of a base64 value.
 */
function credentialUnit(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    code === 0x2b ||
    code === 0x2f ||
    code === 0x3d ||
    code === 0x2d ||
    code === 0x5f ||
    code === 0x25
  );
}

/**
 * The text right after the placeholder at `at` that may be the rest of a credential whose public
 * prefix redaction took (#703): up to the first unit `ends` accepts, reading later placeholders
 * whole so none is split. Redaction can take `sk_live_`, `whsec_`, `Bearer `, or a signing
 * parameter's name and `=`, leaving what follows; with that prefix known, any remainder rebuilds
 * the credential, however short or encoded, so `readable` holds whenever it carries any base64 or
 * base64url character or a `%` escape. Other punctuation alone (`.`, `,`, `;`, `!`) is no
 * credential's data. The run still ends where `ends` says a value does. One forward pass.
 */
export function splitRemainder(
  text: string,
  at: number,
  ends: (text: string, index: number) => boolean,
): { end: number; readable: boolean } {
  if (!redactionAltered(text.slice(at, at + REDACTED.length))) return { end: at, readable: false };
  let end = at + REDACTED.length;
  let readable = false;
  while (end < text.length) {
    if (text.startsWith(REDACTED, end)) end += REDACTED.length;
    else if (ends(text, end)) break;
    else {
      readable ||= credentialUnit(text.charCodeAt(end));
      end++;
    }
  }
  return { end, readable };
}
