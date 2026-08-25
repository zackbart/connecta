// Markdown link extraction, shared by the two gates that read links: the
// repository checker (`check:docs`, scripts/check-doc-links.mjs) and the
// packed-tarball mode (check-doc-links --packed). One parser means one
// answer to "is this a link" — fenced examples are not, reference definitions
// are, and an escaped parenthesis inside a target belongs to the target.

/**
 * Lines outside fenced code blocks, numbered from 1. A fenced example is
 * illustration, not a pointer, so no gate should follow what it contains.
 */
export function activeLines(source) {
  const lines = source.split(/\r?\n/);
  const active = [];
  let fence;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
    if (marker) {
      if (!fence) {
        fence = { character: marker[1][0], length: marker[1].length };
      } else if (
        marker[1][0] === fence.character &&
        marker[1].length >= fence.length &&
        marker[2].trim() === ""
      ) {
        fence = undefined;
      }
      continue;
    }
    if (!fence) active.push({ number: index + 1, text: line });
  }
  return active;
}

function markdownTargets(line) {
  const targets = [];
  const definition = line.match(
    /^\s{0,3}\[[^\]]+\]:\s*(?:<([^>]+)>|(\S+))/,
  );
  if (definition) {
    targets.push(definition[1] ?? definition[2]);
  }

  let cursor = 0;
  while (cursor < line.length) {
    const open = line.indexOf("](", cursor);
    if (open < 0) break;
    let index = open + 2;
    while (/\s/.test(line[index] ?? "")) index += 1;
    if (line[index] === "<") {
      const close = line.indexOf(">", index + 1);
      if (close >= 0) {
        targets.push(line.slice(index + 1, close));
        cursor = close + 1;
        continue;
      }
    }

    const start = index;
    let depth = 0;
    let escaped = false;
    while (index < line.length) {
      const character = line[index];
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === "(") {
        depth += 1;
      } else if (character === ")") {
        if (depth === 0) break;
        depth -= 1;
      } else if (/\s/.test(character) && depth === 0) {
        break;
      }
      index += 1;
    }
    if (index > start) targets.push(line.slice(start, index));
    cursor = Math.max(index + 1, open + 2);
  }
  return targets;
}

/** Every link target in the document, with the line that carries it. */
export function markdownLinks(source) {
  return activeLines(source).flatMap(({ number, text }) =>
    markdownTargets(text).map((target) => ({ line: number, target })),
  );
}

/** A target as authored, with Markdown's escapes resolved. */
export function unescapeTarget(target) {
  return target.replace(/\\([\\()])/g, "$1");
}
