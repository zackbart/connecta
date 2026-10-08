#!/usr/bin/env node

import {
  copyFile,
  cp,
  lstat,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { CONNECTA_VERSION } from "./version.mjs";
import { META_TOOL_NAMES } from "./meta-tool-names.mjs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [command, ...args] = process.argv.slice(2);

function shellCd(path) {
  if (process.platform === "win32") {
    return `cd /d "${path.replaceAll('"', '""')}"`;
  }
  return `cd '${path.replaceAll("'", "'\\''")}'`;
}

function usage() {
  console.log(`Usage:
  connecta init [directory]
  connecta migrate-state <state.json> <connecta.sqlite>
  CONNECTA_TOKEN=<bearer> connecta doctor [--config] [--url http://localhost:8787]
  CF_ACCESS_CLIENT_ID=<id> CF_ACCESS_CLIENT_SECRET=<secret> connecta doctor --url https://worker.example`);
}

async function init() {
  if (args.length > 1) {
    usage();
    process.exitCode = 1;
    return;
  }
  const destination = args[0] ?? "connecta-deployment";
  const target = resolve(process.cwd(), destination);
  const parent = dirname(target);
  try {
    await lstat(target);
    throw new Error(`Refusing to overwrite existing path: ${target}`);
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "";
    if (code !== "ENOENT") throw error;
  }

  // Build beside the destination, then rename once complete. A failed copy or
  // rewrite leaves no partial destination that blocks a clean retry.
  let stage = await mkdtemp(
    join(parent, `.${basename(target)}.connecta-init-`),
  );
  try {
    await cp(join(packageRoot, "templates", "node"), stage, {
      recursive: true,
    });

    // npm excludes .gitignore files and symlinks from packed dependencies.
    // Restore both conventions explicitly in the generated project.
    await writeFile(
      join(stage, ".gitignore"),
      ".connecta.sqlite*\n.env\nnode_modules/\n",
    );
    await rm(join(stage, "CLAUDE.md"), { force: true });
    try {
      await symlink("AGENTS.md", join(stage, "CLAUDE.md"));
    } catch {
      // Some Windows environments disallow symlink creation. A materialized
      // fallback preserves discovery even though AGENTS.md remains canonical.
      await copyFile(join(stage, "AGENTS.md"), join(stage, "CLAUDE.md"));
    }

    const rootPackage = JSON.parse(
      await readFile(join(packageRoot, "package.json"), "utf8"),
    );
    const deploymentPath = join(stage, "package.json");
    const deploymentPackage = JSON.parse(
      await readFile(deploymentPath, "utf8"),
    );
    deploymentPackage.dependencies["@zackbart/connecta"] = rootPackage.version;
    await writeFile(
      deploymentPath,
      JSON.stringify(deploymentPackage, null, 2) + "\n",
    );

    await rename(stage, target);
    stage = "";
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true });
  }

  console.log(`Created ${target}`);
  console.log("Next:");
  console.log(`  ${shellCd(target)}`);
  console.log("  npm install");
  console.log('  npm run --silent provision-token -- "local-machine"');
  console.log("  # Save the returned cta_ token privately for your MCP client and doctor.");
  console.log("  npm start");
  console.log("  # README.md covers database paths and Docker provisioning.");
}

function option(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

async function jsonResponse(response) {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  if ((response.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const line = text
      .split("\n")
      .filter((candidate) => candidate.startsWith("data:"))
      .pop();
    if (!line) throw new Error("MCP response contained no SSE data");
    return JSON.parse(line.slice("data:".length).trim());
  }
  return JSON.parse(text);
}

const DOCTOR_TIMEOUT_MS = 10_000;

async function doctorFetch(url, init = {}) {
  try {
    const response = await fetch(url, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.any([
        AbortSignal.timeout(DOCTOR_TIMEOUT_MS),
        ...(init.signal ? [init.signal] : []),
      ]),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel().catch(() => {});
      throw new Error(
        `HTTP ${response.status} redirect refused: doctor sends authentication only to the configured deployment URL.`,
      );
    }
    return response;
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError")
    ) {
      throw new Error(`Timed out after ${DOCTOR_TIMEOUT_MS}ms contacting ${url}`);
    }
    throw error;
  }
}

async function doctor() {
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--config") continue;
    if (args[index] !== "--url" || !args[++index] || args[index].startsWith("--")) {
      usage();
      process.exitCode = 1;
      return;
    }
  }
  const requestedUrl = option("--url", "http://localhost:8787");
  const parsedUrl = new URL(requestedUrl);
  if (parsedUrl.username || parsedUrl.password) {
    throw new Error("Doctor URL must not contain credentials.");
  }
  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    throw new Error("Doctor URL must use http or https.");
  }
  const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
  if (
    parsedUrl.protocol === "http:" &&
    !loopbackHosts.has(parsedUrl.hostname)
  ) {
    throw new Error(
      "Refusing to send authentication credentials over remote plaintext HTTP. Use HTTPS.",
    );
  }
  const baseUrl = requestedUrl.replace(/\/+$/, "");
  const token = process.env.CONNECTA_TOKEN;
  const accessClientId = process.env.CF_ACCESS_CLIENT_ID;
  const accessClientSecret = process.env.CF_ACCESS_CLIENT_SECRET;
  if (Boolean(accessClientId) !== Boolean(accessClientSecret)) {
    throw new Error(
      "Set both CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET.",
    );
  }
  if (!token && !accessClientId) {
    throw new Error(
      "Set CONNECTA_TOKEN or a CF_ACCESS_CLIENT_ID/CF_ACCESS_CLIENT_SECRET pair so doctor can inspect the MCP surface.",
    );
  }
  const authHeaders = {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(accessClientId && accessClientSecret
      ? {
          "CF-Access-Client-Id": accessClientId,
          "CF-Access-Client-Secret": accessClientSecret,
        }
      : {}),
  };

  if (args.includes("--config")) {
    const response = await doctorFetch(`${baseUrl}/ui/api/config`, { headers: authHeaders });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`HTTP ${response.status}: config snapshot unavailable.`);
    }
    let contract;
    try {
      contract = await response.json();
    } catch {
      throw new Error("Deployment returned an invalid config contract.");
    }
    if (contract?.schemaVersion !== 1 || contract.config?.schemaVersion !== 1) {
      throw new Error("Deployment returned an unsupported config contract.");
    }
    // The server builds this with describeConfig's allowlist; do not print
    // the overlay, identity, health deploymentInfo, or a raw error body.
    console.log(JSON.stringify(contract.config, null, 2));
    return;
  }

  const health = await jsonResponse(
    await doctorFetch(`${baseUrl}/health`, { headers: authHeaders }),
  );
  if (health.status !== "ok") {
    throw new Error(`Unexpected health status: ${String(health.status)}`);
  }
  // Whatever ran the program is what doctor names. The deployment reports its
  // own sandbox and a deployment that reports none gets an executor-neutral
  // line — anything else is doctor asserting a sandbox it never saw (#368).
  // The string arrives from a server and lands in a terminal, so it is
  // sanitized here too rather than trusted twice.
  const executorName =
    typeof health.executor?.name === "string"
      ? health.executor.name
          .replace(/[^\w .+-]+/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 40)
          .trim()
      : "";
  const { Client, StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client");
  const client = new Client(
    { name: "connecta-doctor", version: CONNECTA_VERSION },
    { versionNegotiation: { mode: "auto", probe: { timeoutMs: DOCTOR_TIMEOUT_MS } } },
  );
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: authHeaders },
    fetch: doctorFetch,
  });
  let negotiatedVersion;
  try {
    await client.connect(transport);
    negotiatedVersion = client.getNegotiatedProtocolVersion();
    const listed = await client.listTools({}, { timeout: DOCTOR_TIMEOUT_MS });
    const actual = listed.tools.map((tool) => tool.name).sort();
    const expected = [...META_TOOL_NAMES].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(
        `Unexpected MCP surface. Expected ${expected.join(", ")}; received ` +
        `${Array.isArray(actual) ? actual.join(", ") : "no tool list"}.`,
      );
    }

    const executed = await client.callTool({
      name: "execute_code",
      arguments: { code: "async () => 42" },
    }, undefined, { timeout: DOCTOR_TIMEOUT_MS });
    const executionResult =
      executed.structuredContent ??
      JSON.parse(executed.content?.[0]?.text ?? "null");
    if (executed.isError || executionResult?.result !== 42) {
      throw new Error(
        `${executorName ? `${executorName} execution` : "execute_code"} check ` +
          `failed: ${JSON.stringify(executed)}`,
      );
    }
  } finally {
    await client.close();
  }

  // Drift is reported, never failed on. A downstream that grew a tool nobody
  // has classified is a maintainer's next task, not a broken deployment: the
  // unclassified tool already fails closed onto call_destructive_tool. These
  // counts come from refreshes the deployment already served, so a deployment
  // that has answered no catalog request yet reports nothing here (#343).
  const drifted = Object.entries(health.catalogDrift ?? {}).filter(
    ([, report]) =>
      report.unclassifiedTools ||
      report.unservedTools ||
      report.annotationConflicts ||
      report.schemaChanges,
  );
  for (const [connectorId, report] of drifted) {
    console.warn(
      `[connecta] catalog drift on "${connectorId}" (observed ` +
        `${report.observedAt}): ${report.unclassifiedTools} unclassified, ` +
        `${report.unservedTools} no longer served, ` +
        `${report.annotationConflicts} annotation conflict(s), ` +
        `${report.schemaChanges} schema change(s).`,
    );
  }

  console.log(
    `Connecta doctor passed: ${health.connectors} connector(s), ` +
      `${executorName ? `${executorName} executed` : "code executed"}, ` +
      `prescribed ${META_TOOL_NAMES.length}-tool surface, MCP ${negotiatedVersion}, package ${CONNECTA_VERSION}` +
      (drifted.length > 0
        ? `, catalog drift on ${drifted.length} connector(s).`
        : "."),
  );
}

/**
 * One-shot copy of a 0.28 `fileStorage` JSON state file into the SQLite
 * database 0.29 stores everything in. Stop the old deployment first; the file
 * is read, never changed.
 */
async function migrateState() {
  if (args.length !== 2 || args.some((arg) => arg.startsWith("--"))) {
    usage();
    process.exitCode = 1;
    return;
  }
  const [statePath, databasePath] = args.map((arg) => resolve(process.cwd(), arg));
  const { importStateFile, openSqlite } = await import(
    pathToFileURL(join(packageRoot, "dist", "sqlite.js")).href
  );
  const database = openSqlite(databasePath);
  try {
    const result = importStateFile(database, statePath);
    console.log(
      `Imported ${result.imported} entries from ${statePath} into ${databasePath}` +
        ` (${result.kept} already present, ${result.expired} expired).`,
    );
  } finally {
    database.close();
  }
}

try {
  if (command === "init") await init();
  else if (command === "doctor") await doctor();
  else if (command === "migrate-state") await migrateState();
  else {
    usage();
    process.exitCode = command === "--help" || command === "-h" ? 0 : 1;
  }
} catch (error) {
  console.error(
    `[connecta] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
