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
      ? ` ${tool("write")} calls a reviewed write, and every call to it needs approval.`
      : "") +
    " An operation without a reviewed verdict is refused" +
    (refused.length ? `; these are refused by design: ${refused.join(", ")}.` : ".")
  );
}

/**
 * The generated `## Conventions` (decision 0011): what the provider's
 * declarations mean for an agent. `kit` is the definition's `ProviderKitFacts`
 * (page size and hatch verdicts arrive with the provider kit); `withheld` says
 * the folder holds a reviewed value-safety table. A dual provider's API and
 * hosted conventions stand in its `api` and `hosted` blocks.
 */
export function renderConventions({ name, kind, kit, withheld, keys = [] }) {
  if (!["mcp", "api", "dual"].includes(kind))
    fail(name, `a standard provider's kind is mcp, api, or dual, not ${kind}`);
  if (kind === "dual" && !(keys.includes("api") && keys.includes("hosted"))) {
    fail(name, "G2: a dual provider declares the hosted and api block keys");
  }
  const api = [];
  const tail = [];
  if (kind !== "mcp") {
    const pageSize = kit?.pageSize;
    if (pageSize !== undefined) {
      if (!Number.isSafeInteger(pageSize.default) || pageSize.default < 1 || !Number.isSafeInteger(pageSize.max)) {
        fail(name, "kit.pageSize needs a positive integer default and maximum");
      }
      if (pageSize.max < pageSize.default) fail(name, "kit.pageSize default exceeds its maximum");
      api.push(
        `- **Paging:** a paged \`list_*\` or \`search_*\` read takes \`limit\` (default ${pageSize.default}, at most ` +
          `${pageSize.max}) and \`cursor\`. While \`page.hasMore\` is true, pass \`page.nextCursor\` back unchanged as \`cursor\`.`,
      );
    }
    api.push(
      "- **Results:** `fields` narrows a read's result to the dot paths you name. `truncated` lists the dot paths a " +
        "result cut for size; the ids that fetch what was cut stay in the result.",
    );
    if (kit?.hatch !== undefined) api.push(hatchLine(name, kit.hatch));
    if (withheld) {
      tail.push(
        '- **Withheld values:** a value withheld for safety reads `"[redacted]"`, and a write that carries one is refused.',
      );
    }
  }
  const writes =
    "- **Writes:** a write is sent once and never retried. When its outcome is unknown, read the target before repeating it.";
  const hosted =
    kind === "api"
      ? []
      : [
          "- **Hosted tools:** the hosted catalog varies by plan and permission, so search it rather than assume a " +
            "tool exists. A tool without a reviewed classification counts as a write unless it declares itself read-only.",
        ];
  const block = (key, lines) => (lines.length === 0 ? [] : [`<!-- when: ${key} -->`, ...lines, "<!-- end -->"]);
  const lines =
    kind === "dual"
      ? [...block("api", api), writes, ...block("api", tail), ...block("hosted", hosted)]
      : [...api, writes, ...tail, ...hosted];
  return `## Conventions\n\n${lines.join("\n")}`;
}
