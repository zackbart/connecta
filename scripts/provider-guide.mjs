// The maintained guide of decision 0011 (G): `SKILL.md`'s body with its
// `<!-- when: <key> -->` … `<!-- end -->` blocks, followed by a
// `## Conventions` section rendered from the provider's declarations.
// `providers:generate` writes both into `skill.generated.ts`, and
// `ProviderContext.usageGuide` selects each connection's blocks.

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
  const refused = entries.filter(([, verdict]) => verdict === "refuse").length;
  return (
    `- **Hatch:** ${tool("search")} finds operations, ${tool("details")} shows one contract, ${tool("read")} calls a reviewed read` +
    (entries.some(([, verdict]) => verdict === "write" || verdict === "destructive")
      ? ` and ${tool("write")} a reviewed write.`
      : ".") +
    (refused
      ? ` ${refused} ${refused === 1 ? "operation is" : "operations are"} refused by design; use ${tool("details")} with the method and path to see each summary and refusal, even for methods outside the read/write schemas.`
      : "")
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
  const conflict = errors.conflicts.length ? ` \`conflict\` means: ${errors.conflicts.join("; ")}.` : "";
  return `- **Errors:** ${absence}${conflict}`;
}

/**
 * Fixture-owned `conventionToolBlocks`: each conditional tool belongs to one
 * declared guide block. `providers:generate` uses them to label the installed
 * inventory, so a bad mapping fails generation.
 */
export function checkToolBlocks({ name, tools = [], keys = [], toolBlocks }) {
  if (toolBlocks === undefined) return;
  if (!toolBlocks || typeof toolBlocks !== "object" || Array.isArray(toolBlocks))
    fail(name, "conventionToolBlocks must map authored tools to declared guide blocks");
  const known = new Set(tools.map((tool) => tool.name));
  for (const [tool, key] of Object.entries(toolBlocks)) {
    if (!known.has(tool)) fail(name, `conventionToolBlocks names unknown tool ${tool}`);
    if (typeof key !== "string" || !keys.includes(key))
      fail(name, `conventionToolBlocks tool ${tool} needs one declared, unambiguous block key`);
  }
}

/**
 * The generated `## Conventions` (decision 0011, amended by the note under its
 * G): only what this provider's declarations say that no schema, hatch
 * description or typed refusal already tells the agent at the point of use. A
 * rule common to every provider belongs at that point of use instead. `kit` is
 * the definition's `ProviderKitFacts`: hatch verdicts, error meanings, the
 * idempotency fact and any vendor envelope root.
 */
export function renderConventions({ name, kind, kit }) {
  if (kind !== "api") fail(name, `a standard provider's kind is api, not ${kind}`);
  const lines = [];
  if (kit?.hatch?.fieldsRoot !== undefined) {
    const root = kit.hatch.fieldsRoot;
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(root)) fail(name, "kit.hatch.fieldsRoot is a property name");
    lines.push(
      `- **Envelope fields:** hatch data keeps the vendor envelope: select \`${root}.id\`, or \`${root}[].id\` across a list. Named reads keep their projected fields.`,
    );
  }
  if (kit?.hatch !== undefined) lines.push(hatchLine(name, kit.hatch));
  if (typeof kit?.idempotencyKey !== "boolean") fail(name, "a standard provider declares idempotencyKey");
  if (kit.idempotencyKey)
    lines.push(
      "- **Writes:** a write that takes `idempotencyKey` may be repeated with the same key and arguments while the vendor retains it.",
    );
  lines.push(errorsLine(name, kit?.errors));
  return `## Conventions\n\n${lines.join("\n")}`;
}
