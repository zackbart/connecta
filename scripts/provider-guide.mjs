// The maintained guide of decision 0011 (G): `SKILL.md`'s body with its
// `<!-- when: <key> -->` … `<!-- end -->` blocks, followed by a
// `## Conventions` section rendered from the provider's declarations.
// `providers:generate` writes both into `skill.generated.ts`, and
// `ProviderContext.usageGuide` selects each connection's blocks. Providers in
// PENDING.step2 keep their fragment guides (`parseSkill`) until their step 2.

const MARKER = /^<!--\s*(?:when:\s*([a-z][a-z0-9:-]*)|end)\s*-->$/;
const HATCH_NAME = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const VERDICTS = new Set(["read", "write", "destructive", "refuse"]);

function fail(name, message) {
  throw new Error(`providers/${name}: ${message}`);
}

/**
 * A standard `SKILL.md`: JSON frontmatter naming the provider and its
 * instructions heading, then Markdown whose when-blocks stand alone on their
 * lines, open and close in turn, and never nest. `providers:generate` checks
 * the rest of G against the loaded definition.
 */
export function parseGuide(source, name) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
  let metadata;
  try {
    metadata = JSON.parse(frontmatter?.[1] ?? "");
  } catch {
    fail(name, "SKILL.md requires JSON frontmatter between --- lines");
  }
  if (
    metadata?.name !== name ||
    typeof metadata.instructionsHeading !== "string" ||
    !metadata.instructionsHeading.trim()
  ) {
    fail(name, "SKILL.md frontmatter requires matching name and non-empty instructionsHeading");
  }
  const body = source.slice(frontmatter[0].length).trim();
  const keys = new Set();
  let open;
  for (const line of body.split("\n")) {
    const marker = MARKER.exec(line.trim());
    if (!marker) {
      if (/<!--\s*(?:when:|end\s*-->)/.test(line)) fail(name, "G2: a when-block marker stands alone on its line");
      continue;
    }
    if (marker[1] !== undefined ? open !== undefined : open === undefined) {
      fail(name, "G2: SKILL.md when-blocks must open and close in turn, unnested");
    }
    open = marker[1];
    if (open !== undefined) keys.add(open);
  }
  if (open !== undefined) fail(name, `G2: SKILL.md leaves the when-block ${open} open`);
  return { body, instructionsHeading: metadata.instructionsHeading, keys };
}

function hatchLine(name, hatch) {
  if (!HATCH_NAME.test(hatch.name ?? "")) fail(name, "kit.hatch.name is a snake_case tool prefix");
  const entries = Object.entries(hatch.verdicts ?? {});
  if (!entries.every(([key, verdict]) => /^[A-Z]+ \//.test(key) && VERDICTS.has(verdict))) {
    fail(name, 'kit.hatch.verdicts map "METHOD /path" to read, write, destructive, or refuse');
  }
  const tool = (part) => `\`${hatch.name}_api_${part}\``;
  const refused = entries
    .filter(([, verdict]) => verdict === "refuse")
    .map(([key]) => `\`${key}\``)
    .sort();
  return (
    `- **Hatch:** ${tool("search")} finds this API's operations and reads no account data, ` +
    `${tool("details")} shows one operation's contract, and ${tool("read")} calls a reviewed read.` +
    (entries.some(([, verdict]) => verdict === "write" || verdict === "destructive")
      ? ` ${tool("write")} calls a reviewed write; the host may ask the user to confirm it.`
      : "") +
    " An operation without a reviewed verdict is refused" +
    (refused.length ? `; these are refused by design: ${refused.join(", ")}.` : ".")
  );
}

/** The vendor's declared error meanings (`VendorErrors.meanings`, carried as `kit.errors`). */
function errorsLine(name, errors) {
  if (
    errors === undefined ||
    typeof errors.unknownId !== "string" ||
    typeof errors.provesAbsence !== "boolean" ||
    !Array.isArray(errors.conflicts)
  ) {
    fail(name, "a standard provider declares VendorErrors.meanings (unknownId, provesAbsence, conflicts)");
  }
  const absence = errors.provesAbsence
    ? "`not_found` means the record does not exist; this API tells absence from a permission gap."
    : `An unknown id, or one these credentials cannot reach, fails as \`${errors.unknownId}\`; this API does not tell the two apart.`;
  const conflict = errors.conflicts.length
    ? `\`conflict\` means: ${errors.conflicts.join("; ")}.`
    : "It documents no conflict.";
  return [
    `- **Errors:** codes come from the vendor's statuses and error facts, never its prose. ${absence} ${conflict}`,
  ];
}

/**
 * The generated `## Conventions` (decision 0011): what the provider's
 * declarations mean for an agent. `kit` is the definition's `ProviderKitFacts`
 * (page size, hatch verdicts, error meanings and the idempotency fact). The
 * withheld-values line renders only for a kit whose hatch refuses a write
 * carrying a withheld placeholder (`kit.refusesWithheld`).
 */
export function renderConventions({ name, kind, kit }) {
  if (kind !== "api") fail(name, `a standard provider's kind is api, not ${kind}`);
  const api = [];
  const tail = [];
  {
    const pageSize = kit?.pageSize;
    if (pageSize !== undefined) {
      if (!Number.isSafeInteger(pageSize.default) || pageSize.default < 1 || !Number.isSafeInteger(pageSize.max)) {
        fail(name, "kit.pageSize needs a positive integer default and maximum");
      }
      if (pageSize.max < pageSize.default) fail(name, "kit.pageSize default exceeds its maximum");
      api.push(
        `- **Paging:** a paged \`list_*\` or \`search_*\` read takes \`limit\` (default ${pageSize.default}, at most ` +
          `${pageSize.max}) and \`cursor\`. While \`page.hasMore\` is true, pass \`page.nextCursor\` back unchanged as \`cursor\`; ` +
          "the last page has no `nextCursor`.",
      );
    }
    const paging = kit?.hatch?.paging;
    if (paging !== undefined) {
      if (paging !== "argument") fail(name, "kit.hatch.paging is argument");
      api.push(
        "- **Paging:** on a paged hatch read, keep the original method, path, filters, limit and fields. " +
          "Pass `page.nextCursor` unchanged as the top-level `cursor`; omit raw anchors on continuations. " +
          "The last page has `page.hasMore: false` and no `nextCursor`. If `page.hasMore` is true without a cursor, the data is incomplete and continuation could not be confined.",
      );
    }
    api.push(
      "- **Results:** `fields` narrows a read's result to the dot paths you name. `truncated` lists the dot paths a " +
        "result cut for size; the ids that fetch what was cut stay in the result.",
    );
    if (kit?.hatch !== undefined) api.push(hatchLine(name, kit.hatch));
    if (kit?.refusesWithheld === true) {
      tail.push(
        '- **Withheld values:** a value withheld for safety reads `"[redacted]"`. Writes refuse whole marker values and withheld links; longer prose may mention the marker. Paths and queries refuse any containment.',
      );
    }
  }
  if (typeof kit?.idempotencyKey !== "boolean") fail(name, "a standard provider declares idempotencyKey");
  const writes =
    "- **Writes:** a write is sent once and never retried. When its outcome is unknown, read the target before repeating it." +
    (kit.idempotencyKey
      ? " A write that takes `idempotencyKey` may be repeated with the same key and arguments while the vendor retains it."
      : " Writes take no idempotency key.");
  const lines = [...api, writes, ...errorsLine(name, kit?.errors), ...tail];
  return `## Conventions\n\n${lines.join("\n")}`;
}
