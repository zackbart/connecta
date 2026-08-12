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
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
  CONNECTA_TOKEN=<bearer> connecta doctor [--url http://localhost:8787]`);
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
      ".connecta-state.json\n.env\nnode_modules/\n",
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
  console.log("  CONNECTA_TOKEN=dev-token npm start");
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
    return await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(DOCTOR_TIMEOUT_MS),
    });
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
  const known = new Set(["--url"]);
  for (let index = 0; index < args.length; index += 2) {
    if (!known.has(args[index]) || !args[index + 1]) {
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
      "Refusing to send a bearer token over remote plaintext HTTP. Use HTTPS.",
    );
  }
  const baseUrl = requestedUrl.replace(/\/+$/, "");
  const token = process.env.CONNECTA_TOKEN;
  if (!token) {
    throw new Error(
      "Set CONNECTA_TOKEN so doctor can inspect the MCP surface.",
    );
  }

  const health = await jsonResponse(
    await doctorFetch(`${baseUrl}/health`),
  );
  if (health.status !== "ok") {
    throw new Error(`Unexpected health status: ${String(health.status)}`);
  }
  let requestId = 0;
  const mcp = async (method, params) =>
    jsonResponse(
      await doctorFetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
          id: ++requestId,
          method,
          params,
      }),
      }),
    );

  const listed = await mcp("tools/list", {});
  if (listed.error) {
    throw new Error(`tools/list failed: ${JSON.stringify(listed.error)}`);
  }
  const actual = listed.result?.tools
    ?.map((tool) => tool.name)
    .sort();
  const expected = [
    "authorize_connector",
    "call_destructive_tool",
    "call_tool",
    "execute_code",
    "get_result",
    "search_tools",
    "skills",
  ];
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Unexpected MCP surface. Expected ${expected.join(", ")}; received ` +
      `${Array.isArray(actual) ? actual.join(", ") : "no tool list"}.`,
    );
  }

  const executed = await mcp("tools/call", {
    name: "execute_code",
    arguments: { code: "async () => 42" },
  });
  if (executed.error) {
    throw new Error(`execute_code failed: ${JSON.stringify(executed.error)}`);
  }
  const executionResult =
    executed.result?.structuredContent ??
    JSON.parse(executed.result?.content?.[0]?.text ?? "null");
  if (executed.result?.isError || executionResult?.result !== 42) {
    throw new Error(
      `QuickJS execution check failed: ${JSON.stringify(executed.result)}`,
    );
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
      "QuickJS executed, prescribed seven-tool surface" +
      (drifted.length > 0
        ? `, catalog drift on ${drifted.length} connector(s).`
        : "."),
  );
}

try {
  if (command === "init") await init();
  else if (command === "doctor") await doctor();
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
