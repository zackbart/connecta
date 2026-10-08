// Inverse RFC 6570 expansion for advertised resource templates. Captures stay
// inside the template's URI structure, including under reserved expansion.
const atom = "(?:[A-Za-z0-9_.~!$'()*+@-]|%[0-9A-Fa-f]{2})";
const variable = "(?:[A-Za-z0-9_]|%[0-9A-Fa-f]{2})+(?:\\.(?:[A-Za-z0-9_]|%[0-9A-Fa-f]{2})+)*";
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

interface Capture { name: string; separator?: string | undefined; prefix?: number | undefined }

export function resourceUriMatchesTemplate(uri: string, template: string): boolean {
  if (uri.length > 8192 || template.length > 8192) return false;
  // The scheme and authority are fixed by the advertised template. Variables
  // cannot supply a scheme, credentials, host, port, or a network-path prefix.
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:/.exec(template)?.[0];
  if (!scheme || !uri.startsWith(scheme)) return false;
  const afterScheme = template.slice(scheme.length);
  if (afterScheme.startsWith("//")) {
    const rest = afterScheme.slice(2);
    const end = rest.search(/[/?#]|\{[/?#]/);
    if (/[{}]/.test(end < 0 ? rest : rest.slice(0, end))) return false;
  }
  const captures: Capture[] = [];
  let pattern = "^"; let offset = 0; let expressions = 0;
  let ambiguous = false;
  const capture = (name: string, separator?: string, prefix?: number, reserved = false) => {
    captures.push({ name, separator: prefix === undefined ? separator : undefined, prefix });
    if (prefix !== undefined) separator = undefined;
    const value = `${separator === "." ? "(?:[A-Za-z0-9_~-]|%[0-9A-Fa-f]{2})" : reserved ? atom : "(?:[A-Za-z0-9_.~-]|%[0-9A-Fa-f]{2})"}*`;
    return `(${separator ? `${value}(?:${escape(separator)}${value})*` : value})`;
  };
  for (const match of template.matchAll(/\{([^{}]+)\}/g)) {
    const literal = template.slice(offset, match.index);
    if (/[{}]/.test(literal) || ++expressions > 16) return false;
    // Repeated ambiguous captures can make inverse matching exponential. A
    // structural delimiter between expressions gives a bounded match; one
    // expression with a literal suffix remains supported.
    if (ambiguous && !/[/:?#&;=,]/.test(literal) && !/^[/?#&;]/.test(match[1]!)) return false;
    pattern += escape(literal);
    const expression = match[1]!;
    const operator = /^[+#./;?&]/.test(expression) ? expression[0]! : "";
    const specs = expression.slice(operator.length).split(",");
    if (specs.length > 16) return false;
    const variables = specs.map(spec => {
      const parsed = new RegExp(`^(${variable})(\\*|:[1-9][0-9]{0,3})?$`).exec(spec);
      if (!parsed) return undefined;
      return { name: parsed[1]!, explode: parsed[2] === "*", prefix: parsed[2]?.startsWith(":") ? Number(parsed[2].slice(1)) : undefined };
    });
    if (variables.some(value => !value) || new Set(variables.map(value => value!.name)).size !== variables.length) return false;
    if (variables.length > 1 && variables.some(value => value!.explode)) return false;
    if (operator === "?" || operator === "&") {
      // Each alternative chooses the first defined variable. Following
      // variables remain optional and retain their declared order.
      const alternatives = variables.map((value, i) => {
        const first = `${escape(value!.name)}=${capture(value!.name, value!.explode ? "," : undefined, value!.prefix)}`;
        return first + variables.slice(i + 1).map(next => `(?:&${escape(next!.name)}=${capture(next!.name, next!.explode ? "," : undefined, next!.prefix)})?`).join("");
      });
      pattern += `(?:${escape(operator)}(?:${alternatives.join("|")}))?`;
    } else if (operator === ";") {
      pattern += variables.map(value => `(?:;${escape(value!.name)}(?:=${capture(value!.name, value!.explode ? "," : undefined, value!.prefix)})?)?`).join("");
    } else {
      const prefix = operator === "+" ? "" : operator;
      const separator = operator === "/" || operator === "." ? operator : ",";
      const parts = variables.map(value => capture(value!.name, value!.explode ? operator === "/" ? undefined : separator : variables.length === 1 ? "," : undefined, value!.prefix, operator === "+" || operator === "#"));
      pattern += `(?:${escape(prefix)}${parts[0]}` + parts.slice(1).map(part => `(?:${escape(separator)}${part})?`).join("") + ")?";
    }
    ambiguous = operator !== "?" && operator !== "&" && operator !== ";";
    offset = match.index + match[0].length;
  }
  const tail = template.slice(offset);
  if (/[{}]/.test(tail)) return false;
  pattern += escape(tail) + "$";
  const matched = new RegExp(pattern).exec(uri);
  if (!matched) return false;
  const values = new Map<string, Array<{ parts: string[]; prefix: number | undefined }>>();
  for (const [i, capture] of captures.entries()) {
    const raw = matched[i + 1];
    if (raw === undefined) continue;
    if (raw.includes("..")) return false;
    const parts = (capture.separator ? raw.split(capture.separator) : [raw]).map(value => safeValue(value, capture.prefix));
    if (parts.some(part => part === undefined)) return false;
    const prior = values.get(capture.name) ?? [];
    prior.push({ parts: parts as string[], prefix: capture.prefix });
    values.set(capture.name, prior);
  }
  // Repeated variable names denote the same value. Prefix modifiers must
  // agree with that value, rather than creating independent wildcards.
  return [...values.values()].every(occurrences => {
    const candidate = occurrences.find(value => value.prefix === undefined || Array.from(value.parts[0]!).length < value.prefix)
      ?? occurrences.reduce((a, b) => a.parts[0]!.length >= b.parts[0]!.length ? a : b);
    return occurrences.every(value => value.prefix === undefined
      ? JSON.stringify(value.parts) === JSON.stringify(candidate.parts)
      : value.parts.length === 1 && value.parts[0] === Array.from(candidate.parts[0]!).slice(0, value.prefix).join(""));
  });
}

function safeValue(raw: string, prefix?: number): string | undefined {
  let expanded: string;
  try { expanded = decodeURIComponent(raw); } catch { return undefined; }
  let value = expanded;
  // Reject encoded and multiply-encoded traversal, separators and URI syntax.
  // Residual encoding after the bound is refused rather than guessed at.
  for (let depth = 0; depth < 8; depth++) {
    if (/[\\/:?#&;=]/.test(value) || value === "." || value.includes("..") ||
        Array.from(value).some(character => { const code = character.charCodeAt(0); return code < 32 || (code >= 127 && code <= 159); })) return undefined;
    if (!value.includes("%")) return prefix === undefined || Array.from(expanded).length <= prefix ? expanded : undefined;
    try { value = decodeURIComponent(value); } catch { return undefined; }
  }
  return undefined;
}
