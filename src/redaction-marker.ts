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

// Numeric references may omit `;`; named HTML references have at most 31 characters. Require
// their `;` so a real query separator such as `&amp=value` remains a separator. Legacy `amp`
// may omit its semicolon only before the `#` of a nested numeric reference.
const CHARACTER_REFERENCE = /(?:#([0-9]+);?|#x([0-9a-f]+);?|([a-z][a-z0-9]{1,30});|(amp)(?=#))/iy;
// Named references whose decoded characters all belong to a credential's alphabet (`fjlig` is `fj`).
const CREDENTIAL_REFERENCE = /^(?:plus|sol|equals|percnt|lowbar|underbar|fjlig)$/;

/**
 * The end of a character reference at `at`, or `at` itself. A reference is value data, including
 * one spelling a delimiter. Decode only to find nested-reference boundaries and, when
 * `credentialOnly`, to require credential data or an ampersand. No decoded text is returned.
 * Known signing values read possible named references fail-closed without a browser entity table.
 * Each successful read advances over disjoint source characters.
 */
export function characterReferenceEnd(text: string, at: number, credentialOnly = false): number {
  if (text.charCodeAt(at) !== 0x26) return at;
  return referenceBodyEnd(text, at + 1, at, credentialOnly);
}

/** A numeric reference body whose leading characters redaction may have taken, including its `&`. */
export function bareReferenceEnd(text: string, at: number, credentialOnly = false): number {
  if (text.charCodeAt(at) !== 0x23 || !/[0-9x]/i.test(text[at + 1] ?? "")) return at;
  return referenceBodyEnd(text, at, at, credentialOnly);
}

function referenceBodyEnd(text: string, from: number, at: number, credentialOnly: boolean): number {
  let end = at;
  let readable = false;
  while (from < text.length) {
    CHARACTER_REFERENCE.lastIndex = from;
    const reference = CHARACTER_REFERENCE.exec(text);
    if (!reference) break;
    end = CHARACTER_REFERENCE.lastIndex;
    const name = (reference[3] ?? reference[4])?.toLowerCase();
    const code =
      reference[1] !== undefined
        ? Number(reference[1])
        : reference[2] !== undefined
          ? Number.parseInt(reference[2], 16)
          : name === "amp"
            ? 0x26
            : -1;
    const ampersand = code === 0x26;
    readable = ampersand || credentialUnit(code) || (name !== undefined && CREDENTIAL_REFERENCE.test(name));
    if (!readable && name === undefined && text.charCodeAt(end - 1) !== 0x3b)
      readable = prefixSpellsCredential(reference[1] ?? reference[2]!, reference[1] === undefined ? 16 : 10);
    if (!ampersand) break;
    from = end;
  }
  return credentialOnly && !readable ? at : end;
}

// Without its `;`, a numeric reference's digits may run into the value's next characters (`&#47`
// then `9` reads as `&#479`), so a short digit prefix spelling credential data counts.
function prefixSpellsCredential(digits: string, radix: number): boolean {
  let at = 0;
  while (digits.charCodeAt(at) === 0x30) at++;
  const limit = radix === 16 ? 2 : 3;
  for (let length = 1; length <= limit && at + length <= digits.length; length++)
    if (credentialUnit(Number.parseInt(digits.slice(at, at + length), radix))) return true;
  return false;
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
 * base64url character, a `%` escape or a reference spelling credential data or an ampersand.
 * Other references end the inferred remainder. Other punctuation alone (`.`, `,`, `;`, `!`) is no
 * credential's data. References, including bare numeric bodies, are read before consulting `ends`.
 * The run still ends where `ends` says a value does. One forward pass.
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
    const reference = Math.max(characterReferenceEnd(text, end, true), bareReferenceEnd(text, end, true));
    if (text.startsWith(REDACTED, end)) end += REDACTED.length;
    else if (reference > end) {
      readable = true;
      end = reference;
    } else if (ends(text, end)) break;
    else {
      readable ||= credentialUnit(text.charCodeAt(end));
      end++;
    }
  }
  return { end, readable };
}
