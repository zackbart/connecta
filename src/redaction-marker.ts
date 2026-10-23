// The placeholder redaction leaves where it removed a value. Sent-secret redaction (sent-secrets.ts)
// and REST value safety (providers/_shared/rest/value-safety.ts) write the same text.

/** What a removed value reads as. */
export const REDACTED = "[redacted]";

/**
 * Whether redaction altered a value: it carries the placeholder. The provider kit redacts sent
 * secrets from every value of a vendor body before result safety reads it, so a rule that decides
 * on a value (a type discriminator, a record's label or type, a URL's scheme or parameter names,
 * a header line's name, a Content-Type) can find the placeholder where the vendor wrote what the
 * rule matches.
 * Such a decision takes its most protective outcome (#703).
 */
export function redactionAltered(value: unknown): boolean {
  return typeof value === "string" && value.includes(REDACTED);
}

/** A character of a credential's public prefix or secret segments: `sk_live_`, `whsec_`, hex, base64, JWT. */
const CREDENTIAL_CHARACTER = /[A-Za-z0-9_.~+/=-]/;

/**
 * The fewest characters a credential's secret remainder holds: K, the run length sent-secret
 * redaction matches, below which it does not treat a value as a credential either.
 */
const REMAINDER = 8;

/**
 * Where the rest of a credential that redaction may have split ends (#703). Redaction can take a
 * credential's public prefix (`sk_live_`, `whsec_`, `Bearer `, a signing parameter's name and `=`)
 * and leave its secret remainder, so the placeholder at `at` stands for any prefix a credential
 * pattern needs. Returns the end of the credential characters right after it when at least
 * `REMAINDER` of them, one a letter or digit, could be the rest of one; otherwise `at`.
 */
export function splitRemainder(text: string, at: number): number {
  if (!redactionAltered(text.slice(at, at + REDACTED.length))) return at;
  let end = at + REDACTED.length;
  let count = 0;
  let readable = false;
  while (end < text.length) {
    if (text.startsWith(REDACTED, end)) end += REDACTED.length;
    else if (CREDENTIAL_CHARACTER.test(text[end]!)) {
      readable ||= /[A-Za-z0-9]/.test(text[end]!);
      count++;
      end++;
    } else break;
  }
  return readable && count >= REMAINDER ? end : at;
}
