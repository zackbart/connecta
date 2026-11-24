#!/usr/bin/env node

import { copyFile, cp, lstat, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { CONNECTA_VERSION } from "./version.mjs";
import { META_TOOL_NAMES, READ_PROGRAM_TOOL } from "./meta-tool-names.mjs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [command, ...args] = process.argv.slice(2);

function shellCd(path) {
  if (process.platform === "win32") {
    return `cd /d "${path.replaceAll('"', '""')}"`;
  }
  return `cd '${path.replaceAll("'", "'\\''")}'`;
}

const DOCTOR_CREDENTIALS = ["CONNECTA_TOKEN", "CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET"];

function isHelp(arg) {
  return arg === "--help" || arg === "-h";
}

const REDACTED = "[redacted]";
const MIN_CREDENTIAL_LENGTH = 16;
const PRINTABLE_IDENTIFIER = /^[A-Za-z0-9_.:-]{1,64}$/;
const UNPRINTABLE = "<unprintable>";
const CREDENTIAL_WINDOW = 8;
const HEALTH_BYTE_LIMIT = 64 * 1024;
const CONFIG_BYTE_LIMIT = 4 * 1024 * 1024;
const MCP_BYTE_LIMIT = 4 * 1024 * 1024;

let doctorCredentials = [];

function sharesCredential(text) {
  return doctorCredentials.some((credential) => {
    if (text.includes(credential)) return true;
    for (let start = 0; start + CREDENTIAL_WINDOW <= text.length; start++) {
      if (credential.includes(text.slice(start, start + CREDENTIAL_WINDOW))) return true;
    }
    return false;
  });
}

function printable(value) {
  return typeof value === "string" && PRINTABLE_IDENTIFIER.test(value) && !sharesCredential(value)
    ? value
    : UNPRINTABLE;
}

function redactConfig(value) {
  if (typeof value === "string" || typeof value === "number") {
    return doctorCredentials.some((credential) => String(value).includes(credential)) ? REDACTED : value;
  }
  if (Array.isArray(value)) return value.map(redactConfig);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [redactConfig(key), redactConfig(entry)]));
  }
  return value;
}

function withoutCredentials(text) {
  let result = text;
  for (const credential of doctorCredentials) {
    result = result.split(`Bearer ${credential}`).join(`Bearer ${REDACTED}`).split(credential).join(REDACTED);
  }
  return result;
}

function filterStream(stream) {
  const write = stream.write.bind(stream);
  stream.write = (chunk, ...rest) => {
    if (typeof chunk === "string") return write(withoutCredentials(chunk), ...rest);
    if (chunk instanceof Uint8Array) return write(withoutCredentials(Buffer.from(chunk).toString("utf8")), ...rest);
    return write(chunk, ...rest);
  };
}

class DoctorFailure extends Error {}

function printFailure(error) {
  console.error(`[connecta] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

function printUnexpectedFailure(error) {
  printFailure(new DoctorFailure(`Doctor stopped on an unexpected ${printable(error?.name)}.`));
}

function terminalLabel(value) {
  return value
    .replace(/[^\w .+-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40)
    .trim();
}

async function readCapped(response, limit, route) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      throw new DoctorFailure(`Response from ${route} exceeds ${limit} bytes.`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function cappedResponse(response, limit, route, onOverflow) {
  if (!response.body) return response;
  let size = 0;
  const body = response.body.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        size += chunk.byteLength;
        if (size > limit) {
          onOverflow();
          controller.error(new DoctorFailure(`Response from ${route} exceeds ${limit} bytes.`));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

async function loadEnvFile(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") return;
    throw new Error(`--dotenv file could not be read${code ? ` (${code})` : ""}.`);
  }
  const parsed = parseEnv(text);
  for (const name of DOCTOR_CREDENTIALS) {
    if (!Object.hasOwn(parsed, name) || process.env[name] !== undefined) continue;
    process.env[name] = headerValue(name, parsed[name]) ?? "";
  }
}

function headerValue(name, value) {
  if (value === undefined || value === "") return value;
  if (!/^[\x21-\x7e]+$/.test(value)) {
    throw new Error(
      `${name} holds characters that cannot be sent in a request header. Check its value for quotes, spaces or line breaks.`,
    );
  }
  if (value.length < MIN_CREDENTIAL_LENGTH) {
    throw new Error(
      `${name} is shorter than ${MIN_CREDENTIAL_LENGTH} characters, so it cannot be a Connecta credential.`,
    );
  }
  return value;
}

function headerCredential(name) {
  return headerValue(name, process.env[name]);
}

function usage() {
  console.log(`Usage:
  connecta init [directory]
  CONNECTA_TOKEN=<bearer> connecta doctor [--config] [--url http://localhost:8787] [--pool <name>] [--dotenv <path>]
  CF_ACCESS_CLIENT_ID=<id> CF_ACCESS_CLIENT_SECRET=<secret> connecta doctor --url https://worker.example`);
}

async function init() {
  if (args.some(isHelp)) {
    usage();
    return;
  }
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
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code !== "ENOENT") throw error;
  }

  // Build beside the destination, then rename once complete. A failed copy or
  // rewrite leaves no partial destination that blocks a clean retry.
  let stage = await mkdtemp(join(parent, `.${basename(target)}.connecta-init-`));
  try {
    await cp(join(packageRoot, "templates", "node"), stage, {
      recursive: true,
    });

    // npm excludes .gitignore files and symlinks from packed dependencies.
    // Restore both conventions explicitly in the generated project.
    await writeFile(join(stage, ".gitignore"), ".connecta.sqlite*\n.env\nnode_modules/\n");
    await rm(join(stage, "CLAUDE.md"), { force: true });
    try {
      await symlink("AGENTS.md", join(stage, "CLAUDE.md"));
    } catch {
      // Some Windows environments disallow symlink creation. A materialized
      // fallback preserves discovery even though AGENTS.md remains canonical.
      await copyFile(join(stage, "AGENTS.md"), join(stage, "CLAUDE.md"));
    }

    const rootPackage = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
    const deploymentPath = join(stage, "package.json");
    const deploymentPackage = JSON.parse(await readFile(deploymentPath, "utf8"));
    deploymentPackage.dependencies["@zackbart/connecta"] = rootPackage.version;
    await writeFile(deploymentPath, JSON.stringify(deploymentPackage, null, 2) + "\n");

    await rename(stage, target);
    stage = "";
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true });
  }

  console.log(`Created ${target}`);
  console.log("Next:");
  console.log(`  ${shellCd(target)}`);
  console.log("  npm install");
  console.log("  # Choose readOnly in src/connecta.config.ts: false writes with client approval, true refuses writes.");
  console.log("  # Declare each machine client in agents in src/connecta.config.ts; local-machine is the first.");
  console.log("  npm run --silent rotate-token -- local-machine");
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

async function healthResponse(response) {
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new DoctorFailure(`HTTP ${response.status} from /health.`);
  }
  const text = await readCapped(response, HEALTH_BYTE_LIMIT, "/health");
  const sse = (response.headers.get("content-type") ?? "").includes("text/event-stream");
  const json = sse
    ? text
        .split("\n")
        .filter((candidate) => candidate.startsWith("data:"))
        .pop()
        ?.slice("data:".length)
        .trim()
    : text;
  if (json === undefined) throw new DoctorFailure("/health response contained no SSE data.");
  try {
    return JSON.parse(json);
  } catch {
    throw new DoctorFailure("/health returned a response that is not JSON.");
  }
}

const NATIVE_LISTING_CAP = /This endpoint has (\d{1,9}) tools, over the (\d{1,9})-tool native listing cap\./;

function mcpFailure(error, endpoint, failedPostStatus, overflowed) {
  for (let cause = error, depth = 0; cause && depth < 8; cause = cause.cause, depth++) {
    if (cause instanceof DoctorFailure) return cause;
  }
  if (overflowed) return new DoctorFailure(`Response from ${endpoint} exceeds ${MCP_BYTE_LIMIT} bytes.`);
  if (failedPostStatus !== undefined) return new DoctorFailure(`MCP ${failedPostStatus} from ${endpoint}.`);
  const cap = typeof error?.message === "string" ? NATIVE_LISTING_CAP.exec(error.message) : null;
  if (cap) {
    return new DoctorFailure(
      `MCP tools/list at ${endpoint} refused: ${Number(cap[1])} tools exceed the ${Number(cap[2])}-tool native listing cap. Narrow the pool or use the meta surface.`,
    );
  }
  const code =
    typeof error?.code === "number" || typeof error?.code === "string" ? ` ${printable(String(error.code))}` : "";
  return new DoctorFailure(`MCP request to ${endpoint} failed: ${printable(error?.name)}${code}.`);
}

function parseJson(text) {
  try {
    return JSON.parse(text ?? "null");
  } catch {
    return undefined;
  }
}

const DOCTOR_TIMEOUT_MS = 10_000;

async function doctorFetch(url, init = {}) {
  try {
    const response = await fetch(url, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.any([AbortSignal.timeout(DOCTOR_TIMEOUT_MS), ...(init.signal ? [init.signal] : [])]),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel().catch(() => {});
      throw new DoctorFailure(
        `HTTP ${response.status} redirect refused: doctor sends authentication only to the configured deployment URL.`,
      );
    }
    return response;
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new DoctorFailure(`Timed out after ${DOCTOR_TIMEOUT_MS}ms contacting ${url}`);
    }
    throw error;
  }
}

async function doctor() {
  for (let index = 0; index < args.length; index++) {
    if (isHelp(args[index])) {
      usage();
      return;
    }
    if (args[index] === "--config") continue;
    if (!["--url", "--pool", "--dotenv"].includes(args[index]) || !args[++index] || args[index].startsWith("--")) {
      usage();
      process.exitCode = 1;
      return;
    }
  }
  const envFile = option("--dotenv", undefined);
  if (envFile !== undefined) await loadEnvFile(envFile);
  const requestedUrl = option("--url", "http://localhost:8787");
  const pool = option("--pool", undefined);
  if (pool !== undefined && !/^[a-z0-9_-]+$/.test(pool)) {
    throw new Error("Doctor --pool must be a pool name: lowercase letters, digits, _ and -.");
  }
  const parsedUrl = new URL(requestedUrl);
  if (parsedUrl.username || parsedUrl.password) {
    throw new Error("Doctor URL must not contain credentials.");
  }
  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    throw new Error("Doctor URL must use http or https.");
  }
  const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
  if (parsedUrl.protocol === "http:" && !loopbackHosts.has(parsedUrl.hostname)) {
    throw new Error("Refusing to send authentication credentials over remote plaintext HTTP. Use HTTPS.");
  }
  const baseUrl = requestedUrl.replace(/\/+$/, "");
  const [token, accessClientId, accessClientSecret] = DOCTOR_CREDENTIALS.map(headerCredential);
  doctorCredentials = [token, accessClientId, accessClientSecret].filter(Boolean);
  if (Boolean(accessClientId) !== Boolean(accessClientSecret)) {
    throw new Error("Set both CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET.");
  }
  if (!token && !accessClientId) {
    throw new Error(
      "Set CONNECTA_TOKEN or a CF_ACCESS_CLIENT_ID/CF_ACCESS_CLIENT_SECRET pair so doctor can inspect the MCP surface.",
    );
  }
  const agent = Boolean(token?.startsWith("cta_"));
  if (agent && pool === undefined && !args.includes("--config")) {
    throw new Error("An agent token reaches only /agent/<pool>: pass --pool with a pool that lists the agent.");
  }
  if (!agent && pool !== undefined) {
    throw new Error("--pool is for agent tokens. People reach their pool at plain /mcp: omit --pool.");
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
    const text = await readCapped(response, CONFIG_BYTE_LIMIT, "/ui/api/config");
    let contract;
    try {
      contract = JSON.parse(text);
    } catch {
      throw new Error("Deployment returned an invalid config contract.");
    }
    // Operator contract v2 (#837) serves a pool member their own view, which
    // carries no config; only a maintainer's carries the snapshot.
    if (contract?.schemaVersion === 2 && contract.role === "member") {
      throw new Error("The config snapshot is for maintainers only.");
    }
    if (contract?.schemaVersion !== 2 || contract.role !== "maintainer" || contract.config?.schemaVersion !== 1) {
      throw new Error("Deployment returned an unsupported config contract.");
    }
    // The server builds this with describeConfig's allowlist; do not print
    // the overlay, identity, health deploymentInfo, or a raw error body.
    console.log(JSON.stringify(redactConfig(contract.config), null, 2));
    return;
  }

  const health = await healthResponse(await doctorFetch(`${baseUrl}/health`, { headers: authHeaders }));
  if (health?.status !== "ok") {
    throw new Error(`Unexpected health status from /health: ${printable(health?.status)}.`);
  }
  // Whatever ran the program is what doctor names. The deployment reports its
  // own sandbox and a deployment that reports none gets an executor-neutral
  // line — anything else is doctor asserting a sandbox it never saw (#368).
  // The string arrives from a server and lands in a terminal, so it is
  // sanitized here too rather than trusted twice.
  const executorLabel = typeof health.executor?.name === "string" ? terminalLabel(health.executor.name) : "";
  const executorName = sharesCredential(executorLabel) ? "" : executorLabel;
  const { Client, StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client");
  const client = new Client(
    { name: "connecta-doctor", version: CONNECTA_VERSION },
    { versionNegotiation: { mode: "auto", probe: { timeoutMs: DOCTOR_TIMEOUT_MS } } },
  );
  // Agent endpoints bypass Access at the edge and read only the cta_ token.
  const endpoint = agent ? `/agent/${pool}` : "/mcp";
  let failedPostStatus;
  let overflowed = false;
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}${endpoint}`), {
    requestInit: { headers: agent ? { Authorization: `Bearer ${token}` } : authHeaders },
    fetch: async (url, init) => {
      const response = await doctorFetch(url, init);
      if (init?.method === "POST") failedPostStatus = response.ok ? undefined : response.status;
      return cappedResponse(response, MCP_BYTE_LIMIT, endpoint, () => {
        overflowed = true;
      });
    },
  });
  let negotiatedVersion;
  let native = false;
  let executeCode = true;
  let toolCount = META_TOOL_NAMES.length;
  let readRoute = false;
  try {
    await client.connect(transport);
    negotiatedVersion = client.getNegotiatedProtocolVersion();
    const listed = await client.listTools({}, { timeout: DOCTOR_TIMEOUT_MS });
    const actual = listed.tools.map((tool) => tool.name).sort();
    const surface = listed.tools.find((tool) => tool.name === "skills")?._meta?.["dev.connecta/surface"];
    native = surface?.surface === "native";
    executeCode = !native || surface.executeCode === true;
    if (native && surface.catalogErrors?.length)
      throw new DoctorFailure(
        `Native catalogs unavailable: ${surface.catalogErrors.map(printable).join(", ")}. Inspect connector status and authentication.`,
      );
    // Tools are listed, from an older catalog, so nothing above notices that the connector did not answer.
    if (native && surface.staleCatalogs?.length)
      throw new DoctorFailure(
        `Native discovery degraded: ${surface.staleCatalogs.map(printable).join(", ")} did not answer and listed from an older catalog. Inspect connector status.`,
      );
    readRoute = !native && actual.includes(READ_PROGRAM_TOOL);
    const expected = native
      ? ["authorize_connector", "skills", executeCode ? "execute_code" : "read_result"].sort()
      : [...META_TOOL_NAMES, ...(readRoute ? [READ_PROGRAM_TOOL] : [])].sort();
    toolCount = expected.length;
    if (
      native
        ? expected.some((name) => !actual.includes(name)) ||
          [
            "search_tools",
            "call_tool",
            "call_destructive_tool",
            READ_PROGRAM_TOOL,
            executeCode ? "read_result" : "execute_code",
          ].some((name) => actual.includes(name))
        : JSON.stringify(actual) !== JSON.stringify(expected)
    ) {
      throw new DoctorFailure(
        `Unexpected MCP surface. Expected ${expected.join(", ")}; received ${actual.length} tool(s): ` +
          `${actual.map(printable).join(", ")}.`,
      );
    }

    for (const name of executeCode ? ["execute_code", ...(readRoute ? [READ_PROGRAM_TOOL] : [])] : []) {
      const executed = await client.callTool({ name, arguments: { code: "async () => 42" } }, undefined, {
        timeout: DOCTOR_TIMEOUT_MS,
      });
      const executionResult = executed.structuredContent ?? parseJson(executed.content?.[0]?.text);
      if (executed.isError || executionResult?.result !== 42) {
        throw new DoctorFailure(
          `${executorName ? `${executorName} execution` : name} check failed: ` +
            (executed.isError ? "the tool returned an error." : "the program did not return 42."),
        );
      }
    }
  } catch (error) {
    throw mcpFailure(error, endpoint, failedPostStatus, overflowed);
  } finally {
    await client.close();
  }

  console.log(
    `Connecta doctor passed: ${Number.isSafeInteger(health.connectors) ? health.connectors : UNPRINTABLE} connector(s), ` +
      `${executeCode ? (executorName ? `${executorName} executed` : "code executed") : "code disabled"}, ` +
      `${native ? "native tool surface" : `prescribed ${toolCount}-tool surface`}, MCP ${printable(negotiatedVersion)}, package ${CONNECTA_VERSION}.`,
  );
}

try {
  if (isHelp(command)) usage();
  else if (command === "init") await init();
  else if (command === "doctor") {
    filterStream(process.stdout);
    filterStream(process.stderr);
    process.on("uncaughtException", printUnexpectedFailure);
    process.on("unhandledRejection", printUnexpectedFailure);
    await doctor();
  } else {
    usage();
    process.exitCode = 1;
  }
} catch (error) {
  printFailure(error);
}
