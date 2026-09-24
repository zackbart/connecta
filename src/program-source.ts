// Program source handling shared by every executor. Web-API only: execute_code
// runs it before handing a program to QuickJS or a Dynamic Worker, and the
// QuickJS normalizer runs it too for callers that drive that executor directly.

/** A whole-program markdown fence, as QuickJS's normalizer recognizes one. */
const FENCE = /^```[\w-]*\s*\n([\s\S]*?)\n?```$/;

/** Leading whitespace and comments, which may precede the arrow expression. */
const LEADING_TRIVIA = /^(?:\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/)+/;

/** One character of an identifier, keyword, or number; `\\` for escapes. */
const WORD = /[\w$\\\u0080-\uffff]/;

/**
 * Words after which a `/` begins a regular expression rather than dividing.
 * Any other word is an identifier or a literal, which a `/` divides.
 */
const REGEX_AFTER_WORD = new Set([
  "await", "case", "delete", "do", "else", "in", "instanceof", "new", "of",
  "return", "throw", "typeof", "void", "yield",
]);

/**
 * Remove the statement terminators after a program's arrow expression:
 * `async () => { … };`, with any whitespace or comments around the trailing
 * semicolons, becomes `async () => { … }` with those comments kept. Both
 * executors evaluate a program as a parenthesized expression, where a
 * terminator is a syntax error on QuickJS and, on a Dynamic Worker, either the
 * same error or a program that silently returns `undefined`. Models often end
 * a program with `};`, so P1 accepts it on both.
 *
 * Deliberately narrow, so it cannot broaden what a program is: only a program
 * whose first token is `async` or `(` — what QuickJS treats as a function
 * expression — and only when every semicolon at bracket depth zero trails it,
 * with nothing but whitespace and comments after. `async () => 1; 2();` keeps
 * both its semicolons, and a bare statement body is never touched, since its
 * trailing `;` can be an empty loop body. A whole-program markdown fence is
 * looked through, and dropped when a terminator came out from under it.
 *
 * A small lexer, not a parser: it skips strings, template literals (with
 * `${}` nesting), comments, and regular expressions, telling a regex from a
 * division by the token before it. Any source it cannot close — an
 * unterminated string or comment, unbalanced brackets — comes back unchanged,
 * so the executor reports the same error it always did.
 */
export function withoutProgramTerminator(code: string): string {
  const fenced = FENCE.exec(code.trim())?.[1];
  const source = fenced === undefined ? code : fenced.trim();
  const stripped = stripTerminators(source);
  return stripped === source ? code : stripped;
}

function stripTerminators(source: string): string {
  const head = source.replace(LEADING_TRIVIA, "");
  if (!/^async\b/.test(head) && !head.startsWith("(")) return source;
  const n = source.length;
  let depth = 0;
  /** Bracket depth at which each open template substitution resumes its template. */
  const substitutions: number[] = [];
  /** Positions of the top-level semicolons, all of which must trail. */
  const terminators: number[] = [];
  /**
   * The previous significant token: a punctuator character or a word, with a
   * string, template, or regex literal recorded as `0` — a value, like a number.
   */
  let previous = "";
  let i = 0;

  /** Scan template text from `from` to its closing backtick or next `${`. */
  const template = (from: number): number | undefined => {
    for (let j = from; j < n; j++) {
      const c = source[j];
      if (c === "\\") {
        j++;
      } else if (c === "`") {
        return j + 1;
      } else if (c === "$" && source[j + 1] === "{") {
        substitutions.push(depth);
        depth++;
        return j + 2;
      }
    }
    return undefined;
  };

  while (i < n) {
    const c = source[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i);
      i = end === -1 ? n : end;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      if (end === -1) return source;
      i = end + 2;
      continue;
    }
    if (c === ";") {
      if (depth === 0) terminators.push(i);
      previous = ";";
      i++;
      continue;
    }
    // Code after a top-level semicolon means the program is more than one
    // expression; that is for the executor to refuse, not for us to repair.
    if (terminators.length > 0) return source;
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && source[j] !== c) {
        if (source[j] === "\n") return source;
        j += source[j] === "\\" ? 2 : 1;
      }
      if (j >= n) return source;
      i = j + 1;
      previous = "0";
      continue;
    }
    if (c === "`") {
      const end = template(i + 1);
      if (end === undefined) return source;
      i = end;
      previous = source[end - 1] === "`" ? "0" : "{";
      continue;
    }
    if (c === "}" && substitutions.at(-1) === depth - 1) {
      substitutions.pop();
      depth--;
      const end = template(i + 1);
      if (end === undefined) return source;
      i = end;
      previous = source[end - 1] === "`" ? "0" : "{";
      continue;
    }
    if (c === "/" && startsRegex(previous)) {
      let j = i + 1;
      let inClass = false;
      for (; j < n; j++) {
        const r = source[j];
        if (r === "\n") return source;
        if (r === "\\") j++;
        else if (r === "[") inClass = true;
        else if (r === "]") inClass = false;
        else if (r === "/" && !inClass) break;
      }
      if (j >= n) return source;
      i = j + 1;
      while (i < n && /[\w$]/.test(source[i]!)) i++;
      previous = "0";
      continue;
    }
    if (WORD.test(c)) {
      let j = i + 1;
      while (j < n && WORD.test(source[j]!)) j++;
      previous = source.slice(i, j);
      i = j;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) return source;
      depth--;
    }
    previous = c;
    i++;
  }
  if (depth !== 0 || substitutions.length > 0 || terminators.length === 0) {
    return source;
  }
  let out = "";
  let from = 0;
  for (const at of terminators) {
    out += source.slice(from, at);
    from = at + 1;
  }
  return out + source.slice(from);
}

/** Whether a `/` after `previous` opens a regular expression. */
function startsRegex(previous: string): boolean {
  if (previous === "") return true;
  if (WORD.test(previous[0]!)) {
    // A number or an identifier divides; a keyword introduces an operand.
    return REGEX_AFTER_WORD.has(previous);
  }
  // After a closing bracket a value precedes; after any other punctuator
  // an operand is expected.
  return previous !== ")" && previous !== "]" && previous !== "}";
}
