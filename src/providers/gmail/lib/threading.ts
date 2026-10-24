import { ConnectorCallError } from "../../../errors.js";

/** RFC 5322 sections 3.6.4/4.5.4, with H8's stricter ASCII/control boundary. */
export function threadingIds(value: string | undefined, legacyPhrases = false): string[] {
  if (value === undefined) return [];
  const fail = (): never => {
    throw new ConnectorCallError(
      "invalid_args",
      "The copied Message-ID, In-Reply-To or References header is malformed or withheld. No draft was changed; repair its threading in Gmail.",
    );
  };
  // Unfold before parsing; a bare CR/LF, control, non-ASCII or withheld lane
  // must never become a different, apparently usable threading token.
  const source = value.replace(/\r\n(?=[ \t])/g, "");
  if (value.length > 32768 || !/^[\x20-\x7e\t]*$/.test(source) || source.includes("[redacted]")) fail();
  let at = 0;
  const atom = () => {
    const start = at;
    while (at < source.length && /[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]/.test(source[at]!)) at++;
    if (at === start) fail();
  };
  const quoted = (close: string) => {
    at++;
    while (at < source.length) {
      const character = source[at++]!;
      if (character === close) return;
      if (character === "\\") {
        if (at === source.length) fail();
        at++;
      } else if (close === "]" && character === "[") fail();
    }
    fail();
  };
  const cfws = () => {
    while (at < source.length) {
      if (source[at] === " " || source[at] === "\t") at++;
      else if (source[at] === "(") {
        let depth = 1;
        at++;
        while (depth && at < source.length) {
          const character = source[at++]!;
          if (character === "\\") {
            if (at === source.length) fail();
            at++;
          } else if (character === "(") depth++;
          else if (character === ")") depth--;
        }
        if (depth) fail();
      } else return;
    }
  };
  const word = () => {
    if (source[at] === '"') quoted('"');
    else atom();
  };
  const side = (left: boolean) => {
    cfws();
    if (!left && source[at] === "[") quoted("]");
    else {
      if (left) word();
      else atom();
      cfws();
      while (source[at] === ".") {
        at++;
        cfws();
        if (left) word();
        else atom();
        cfws();
      }
    }
    cfws();
  };
  const ids: string[] = [];
  while (at < source.length) {
    cfws();
    if (at === source.length) break;
    if (source[at] === "<") {
      const start = at++;
      side(true);
      if (source[at++] !== "@") fail();
      side(false);
      if (source[at++] !== ">") fail();
      const id = source.slice(start, at);
      if (id.length > 998) fail();
      ids.push(id);
    } else if (legacyPhrases && (source[at] === "," || source[at] === ".")) at++;
    else if (legacyPhrases) word();
    else fail();
  }
  if (!legacyPhrases && ids.length !== 1) fail();
  return ids;
}
