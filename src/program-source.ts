// Program source handling shared by every executor. Web-API only: execute_code
// runs it before handing a program to QuickJS or a Dynamic Worker, and the
// QuickJS normalizer runs it too for callers that drive that executor directly.

/** A whole-program markdown fence, as QuickJS's normalizer recognizes one. */
const FENCE = /^```[\w-]*\s*\n([\s\S]*?)\n?```$/;

/** Intake accepts one JavaScript fence, optionally surrounded by prose. */
const PROGRAM_FENCE = /^```(?:js|javascript)?[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/gm;

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

/**
 * Recover wrappers that models put around a single program. This runs in the
 * host, so QuickJS and Dynamic Workers receive the same source. It does not
 * turn arbitrary statements into a program: an arrow remains the contract.
 */
export function normalizeProgramSource(code: string): string {
  let source = code.trim();
  const head = source.replace(LEADING_TRIVIA, "");
  // A program may itself contain fenced Markdown in a comment or string. Once
  // the source starts as a program, a fence inside it is data, never a wrapper.
  if (!/^(?:async\b|\(|export\s+default\s+async\b)/.test(head)) {
    const fences = [...source.matchAll(PROGRAM_FENCE)];
    if (fences.length === 1) {
      const fence = fences[0]!;
      const outside = source.slice(0, fence.index) + source.slice(fence.index! + fence[0].length);
      const body = fence[1]!.trim();
      const fencedHead = body.replace(LEADING_TRIVIA, "");
      if (!outside.includes("```") && /^(?:async\b|\(|export\s+default\s+async\b)/.test(fencedHead)) {
        source = body;
      }
    }
  }

  source = source.replace(/^export\s+default\s+(?=async\s*(?:\(|[A-Za-z_$]))/, "");

  // The declaration must be the whole source. A scanner finds its own closing
  // brace rather than mistaking a brace in a string or a second statement for
  // the end of the function.
  const named = /^async\s+function\s+([A-Za-z_$][\w$]*)\s*\(([^()]*)\)\s*\{/.exec(source);
  if (named) {
    const end = functionBodyEnd(source, named[0].length - 1);
    if (end !== undefined && /^(?:\s|;|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*$/.test(source.slice(end + 1))) {
      // Invoke a named function expression inside the arrow. Its own name and
      // `arguments` binding then work exactly as in the original declaration.
      source = `async (...args) => (async function ${named[1]}(${named[2]}) {${source.slice(named[0].length, end)}})(...args)${source.slice(end + 1)}`;
    }
  }

  return withoutProgramTerminator(source);
}

/** Find the matching closing brace of a named function's body. */
function functionBodyEnd(source: string, open: number): number | undefined {
  let depth = 0;
  let previous = "";
  for (let i = open; i < source.length; i++) {
    const c = source[i]!;
    if (/\s/.test(c)) continue;
    if (c === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i + 2);
      i = end === -1 ? source.length : end;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      if (end === -1) return undefined;
      i = end + 1;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      let end = i + 1;
      for (; end < source.length && source[end] !== c; end++) {
        if (source[end] === "\\") end++;
        else if (source[end] === "\n" && c !== "`") return undefined;
      }
      if (end >= source.length) return undefined;
      i = end;
      previous = "0";
      continue;
    }
    if (c === "/" && startsRegex(previous)) {
      let end = i + 1;
      let inClass = false;
      for (; end < source.length; end++) {
        const r = source[end];
        if (r === "\n") return undefined;
        if (r === "\\") end++;
        else if (r === "[") inClass = true;
        else if (r === "]") inClass = false;
        else if (r === "/" && !inClass) break;
      }
      if (end >= source.length) return undefined;
      i = end;
      previous = "0";
      continue;
    }
    if (WORD.test(c)) {
      let end = i + 1;
      while (end < source.length && WORD.test(source[end]!)) end++;
      previous = source.slice(i, end);
      i = end - 1;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
      if (depth < 0) return undefined;
    }
    previous = c;
  }
  return undefined;
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
