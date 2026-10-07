import { readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const types = ["added", "changed", "fixed", "removed", "security"];
const root = fileURLToPath(new URL("../", import.meta.url));

// Deliberately a small frontmatter format, not a general YAML parser.
function parseFragment(text, file) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
  if (!match) throw new Error(`${file}: expected --- frontmatter and an entry body`);
  const metadata = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^(type|breaking): (\S+)$/.exec(line);
    if (!field || Object.hasOwn(metadata, field[1])) {
      throw new Error(`${file}: unknown, duplicate, or malformed frontmatter field: ${line}`);
    }
    metadata[field[1]] = field[2];
  }
  if (!types.includes(metadata.type)) throw new Error(`${file}: type must be ${types.join(" | ")}`);
  if (metadata.breaking !== undefined && metadata.breaking !== "true") {
    throw new Error(`${file}: breaking must be true when present`);
  }
  const body = match[2].trim().replaceAll("\r\n", "\n");
  if (!body || /^#{1,6}\s/m.test(body) || /^- /m.test(body)) {
    throw new Error(`${file}: expected entry text without section headings or outer list markers`);
  }
  return { type: metadata.type, breaking: metadata.breaking === "true", body };
}

function fragments(directory) {
  return readdirSync(directory).filter((name) => name !== ".gitkeep").sort().map((name) => {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.md$/.test(name)) {
      throw new Error(`${name}: fragments must be named <pr-or-slug>.md`);
    }
    const file = join(directory, name);
    const bytes = readFileSync(file);
    return { file, bytes, ...parseFragment(bytes.toString("utf8"), name) };
  });
}

function main() {
  const args = process.argv.slice(2);
  const entries = fragments(join(root, ".changes"));
  if (args.length === 1 && args[0] === "--check") {
    console.log(`Changelog: ${entries.length} valid fragments.`);
    return;
  }
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!["--version", "--narrative", "--date"].includes(key) || !args[i + 1] || Object.hasOwn(options, key)) {
      throw new Error("Usage: npm run changelog:assemble -- --version <version> --narrative <file> [--date YYYY-MM-DD]");
    }
    options[key] = args[i + 1];
  }
  const version = options["--version"];
  if (!version || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("--version must be a release version such as 0.29.0");
  }
  if (!options["--narrative"]) throw new Error("--narrative must name the hand-written release opening");
  const narrative = readFileSync(options["--narrative"], "utf8").trim();
  if (!narrative || /^#{1,6}\s/m.test(narrative)) throw new Error("The release narrative must contain paragraphs without headings");
  const date = options["--date"] ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) {
    throw new Error("--date must be a real date in YYYY-MM-DD format");
  }
  if (!entries.length) throw new Error("No changelog fragments to assemble");
  const file = join(root, "CHANGELOG.md");
  const original = readFileSync(file);
  const changelog = original.toString("utf8");
  const headings = [...changelog.matchAll(/^## (.+)$/gm)];
  if (headings.some(([heading]) => heading === "## Unreleased" || heading.split(/\s/)[1] === version)) {
    throw new Error("Remove the unreleased section or existing version before assembling");
  }
  const sections = types.flatMap((type) => {
    const group = entries.filter((entry) => entry.type === type);
    if (!group.length) return [];
    const bullets = group.map(({ breaking, body }) => `- ${breaking ? "**Breaking:** " : ""}${body.replaceAll("\n", "\n  ")}`);
    return [`### ${type[0].toUpperCase()}${type.slice(1)}\n\n${bullets.join("\n")}`];
  });
  const section = `## ${version} — ${date}\n\n${narrative}\n\n${sections.join("\n\n")}\n\n`;
  const insertion = headings[0]?.index ?? changelog.length;
  // Keep the original bytes until consumption completes so a filesystem error
  // restores the entire input set and permits a same-version retry.
  const temporary = `${file}.tmp`;
  let committed = false;
  const deleted = [];
  try {
    writeFileSync(temporary, changelog.slice(0, insertion) + section + changelog.slice(insertion));
    renameSync(temporary, file);
    committed = true;
    for (const entry of entries) {
      unlinkSync(entry.file);
      deleted.push(entry);
    }
  } catch (error) {
    const failures = [];
    if (committed) {
      try {
        writeFileSync(temporary, original);
        renameSync(temporary, file);
      } catch (restoreError) {
        failures.push(`CHANGELOG.md: ${restoreError.message}`);
      }
    }
    for (const entry of deleted) {
      try {
        writeFileSync(entry.file, entry.bytes);
      } catch (restoreError) {
        failures.push(`${entry.file}: ${restoreError.message}`);
      }
    }
    try {
      rmSync(temporary, { force: true });
    } catch (cleanupError) {
      failures.push(`${temporary}: ${cleanupError.message}`);
    }
    const recovery = failures.length ? `Rollback failed: ${failures.join("; ")}` : "Original changelog and fragments restored; retry after clearing the fault.";
    throw new Error(`Changelog assembly failed: ${error.message}. ${recovery}`);
  }
  console.log(`Assembled ${entries.length} fragments into ${version}. Review and commit CHANGELOG.md and the deletions.`);
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
