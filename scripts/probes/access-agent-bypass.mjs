// Production-only probe for #837 P0. Deploys a disposable Worker on workers.dev,
// protects it with a Worker-level Access application, then adds a path-scoped
// Bypass application for /agent/* and records which raw paths reach the Worker,
// with what ctx.access, and which pathname the Worker saw. Everything it creates
// is named connecta-probe-<run> and deleted in finally; existing Access
// applications are only counted and compared, never changed.
// Requires `cf` authenticated for Access application, policy, service-token,
// and Workers script writes. Every cf call names its auth profile explicitly
// (--profile, default onemany); Wrangler is used only to build the Worker for
// `cf deploy` and needs no login.
// Usage: node scripts/probes/access-agent-bypass.mjs [--profile <name>] [output.json]
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cfBin = process.env.CF_BIN ?? "cf";
const argv = process.argv.slice(2);
const profileFlag = argv.indexOf("--profile");
const profile = profileFlag === -1 ? "onemany" : argv.splice(profileFlag, 2)[1];
if (!profile) throw new Error("--profile needs a value");
const output = resolve(argv[0] ?? join(root, "eval/results/access-agent-bypass.json"));
// cf deploy builds through Wrangler and requires 4.136.0 or newer, newer than
// the repository's pinned devDependency, so the probe project installs its own.
const buildWrangler = "4.145.0";
const run = Date.now().toString(36);
const name = `connecta-probe-${run}`;
const temp = await mkdtemp(join(tmpdir(), "connecta-probe-"));
const project = join(temp, "worker");
const tokenHeaders = join(temp, "service-token.headers");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const failures = [];
const created = { apps: [], serviceToken: undefined, worker: false };
const record = { testedAt: new Date().toISOString(), name, profile, tools: {}, inventory: {}, api: [], phases: [] };
let origin;
const audDigests = new Map();
async function rememberAud(label, aud) {
  if (typeof aud !== "string" || !aud) return;
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(aud)));
  audDigests.set(Array.from(bytes.slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join(""), label);
}

async function cf(args, { body } = {}) {
  const full = ["--profile", profile, ...args, ...(body ? ["--body", JSON.stringify(body)] : [])];
  try {
    // cf caches the account under ./.cloudflare; keep that out of the checkout.
    const { stdout } = await exec(cfBin, full, { cwd: temp, maxBuffer: 2 ** 24 });
    const parsed = stdout.trim() ? JSON.parse(stdout) : null;
    return { ok: true, value: parsed && typeof parsed === "object" && "result" in parsed ? parsed.result : parsed };
  } catch (error) {
    // CLI errors carry API messages; keep only the message text, never request bodies.
    const text = `${error.stderr ?? ""}${error.stdout ?? ""}`.replace(/\s+/g, " ").trim();
    return { ok: false, error: text.slice(0, 600) || String(error.message).slice(0, 600) };
  }
}

async function listApps() {
  const apps = [];
  for (let page = 1; page < 50; page++) {
    const response = await cf([
      "zero-trust",
      "access",
      "applications",
      "list",
      "--per-page",
      "100",
      "--page",
      String(page),
    ]);
    if (!response.ok) throw new Error(`Could not list Access applications: ${response.error}`);
    const rows = Array.isArray(response.value) ? response.value : [];
    apps.push(...rows);
    if (rows.length < 100) break;
  }
  return apps;
}

let workerId;
function redact(text) {
  let value = String(text).replace(/\/accounts\/[0-9a-f]{32}/g, "/accounts/<account>");
  if (origin) value = value.replaceAll(new URL(origin).host, "<probe-host>");
  if (workerId) value = value.replaceAll(workerId, "<probe-worker-id>");
  return value;
}

async function createApp(label, body) {
  const response = await cf(["zero-trust", "access", "applications", "create"], { body });
  if (response.ok && response.value?.id) created.apps.push(response.value.id);
  const entry = {
    label,
    request: JSON.parse(redact(JSON.stringify({ ...body, policies: body.policies?.map((p) => p.decision) }))),
    accepted: response.ok,
    error: response.ok ? undefined : redact(response.error),
    storedDestinations: response.ok
      ? JSON.parse(redact(JSON.stringify(response.value.destinations ?? null)))
      : undefined,
    storedDomain: response.ok && response.value.domain ? redact(response.value.domain) : undefined,
    storedSelfHostedDomains: response.ok
      ? JSON.parse(redact(JSON.stringify(response.value.self_hosted_domains ?? null)))
      : undefined,
  };
  record.api.push(entry);
  console.log(JSON.stringify(entry));
  return response.ok ? response.value : undefined;
}

// Without --force, cf asks for confirmation and exits 0 without deleting when
// stdin is not a terminal, so every delete is forced and then verified.
async function deleteApp(id) {
  const response = await cf(["zero-trust", "access", "applications", "delete", id, "--force"]);
  if (!response.ok) return response;
  for (let attempt = 0; ; attempt++) {
    if (!(await cf(["zero-trust", "access", "applications", "get", id])).ok) break;
    if (attempt === 4) return { ok: false, error: "application still exists after delete" };
    await wait(1000);
  }
  created.apps = created.apps.filter((app) => app !== id);
  return response;
}

const source = `
const PROBE_RUN = ${JSON.stringify(run)};
const SERVICE_MARKERS = ["service_token_status", "service_token_id", "common_name"];
async function digest(text) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...bytes.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    let access;
    if (ctx.access === undefined) access = { state: "undefined" };
    else if (ctx.access === null) access = { state: "null" };
    else {
      const aud = ctx.access.aud;
      access = { state: "present", aud: typeof aud !== "string" ? typeof aud : aud.length ? "nonempty" : "empty" };
      // A digest prefix, compared by the probe against each application's AUD; never the tag itself.
      if (typeof aud === "string" && aud.length) access.audDigest = await digest(aud);
      if (typeof ctx.access.getIdentity !== "function") access.identity = "no-getIdentity";
      else {
        try {
          const id = await ctx.access.getIdentity();
          const markers = id && typeof id === "object" ? SERVICE_MARKERS.filter((k) => id[k] !== undefined && id[k] !== false && id[k] !== "") : [];
          access.identity = id == null ? String(id) : markers.length ? "service" : id.user_uuid || id.email ? "user" : "other";
          if (markers.length) access.serviceMarkers = markers;
        } catch { access.identity = "threw"; }
      }
    }
    return Response.json({
      pathname: url.pathname,
      search: url.search,
      method: request.method,
      access,
      jwtAssertionHeader: request.headers.has("cf-access-jwt-assertion"),
      authorizationCookie: /(^|;\\s*)CF_Authorization=/.test(request.headers.get("cookie") ?? ""),
      clientIdHeader: request.headers.has("cf-access-client-id"),
      authorizationHeader: request.headers.has("authorization"),
    }, { headers: { "x-connecta-probe": PROBE_RUN, "cache-control": "no-store" } });
  }
};
`;

async function findWorker() {
  const search = await cf(["workers", "scripts", "search", "--name", name]);
  if (!search.ok) throw new Error(`Could not search Workers: ${search.error}`);
  return search.value.find((s) => (s.script_name ?? s.name) === name)?.id;
}

// cf deploy printed "Deploy complete" and then stayed running on 2026-10-15, so
// the probe resolves on that line and stops the process itself.
function deploy() {
  return new Promise((resolve, reject) => {
    const child = spawn(cfBin, ["--profile", profile, "deploy"], { cwd: project, stdio: ["ignore", "pipe", "pipe"] });
    let text = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("cf deploy timed out"));
    }, 300000);
    const onData = (chunk) => {
      text += chunk;
      if (/Deploy complete/.test(text)) {
        clearTimeout(timer);
        child.kill();
        resolve(text);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", reject);
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (/Deploy complete/.test(text)) resolve(text);
      else reject(new Error(`cf deploy exited ${code}: ${redact(text.slice(-400))}`));
    });
  });
}

// curl --path-as-is sends each raw path byte for byte; WHATWG fetch would
// normalize dot segments and %2e before the request leaves the client.
async function request(path, { credential = "none", method = "GET" } = {}) {
  const args = ["-sS", "--path-as-is", "-i", "--max-time", "20", "-X", method];
  if (credential === "service-token") args.push("-H", `@${tokenHeaders}`);
  if (credential === "bearer") args.push("-H", "authorization: Bearer cta_probe_not_a_real_token");
  if (credential === "forged-assertion") args.push("-H", "cf-access-jwt-assertion: probe.not.a.jwt");
  if (method === "POST")
    args.push("-H", "content-type: application/json", "--data", '{"jsonrpc":"2.0","id":1,"method":"tools/list"}');
  args.push(`${origin}${path}`);
  let stdout;
  try {
    ({ stdout } = await exec("curl", args, { maxBuffer: 2 ** 22 }));
  } catch (error) {
    return {
      path,
      credential,
      method,
      outcome: "client-error",
      error: String(error.stderr ?? error.message).slice(0, 200),
    };
  }
  const split = stdout.indexOf("\r\n\r\n");
  const head = stdout.slice(0, split).split("\r\n");
  const body = stdout.slice(split + 4);
  const status = Number(head[0].split(" ")[1]);
  const headers = new Map(
    head
      .slice(1)
      .map((line) => [line.slice(0, line.indexOf(":")).toLowerCase(), line.slice(line.indexOf(":") + 1).trim()]),
  );
  const row = { path, credential, method, status };
  if (headers.get("x-connecta-probe") === run) {
    const seen = JSON.parse(body);
    if (seen.access.audDigest) {
      seen.access.audApplication = audDigests.get(seen.access.audDigest) ?? "unknown";
      delete seen.access.audDigest;
    }
    Object.assign(row, { outcome: "worker", received: seen.pathname + seen.search, ...seen });
    delete row.pathname;
    delete row.search;
    delete row.method;
    row.method = method;
  } else {
    const location = headers.get("location");
    let locationKind;
    if (location) {
      try {
        const target = new URL(location, origin);
        locationKind = target.host.endsWith(".cloudflareaccess.com")
          ? "access-login"
          : target.host === new URL(origin).host
            ? `same-host ${target.pathname}`
            : "other-host";
      } catch {
        locationKind = "unparsable";
      }
    }
    // Unauthenticated requests get Access's 403 page here because the probe's
    // only allow policy is a service token; an identity policy would redirect.
    row.outcome =
      status === 302 && locationKind === "access-login"
        ? "access-login"
        : status === 403 && /<title>[^<]*Cloudflare Access<\/title>/.test(body)
          ? "access-denied"
          : "edge-error";
    if (locationKind) row.location = locationKind;
    if (row.outcome === "edge-error") row.body = redact(body.replace(/\s+/g, " ").slice(0, 160));
  }
  return row;
}

// Edge errors (1104, 1043) appeared while configuration propagated, so a state
// counts only after three consecutive matching responses.
async function until(label, path, credential, predicate) {
  const started = Date.now();
  let streak = 0;
  for (let attempt = 0; attempt < 90; attempt++) {
    const row = await request(path, { credential });
    streak = predicate(row) ? streak + 1 : 0;
    if (streak === 3) {
      console.log(`${label}: stable after ${Math.round((Date.now() - started) / 1000)}s`);
      return Date.now() - started;
    }
    await wait(streak ? 1000 : 5000);
  }
  throw new Error(`${label}: state never converged`);
}
const denied = (row) => row.outcome === "access-denied" || row.outcome === "access-login";

const PATHS = [
  "/agent/x",
  "/agent/simon-zack",
  "/mcp",
  "/",
  "/agent",
  "/agent/",
  "/agentx",
  "/AGENT/x",
  "/%61gent/x",
  "/agent/../mcp",
  "/agent/x/../../mcp",
  "/agent/%2e%2e/mcp",
  "/agent/%2E%2E/mcp",
  "/agent%2f..%2fmcp",
  "/agent/x%2f..%2f..%2fmcp",
  "/agent/%2f/mcp",
  "//agent/x",
  "/agent/x?y",
  "/agent/x/",
  "/mcp/agent/x",
  "/mcp/../agent/x",
];

async function phase(label, cases) {
  const rows = [];
  for (const spec of cases) rows.push(await request(spec.path, spec));
  record.phases.push({ label, rows });
  console.log(`${label}:`);
  for (const row of rows)
    console.log(
      `  ${row.method} ${row.path} [${row.credential}] -> ${row.status} ${row.outcome}${row.received ? ` ${row.received} access=${JSON.stringify(row.access)}` : ""}`,
    );
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(record, null, 2) + "\n");
  return rows;
}

let beforeIds;
try {
  record.tools.cf = (await exec(cfBin, ["--version"])).stdout.trim();
  record.tools.buildWrangler = buildWrangler;
  record.tools.node = process.version;
  record.tools.curl = (await exec("curl", ["--version"])).stdout.split("\n")[0].split(" ").slice(0, 2).join(" ");

  const before = await listApps();
  beforeIds = new Set(before.map((app) => app.id));
  record.inventory.before = { count: before.length };
  if (before.some((app) => String(app.name).startsWith("connecta-probe-")))
    throw new Error("A connecta-probe- Access application already exists; clean it up first");
  if (before.some((app) => (app.destinations ?? []).some((d) => d.type === "all_workers")))
    record.inventory.accountLevelWorkerAccess = true;
  console.log(`Access applications before: ${before.length}`);

  await mkdir(project);
  await writeFile(join(project, "worker.mjs"), source);
  await writeFile(
    join(project, "package.json"),
    JSON.stringify({
      name: "connecta-probe",
      private: true,
      type: "module",
      devDependencies: { wrangler: buildWrangler },
    }),
  );
  // defineConfig only returns its argument, so a plain default export needs no cf package.
  await writeFile(
    join(project, "cloudflare.config.ts"),
    `export default ${JSON.stringify({
      worker: {
        name,
        entrypoint: "./worker.mjs",
        compatibilityDate: "2026-09-01",
        workersDev: true,
        previewUrls: false,
        observability: { enabled: false },
      },
    })};\n`,
  );
  await exec("npm", ["install", "--no-audit", "--no-fund", "--silent"], { cwd: project, maxBuffer: 2 ** 22 });
  created.worker = true;
  origin = (await deploy()).match(new RegExp(`https://${name}\\.[a-zA-Z0-9-]+\\.workers\\.dev`))?.[0];
  if (!origin) throw new Error("Deployment returned no workers.dev URL");
  const host = new URL(origin).host;
  workerId = await findWorker();
  if (!workerId) throw new Error("Could not resolve the probe Worker id");
  console.log(`Deployed ${redact(origin)}`);
  record.compatibilityDate = "2026-09-01";
  await until("worker reachable", "/mcp", "none", (row) => row.outcome === "worker");
  await until("worker reachable at /agent/x", "/agent/x", "none", (row) => row.outcome === "worker");
  await phase("baseline: no Access application", [{ path: "/mcp" }, { path: "/agent/x" }]);

  const token = await cf([
    "zero-trust",
    "access",
    "service-tokens",
    "create",
    "--name",
    `${name}-token`,
    "--duration",
    "1h",
  ]);
  if (!token.ok || !token.value?.client_id) throw new Error(`Could not create service token: ${token.error}`);
  created.serviceToken = token.value.id;
  await writeFile(
    tokenHeaders,
    `CF-Access-Client-Id: ${token.value.client_id}\nCF-Access-Client-Secret: ${token.value.client_secret}\n`,
    { mode: 0o600 },
  );
  token.value = undefined;

  const workerApp = await createApp("worker-level application", {
    type: "self_hosted",
    name: `${name}-worker`,
    destinations: [{ type: "worker", worker_id: workerId }],
    session_duration: "1h",
    policies: [
      {
        name: `${name}-service`,
        decision: "non_identity",
        include: [{ service_token: { token_id: created.serviceToken } }],
      },
    ],
  });
  if (!workerApp) throw new Error("Worker-level Access application was refused");
  await rememberAud("worker-level", workerApp.aud);
  record.propagation = {
    workerLevelMs: await until("worker-level Access active", "/mcp", "none", denied),
  };
  await until("/agent/x protected", "/agent/x", "none", denied);
  await until(
    "service token admitted",
    "/mcp",
    "service-token",
    (row) => row.outcome === "worker" && row.access.audApplication === "worker-level",
  );
  await phase("worker-level only", [
    ...["/mcp", "/agent/x", "/"].map((path) => ({ path })),
    ...["/mcp", "/agent/x"].map((path) => ({ path, credential: "service-token" })),
  ]);

  // Question 4: which destination shapes does the API accept for a path bypass?
  const bypass = [{ name: `${name}-bypass`, decision: "bypass", include: [{ everyone: {} }] }];
  for (const [label, destinations] of [
    ["worker destination with uri", [{ type: "worker", worker_id: workerId, uri: `${host}/agent/*` }]],
    ["worker destination with path", [{ type: "worker", worker_id: workerId, path: "/agent/*" }]],
  ]) {
    const app = await createApp(label, {
      type: "self_hosted",
      name: `${name}-variant`,
      destinations,
      session_duration: "1h",
      policies: bypass,
    });
    if (app) {
      const removed = await deleteApp(app.id);
      if (!removed.ok) throw new Error(`Could not delete variant application: ${removed.error}`);
      // An accepted variant may have bypassed the whole Worker; wait until it is gone.
      await until("variant removed", "/agent/x", "none", denied);
    }
  }

  const pathApp = await createApp("path application", {
    type: "self_hosted",
    name: `${name}-agent`,
    destinations: [{ type: "public", uri: `${host}/agent/*` }],
    session_duration: "1h",
    policies: bypass,
  });
  if (!pathApp) throw new Error("Path-scoped bypass application was refused");
  await rememberAud("path", pathApp.aud);
  record.propagation.pathBypassMs = await until(
    "path bypass active",
    "/agent/x",
    "none",
    (row) => row.outcome === "worker" && row.access.audApplication === "path",
  );
  // Let every edge location converge before recording; then record three times.
  // A 30-second wait was not enough on 2026-10-15: one round still saw a 403.
  await wait(90000);
  for (const round of [1, 2, 3]) {
    await phase(`worker-level plus /agent/* bypass, round ${round}`, [
      ...PATHS.map((path) => ({ path })),
      { path: "/agent/x", method: "POST", credential: "bearer" },
      { path: "/agent/x", credential: "service-token" },
      { path: "/agent/x", credential: "forged-assertion" },
      { path: "/mcp", credential: "service-token" },
      { path: "/mcp", credential: "bearer" },
      { path: "/", credential: "service-token" },
    ]);
  }

  const removed = await deleteApp(pathApp.id);
  if (!removed.ok) throw new Error(`Could not delete path application: ${removed.error}`);
  record.propagation.pathRemovalMs = await until("path bypass removed", "/agent/x", "none", denied);
  await phase("after removing the path application", [{ path: "/agent/x" }, { path: "/mcp" }]);
} catch (error) {
  failures.push(error);
  record.error = redact(String(error.message ?? error));
} finally {
  for (const id of [...created.apps].reverse()) {
    const response = await deleteApp(id);
    if (!response.ok) failures.push(new Error(`Could not delete Access application ${id}: ${response.error}`));
  }
  // Catch applications whose create response was lost.
  try {
    for (const app of await listApps())
      if (String(app.name).startsWith(name)) {
        const response = await deleteApp(app.id);
        if (!response.ok) failures.push(new Error(`Could not delete Access application ${app.id}: ${response.error}`));
      }
  } catch (error) {
    failures.push(error);
  }
  if (created.serviceToken) {
    const response = await cf(["zero-trust", "access", "service-tokens", "delete", created.serviceToken, "--force"]);
    if (!response.ok)
      failures.push(new Error(`Could not delete service token ${created.serviceToken}: ${response.error}`));
  }
  if (created.worker) {
    let deletionError = "not attempted";
    for (let attempt = 0; attempt < 3 && deletionError; attempt++) {
      try {
        const id = workerId ?? (await findWorker());
        const response = id === undefined ? { ok: true } : await cf(["workers", "delete", id, "--force"]);
        if (!response.ok) deletionError = response.error;
        else if ((await findWorker()) !== undefined) deletionError = "Worker still exists after delete";
        else deletionError = undefined;
        if (deletionError) await wait(1000);
      } catch (error) {
        deletionError = String(error.message ?? error);
        await wait(1000);
      }
    }
    if (deletionError)
      failures.push(
        new Error(
          `Could not delete Worker ${name} (${deletionError}). Run cf --profile ${profile} workers delete <id> --force.`,
        ),
      );
  }
  try {
    const after = await listApps();
    const workers = await cf(["workers", "scripts", "search", "--name", name]);
    const tokens = await cf(["zero-trust", "access", "service-tokens", "list", "--search", name]);
    const afterIds = new Set(after.map((app) => app.id));
    record.inventory.after = {
      count: after.length,
      nonProbeIdsUnchanged:
        beforeIds !== undefined && afterIds.size === beforeIds.size && [...beforeIds].every((id) => afterIds.has(id)),
      probeApplicationsRemaining: after.filter((app) => String(app.name).startsWith("connecta-probe-")).length,
      probeWorkersRemaining: workers.ok
        ? workers.value.filter((s) => (s.script_name ?? s.name) === name).length
        : "unknown",
      probeServiceTokensRemaining: tokens.ok
        ? tokens.value.filter((t) => String(t.name).startsWith(name)).length
        : "unknown",
    };
    const inventory = record.inventory;
    if (
      inventory.after.count !== inventory.before?.count ||
      !inventory.after.nonProbeIdsUnchanged ||
      inventory.after.probeApplicationsRemaining !== 0 ||
      inventory.after.probeWorkersRemaining !== 0 ||
      inventory.after.probeServiceTokensRemaining !== 0
    )
      failures.push(new Error(`Teardown verification failed: ${JSON.stringify(inventory)}`));
    console.log(`Inventory: ${JSON.stringify(inventory)}`);
  } catch (error) {
    failures.push(error);
  }
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(record, null, 2) + "\n");
  await rm(temp, { recursive: true, force: true });
}
if (failures.length > 1) throw new AggregateError(failures, "Probe and cleanup failed");
if (failures.length === 1) throw failures[0];
