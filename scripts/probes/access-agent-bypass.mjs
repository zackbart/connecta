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
//        node scripts/probes/access-agent-bypass.mjs --self-test
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { inspect } from "node:util";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cfBin = process.env.CF_BIN ?? "cf";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// The runner. Every subprocess goes through spawnCapture, which keeps stdout
// and stderr in memory, enforces a deadline by killing the process group, and
// never returns raw text past run(), runText(), or runJson(). Those return only
// facts ({ ok, exitCode, timedOut, status?, code?, slug? }) plus, for
// runText/runJson, the fields a schema whitelists.
// ---------------------------------------------------------------------------

// Cloudflare error slugs the probe may report, as an exact finite set. Any other
// slug-shaped text, including a known slug with a suffix, becomes "unknown".
const KNOWN_SLUGS = new Set(["access.api.error.conflict"]);

function spawnCapture(cmd, args, { cwd, timeoutMs = 60000, until } = {}) {
  return new Promise((resolvePromise) => {
    const out = [];
    const err = [];
    let timedOut = false;
    let matched = false;
    let settled = false;
    let child;
    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      resolvePromise({
        exitCode: typeof exitCode === "number" ? exitCode : null,
        timedOut,
        matched,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      });
    };
    let grace;
    const killGroup = () => {
      if (!child) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {}
      }
      // A process that escaped the group can hold the pipes open; stop waiting.
      grace ??= setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(null);
      }, 2000);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);
    try {
      child = spawn(cmd, args, { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      finish(null);
      return;
    }
    const check = () => {
      if (!until || matched) return;
      if (until.test(Buffer.concat(out).toString("utf8")) || until.test(Buffer.concat(err).toString("utf8"))) {
        matched = true;
        killGroup();
      }
    };
    child.stdout.on("data", (chunk) => {
      out.push(chunk);
      check();
    });
    child.stderr.on("data", (chunk) => {
      err.push(chunk);
      check();
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code));
  });
}

function facts(raw) {
  const text = `${raw.stdout}\n${raw.stderr}`;
  const result = {
    ok: raw.matched || (raw.exitCode === 0 && !raw.timedOut),
    exitCode: raw.exitCode,
    timedOut: raw.timedOut,
  };
  const status = text.match(/\b([1-5]\d\d) [A-Z][A-Za-z ]*? · HTTP\b/)?.[1];
  if (status) result.status = Number(status);
  const code = text.match(/\[(\d{3,6})\]/)?.[1];
  if (code) result.code = Number(code);
  const slug = text.match(/\baccess\.api\.error\.[A-Za-z0-9_.-]+/)?.[0].replace(/\.+$/, "");
  if (slug) result.slug = KNOWN_SLUGS.has(slug) ? slug : "unknown";
  return result;
}

async function run(cmd, args, options) {
  return facts(await spawnCapture(cmd, args, options));
}

// `schema` receives the raw text inside the runner and must return only
// whitelisted fields; anything it throws becomes `unexpectedOutput`.
async function runText(cmd, args, schema, { combined = false, ...options } = {}) {
  const raw = await spawnCapture(cmd, args, options);
  const result = facts(raw);
  if (!result.ok) return result;
  try {
    return { ...result, value: schema(combined ? `${raw.stdout}\n${raw.stderr}` : raw.stdout) };
  } catch {
    return { ...result, ok: false, unexpectedOutput: true };
  }
}

async function runJson(cmd, args, schema, options) {
  return runText(cmd, args, (text) => schema(JSON.parse(text)), options);
}

// Schema combinators. Each validates and copies only declared fields; a value of
// the wrong type, including null where an array is expected, throws.
class ShapeError extends Error {}
const bad = () => {
  throw new ShapeError("unexpected shape");
};
// Credentials leave the runner only inside this holder, which prints as [secret].
class Secret {
  #value;
  constructor(value) {
    this.#value = value;
  }
  reveal() {
    return this.#value;
  }
  toJSON() {
    return "[secret]";
  }
  toString() {
    return "[secret]";
  }
  [inspect.custom]() {
    return "[secret]";
  }
}
const S = {
  string:
    (max = 256, pattern) =>
    (v) =>
      typeof v === "string" && v.length <= max && (!pattern || pattern.test(v)) ? v : bad(),
  boolean: (v) => (typeof v === "boolean" ? v : bad()),
  optional: (inner) => (v) => (v === undefined || v === null ? undefined : inner(v)),
  array: (inner) => (v) => (Array.isArray(v) ? v.map(inner) : bad()),
  object: (fields) => (v) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) bad();
    const copy = {};
    for (const [key, field] of Object.entries(fields)) {
      const value = field(v[key]);
      if (value !== undefined) copy[key] = value;
    }
    return copy;
  },
  oneOf: (values) => (v) => (values.includes(v) ? v : bad()),
  secret: (v) => (typeof v === "string" && v ? new Secret(v) : bad()),
  // cf prints either the API's `result` or the bare value.
  cf: (inner) => (v) => inner(v && typeof v === "object" && !Array.isArray(v) && "result" in v ? v.result : v),
};
const id = S.string(64, /^[A-Za-z0-9-]+$/);

// Errors carry a fixed diagnostic written in this file plus runner facts.
class ProbeError extends Error {
  constructor(diagnostic, result) {
    const detail = result
      ? [
          result.timedOut ? "timed out" : `exit ${result.exitCode}`,
          result.status && `HTTP ${result.status}`,
          result.code && `code ${result.code}`,
          result.slug && `slug ${result.slug}`,
          result.unexpectedOutput && "unexpected output",
        ].filter(Boolean)
      : [];
    super(detail.length ? `${diagnostic} (${detail.join(", ")})` : diagnostic);
    this.name = "ProbeError";
  }
}
const ERROR_NAMES = ["Error", "TypeError", "RangeError", "SyntaxError", "AggregateError"];
// Only a ProbeError's message is ours; any other error prints as its class.
function describe(error) {
  if (error instanceof ProbeError) return error.message;
  const name =
    error instanceof Error && ERROR_NAMES.includes(error.constructor.name) ? error.constructor.name : "Error";
  return `unexpected ${name}`;
}

const MARKERS = ["service_token_status", "service_token_id", "common_name"];
const workerView = S.object({
  pathname: S.string(512),
  search: S.string(512),
  method: S.oneOf(["GET", "POST"]),
  access: S.object({
    state: S.oneOf(["undefined", "null", "present"]),
    aud: S.optional(S.oneOf(["nonempty", "empty", "undefined", "object", "number", "boolean"])),
    audDigest: S.optional(S.string(16, /^[0-9a-f]{16}$/)),
    identity: S.optional(S.oneOf(["undefined", "null", "service", "user", "other", "no-getIdentity", "threw"])),
    serviceMarkers: S.optional(S.array(S.oneOf(MARKERS))),
  }),
  jwtAssertionHeader: S.boolean,
  authorizationCookie: S.boolean,
  clientIdHeader: S.boolean,
  authorizationHeader: S.boolean,
});

// Parses `curl -i` output into whitelisted facts about one response.
function httpSchema(runId, origin) {
  return (text) => {
    const split = text.indexOf("\r\n\r\n");
    if (split === -1) bad();
    const head = text.slice(0, split).split("\r\n");
    const body = text.slice(split + 4);
    const status = Number(head[0].split(" ")[1]);
    if (!Number.isInteger(status)) bad();
    const headers = new Map(
      head
        .slice(1)
        .map((line) => [line.slice(0, line.indexOf(":")).toLowerCase(), line.slice(line.indexOf(":") + 1).trim()]),
    );
    if (headers.get("x-connecta-probe") === runId) return { status, worker: workerView(JSON.parse(body)) };
    const location = headers.get("location");
    let locationKind;
    if (location) {
      try {
        const target = new URL(location, origin);
        locationKind = target.host.endsWith(".cloudflareaccess.com")
          ? "access-login"
          : target.host === new URL(origin).host
            ? "same-host"
            : "other-host";
      } catch {
        locationKind = "unparsable";
      }
    }
    const edgeCode = body.match(/error code: (\d{3,5})/)?.[1];
    return {
      status,
      locationKind,
      accessPage: /<title>[^<]*Cloudflare Access<\/title>/.test(body),
      edgeCode: edgeCode ? Number(edgeCode) : undefined,
    };
  };
}

const appSchema = S.object({
  id,
  name: S.string(256),
  aud: S.optional(S.string(128, /^[0-9a-f]+$/)),
  domain: S.optional(S.string(512)),
  self_hosted_domains: S.optional(S.array(S.string(512))),
  destinations: S.optional(
    S.array(S.object({ type: S.string(64), uri: S.optional(S.string(512)), worker_id: S.optional(id) })),
  ),
});
// Listing needs only ids, names, and destination types; other fields of
// unrelated applications are never read.
const appListSchema = S.cf(
  S.array(S.object({ id, name: S.string(256), destinations: S.optional(S.array(S.object({ type: S.string(64) }))) })),
);
const tokenListSchema = S.cf(S.array(S.object({ id, name: S.string(256) })));
const tokenCreateSchema = S.cf(S.object({ id, client_id: S.secret, client_secret: S.secret }));
const workerSearchSchema = S.cf(
  S.array(S.object({ id, script_name: S.optional(S.string(256)), name: S.optional(S.string(256)) })),
);
const versionSchema = (text) => text.match(/\d+\.\d+\.\d+[0-9A-Za-z.-]*/)?.[0] ?? bad();

// ---------------------------------------------------------------------------
// Offline self-test: feeds canaries through the runner and asserts that nothing
// raw escapes and that deadlines fire. Runs no cf, curl, or network command.
// ---------------------------------------------------------------------------
async function selfTest() {
  const canary = "secretcanary";
  const node = process.execPath;
  const results = [];
  const seen = [];
  const check = (label, condition) => {
    results.push({ label, pass: Boolean(condition) });
    console.log(`${condition ? "pass" : "FAIL"}  ${label}`);
  };
  const keep = (value) => {
    seen.push(value);
    return value;
  };
  const scratch = await mkdtemp(join(tmpdir(), "connecta-probe-selftest-"));
  try {
    const leaky = `process.stdout.write('${canary} {"client_secret":"${canary}"} [12132] access.api.error.conflict.${canary} │ 409 Conflict · HTTP /x'); process.stderr.write('client_secret=${canary}'); process.exit(1)`;
    const failed = keep(await run(node, ["-e", leaky]));
    check("run: failing command keeps only facts", !failed.ok && failed.exitCode === 1 && !failed.timedOut);
    check("run: numeric code and HTTP status survive", failed.code === 12132 && failed.status === 409);
    check("run: a known slug with a suffix becomes unknown", failed.slug === "unknown");
    check(
      "run: result has only fact keys",
      Object.keys(failed).every((key) => ["ok", "exitCode", "timedOut", "status", "code", "slug"].includes(key)),
    );

    const known = keep(
      await run(node, [
        "-e",
        "process.stderr.write('[12132] access.api.error.conflict: x │ 409 Conflict · HTTP'); process.exit(1)",
      ]),
    );
    check("run: an exact known slug is kept", known.slug === "access.api.error.conflict");

    const json = keep(
      await runJson(
        node,
        [
          "-e",
          `process.stdout.write(JSON.stringify({ result: [{ id: "abc-1", name: "n", client_secret: "${canary}" }] }))`,
        ],
        tokenListSchema,
      ),
    );
    check(
      "runJson: schema drops unlisted fields",
      json.ok && json.value.length === 1 && !("client_secret" in json.value[0]),
    );

    const nullJson = keep(await runJson(node, ["-e", "process.stdout.write('null')"], tokenListSchema));
    check("runJson: null where an array is expected fails, never []", !nullJson.ok && nullJson.unexpectedOutput);
    const objectJson = keep(await runJson(node, ["-e", "process.stdout.write('{\"result\":{}}')"], appListSchema));
    check("runJson: an object where an array is expected fails", !objectJson.ok && objectJson.unexpectedOutput);
    const garbage = keep(await runJson(node, ["-e", `process.stdout.write('not json ${canary}')`], tokenListSchema));
    check("runJson: unparsable output fails without quoting it", !garbage.ok && garbage.unexpectedOutput);

    const token = await runJson(
      node,
      [
        "-e",
        `process.stdout.write(JSON.stringify({ id: "tok-1", client_id: "${canary}", client_secret: "${canary}" }))`,
      ],
      tokenCreateSchema,
    );
    keep(token);
    check(
      "runJson: credentials print as [secret] everywhere",
      token.ok &&
        token.value.client_secret.reveal() === canary &&
        !JSON.stringify(token).includes(canary) &&
        !inspect(token, { depth: 5 }).includes(canary) &&
        !String(token.value.client_secret).includes(canary),
    );

    const http = `HTTP/2 403\r\nlocation: https://x.cloudflareaccess.com/${canary}\r\nset-cookie: client_secret=${canary}\r\n\r\n<title>Error ・ Cloudflare Access</title> ${canary} error code: 1104`;
    const parsed = keep(
      await runText(
        node,
        ["-e", `process.stdout.write(${JSON.stringify(http)})`],
        httpSchema("run1", "https://h.example"),
      ),
    );
    check(
      "runText: HTTP parsing keeps status, kinds, and codes only",
      parsed.ok &&
        parsed.value.status === 403 &&
        parsed.value.locationKind === "access-login" &&
        parsed.value.accessPage,
    );
    const workerBody = JSON.stringify({
      pathname: "/agent/x",
      search: "",
      method: "GET",
      access: { state: "present", aud: "nonempty", identity: "undefined", token: canary },
      jwtAssertionHeader: false,
      authorizationCookie: false,
      clientIdHeader: false,
      authorizationHeader: false,
      extra: canary,
    });
    const workerHttp = `HTTP/2 200\r\nx-connecta-probe: run1\r\n\r\n${workerBody}`;
    const workerRow = keep(
      await runText(
        node,
        ["-e", `process.stdout.write(${JSON.stringify(workerHttp)})`],
        httpSchema("run1", "https://h.example"),
      ),
    );
    check(
      "runText: Worker view keeps only the access summary",
      workerRow.ok && workerRow.value.worker.pathname === "/agent/x",
    );
    const curlFailure = keep(
      await runText(
        node,
        ["-e", `process.stderr.write('curl: (6) client_secret=${canary}'); process.exit(6)`],
        httpSchema("run1", "https://h.example"),
      ),
    );
    check(
      "runText: a failing request reports only facts",
      !curlFailure.ok && curlFailure.exitCode === 6 && !("value" in curlFailure),
    );

    const pidFile = join(scratch, "grandchild.pid");
    const stallMs = 5000;
    const started = Date.now();
    const stalled = keep(
      await run(
        node,
        [
          "-e",
          `const { spawn } = require("node:child_process"); const g = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(g.pid)); setInterval(() => {}, 1000);`,
        ],
        { timeoutMs: stallMs },
      ),
    );
    const elapsed = Date.now() - started;
    check(
      "run: a stalled process times out at its deadline",
      stalled.timedOut && !stalled.ok && elapsed >= stallMs && elapsed < stallMs + 4000,
    );
    let grandchild;
    try {
      grandchild = Number(await readFile(pidFile, "utf8"));
    } catch {}
    let grandchildAlive = false;
    if (grandchild) {
      await wait(300);
      try {
        process.kill(grandchild, 0);
        grandchildAlive = true;
      } catch {}
    }
    check("run: the deadline kills the whole process group", grandchild > 0 && !grandchildAlive);

    const deploy = keep(
      await runText(
        node,
        [
          "-e",
          "console.log('https://connecta-probe-x.sub.workers.dev'); console.log('Deploy complete'); setInterval(() => {}, 1000)",
        ],
        (text) => ({ origin: text.match(/https:\/\/connecta-probe-x\.[a-z0-9-]+\.workers\.dev/)?.[0] ?? bad() }),
        { until: /Deploy complete/, timeoutMs: 10000, combined: true },
      ),
    );
    check("runText: `until` stops a process that keeps running", deploy.ok && !deploy.timedOut && deploy.value.origin);

    const missing = keep(await run(join(scratch, "no-such-binary"), []));
    check("run: a missing binary is a failure with facts only", !missing.ok && missing.exitCode === null);

    const probeError = new ProbeError("could not list Access applications", failed);
    const foreign = new TypeError(`boom ${canary}`);
    keep(describe(probeError));
    keep(describe(foreign));
    check("errors: ProbeError text comes from facts", !describe(probeError).includes(canary));
    check("errors: other errors print as their class only", describe(foreign) === "unexpected TypeError");

    const everything = JSON.stringify(seen) + inspect(seen, { depth: 10 });
    check("no canary escaped any runner result, error, or inspection", !everything.includes(canary));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  const failedCount = results.filter((row) => !row.pass).length;
  console.log(`self-test: ${results.length - failedCount}/${results.length} passed`);
  if (failedCount) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// The live probe.
// ---------------------------------------------------------------------------
async function probe(argv) {
  const profileFlag = argv.indexOf("--profile");
  const profile = profileFlag === -1 ? "onemany" : argv.splice(profileFlag, 2)[1];
  if (!profile) throw new ProbeError("--profile needs a value");
  const output = resolve(argv[0] ?? join(root, "eval/results/access-agent-bypass.json"));
  // cf deploy builds through Wrangler and requires 4.136.0 or newer, newer than
  // the repository's pinned devDependency, so the probe project installs its own.
  const buildWrangler = "4.145.0";
  const runId = Date.now().toString(36);
  const name = `connecta-probe-${runId}`;
  const temp = await mkdtemp(join(tmpdir(), "connecta-probe-"));
  const project = join(temp, "worker");
  const tokenHeaders = join(temp, "service-token.headers");
  const failures = [];
  // Ids still to delete, and every id ever created for the final inventory.
  const created = { apps: [], serviceToken: undefined, worker: false };
  const ever = { apps: new Set(), tokens: new Set() };
  const record = { testedAt: new Date().toISOString(), name, profile, tools: {}, inventory: {}, api: [], phases: [] };
  let origin;
  let workerId;
  const audDigests = new Map();

  // cf caches the account under ./.cloudflare; running in temp keeps that out of the checkout.
  const cfArgs = (args, body) => ["--profile", profile, ...args, ...(body ? ["--body", JSON.stringify(body)] : [])];
  const cfRun = (args) => run(cfBin, cfArgs(args), { cwd: temp, timeoutMs: 120000 });
  const cfJson = (args, schema, body) => runJson(cfBin, cfArgs(args, body), schema, { cwd: temp, timeoutMs: 120000 });

  async function rememberAud(label, aud) {
    if (typeof aud !== "string" || !aud) return;
    const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(aud)));
    audDigests.set(Array.from(bytes.slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join(""), label);
  }

  function redact(value) {
    let text = JSON.stringify(value);
    if (origin) text = text.replaceAll(new URL(origin).host, "<probe-host>");
    if (workerId) text = text.replaceAll(workerId, "<probe-worker-id>");
    return JSON.parse(text);
  }

  async function listApps() {
    const apps = [];
    for (let page = 1; page < 50; page++) {
      const response = await cfJson(
        ["zero-trust", "access", "applications", "list", "--per-page", "100", "--page", String(page)],
        appListSchema,
      );
      if (!response.ok) throw new ProbeError("could not list Access applications", response);
      apps.push(...response.value);
      if (response.value.length < 100) break;
    }
    return apps;
  }

  async function listProbeTokens() {
    const response = await cfJson(
      ["zero-trust", "access", "service-tokens", "list", "--search", name],
      tokenListSchema,
    );
    if (!response.ok) throw new ProbeError("could not list service tokens", response);
    return response.value.filter((token) => token.name === `${name}-token` || ever.tokens.has(token.id));
  }

  async function searchWorkers(flag, value) {
    const response = await cfJson(["workers", "scripts", "search", flag, value], workerSearchSchema);
    if (!response.ok) throw new ProbeError("could not search Workers", response);
    return flag === "--id" ? response.value : response.value.filter((w) => (w.script_name ?? w.name) === name);
  }

  // Retries until a successful lookup confirms absence. A failed lookup is
  // retried, never taken as proof that the resource is gone.
  async function confirmGone(label, present) {
    let last;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        if (!(await present())) return;
        last = new ProbeError(`${label} still present after delete`);
      } catch (error) {
        last = error instanceof ProbeError ? error : new ProbeError(`${label}: lookup failed`);
      }
      await wait(1000);
    }
    throw last;
  }

  // Without --force, cf asks for confirmation and exits 0 without deleting when
  // stdin is not a terminal, so every delete is forced and then verified. The
  // delete's own result is not trusted either way; only a confirmed absence is.
  async function deleteApp(appId) {
    await cfRun(["zero-trust", "access", "applications", "delete", appId, "--force"]);
    await confirmGone(`Access application ${appId}`, async () => (await listApps()).some((app) => app.id === appId));
    created.apps = created.apps.filter((tracked) => tracked !== appId);
  }

  async function deleteToken(tokenId) {
    await cfRun(["zero-trust", "access", "service-tokens", "delete", tokenId, "--force"]);
    await confirmGone(`service token ${tokenId}`, async () =>
      (await listProbeTokens()).some((token) => token.id === tokenId),
    );
    if (created.serviceToken === tokenId) created.serviceToken = undefined;
  }

  async function deleteWorker(scriptId) {
    await cfRun(["workers", "delete", scriptId, "--force"]);
    await confirmGone(`Worker ${scriptId}`, async () => (await searchWorkers("--id", scriptId)).length > 0);
  }

  async function createApp(label, body) {
    const response = await cfJson(["zero-trust", "access", "applications", "create"], S.cf(appSchema), body);
    if (response.ok) {
      created.apps.push(response.value.id);
      ever.apps.add(response.value.id);
    }
    const { ok, exitCode, timedOut, status, code, slug, unexpectedOutput } = response;
    const entry = {
      label,
      request: redact({ ...body, policies: body.policies?.map((p) => p.decision) }),
      accepted: ok,
      failure: ok ? undefined : { exitCode, timedOut, status, code, slug, unexpectedOutput },
      storedDestinations: ok ? redact(response.value.destinations ?? null) : undefined,
      storedDomain: ok && response.value.domain ? redact(response.value.domain) : undefined,
      storedSelfHostedDomains: ok ? redact(response.value.self_hosted_domains ?? null) : undefined,
    };
    record.api.push(entry);
    console.log(JSON.stringify(entry));
    return ok ? response.value : undefined;
  }

  const source = `
const PROBE_RUN = ${JSON.stringify(runId)};
const SERVICE_MARKERS = ${JSON.stringify(MARKERS)};
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
    const response = await runText("curl", args, httpSchema(runId, origin), { timeoutMs: 30000 });
    const row = { path, credential, method };
    if (!response.ok)
      return { ...row, outcome: "client-error", exitCode: response.exitCode, timedOut: response.timedOut };
    const seen = response.value;
    row.status = seen.status;
    if (seen.worker) {
      const { access, ...view } = seen.worker;
      if (access.audDigest) {
        access.audApplication = audDigests.get(access.audDigest) ?? "unknown";
        delete access.audDigest;
      }
      const received = view.pathname + view.search;
      delete view.pathname;
      delete view.search;
      delete view.method;
      return { ...row, outcome: "worker", received, access, ...view };
    }
    // Unauthenticated requests get Access's 403 page here because the probe's
    // only allow policy is a service token; an identity policy would redirect.
    row.outcome =
      seen.status === 302 && seen.locationKind === "access-login"
        ? "access-login"
        : seen.status === 403 && seen.accessPage
          ? "access-denied"
          : "edge-error";
    if (seen.locationKind) row.location = seen.locationKind;
    if (row.outcome === "edge-error" && seen.edgeCode) row.edgeCode = seen.edgeCode;
    return row;
  }

  const denied = (row) => row.outcome === "access-denied" || row.outcome === "access-login";
  const reachesWorker = (application) => (row) =>
    row.outcome === "worker" && (application === undefined || row.access.audApplication === application);

  // Edge errors (1104, 1042, 1043) appeared while configuration propagated, and
  // one path was still refused 30 seconds after another was bypassed. A state
  // counts only when every positive and negative control matches together for
  // `streak` consecutive rounds.
  async function converge(label, controls, streak = 3) {
    const started = Date.now();
    let matched = 0;
    for (let attempt = 0; attempt < 120; attempt++) {
      let all = true;
      for (const control of controls)
        if (!control.expect(await request(control.path, control))) {
          all = false;
          break;
        }
      matched = all ? matched + 1 : 0;
      if (matched === streak) {
        console.log(`${label}: stable after ${Math.round((Date.now() - started) / 1000)}s`);
        return Date.now() - started;
      }
      await wait(all ? 1000 : 5000);
    }
    throw new ProbeError(`${label}: controls never converged`);
  }

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

  async function save() {
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(record, null, 2) + "\n");
  }

  async function phase(label, cases) {
    const rows = [];
    for (const spec of cases) rows.push(await request(spec.path, spec));
    record.phases.push({ label, rows });
    console.log(`${label}:`);
    for (const row of rows)
      console.log(
        `  ${row.method} ${row.path} [${row.credential}] -> ${row.status ?? "-"} ${row.outcome}${row.received ? ` ${row.received} access=${JSON.stringify(row.access)}` : ""}`,
      );
    await save();
    return rows;
  }

  let beforeIds;
  try {
    const cfVersion = await runText(cfBin, ["--version"], versionSchema);
    const curlVersion = await runText("curl", ["--version"], versionSchema);
    record.tools = {
      cf: cfVersion.ok ? cfVersion.value : "unknown",
      buildWrangler,
      node: process.version,
      curl: curlVersion.ok ? curlVersion.value : "unknown",
    };

    const before = await listApps();
    beforeIds = new Set(before.map((app) => app.id));
    record.inventory.before = { count: before.length };
    if (before.some((app) => app.name.startsWith("connecta-probe-")))
      throw new ProbeError("a connecta-probe- Access application already exists; clean it up first");
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
    const install = await run("npm", ["install", "--no-audit", "--no-fund", "--silent"], {
      cwd: project,
      timeoutMs: 300000,
    });
    if (!install.ok) throw new ProbeError("could not install the build Wrangler", install);
    created.worker = true;
    // cf deploy printed "Deploy complete" and then stayed running on
    // 2026-10-15, so the runner stops it on that line.
    const originPattern = new RegExp(`https://${name}\\.[a-zA-Z0-9-]+\\.workers\\.dev`);
    const deployment = await runText(
      cfBin,
      ["--profile", profile, "deploy"],
      (text) => ({ origin: text.match(originPattern)?.[0] ?? bad() }),
      { cwd: project, timeoutMs: 300000, until: /Deploy complete/, combined: true },
    );
    if (!deployment.ok) throw new ProbeError("cf deploy failed or returned no workers.dev URL", deployment);
    origin = deployment.value.origin;
    const host = new URL(origin).host;
    workerId = (await searchWorkers("--name", name))[0]?.id;
    if (!workerId) throw new ProbeError("could not resolve the probe Worker id");
    console.log("Deployed <probe-host>");
    record.compatibilityDate = "2026-09-01";
    await converge("worker reachable", [
      { path: "/mcp", expect: reachesWorker() },
      { path: "/agent/x", expect: reachesWorker() },
    ]);
    await phase("baseline: no Access application", [{ path: "/mcp" }, { path: "/agent/x" }]);

    const token = await cfJson(
      ["zero-trust", "access", "service-tokens", "create", "--name", `${name}-token`, "--duration", "1h"],
      tokenCreateSchema,
    );
    // A token whose response was lost is still found by name in teardown.
    if (!token.ok) throw new ProbeError("could not create service token", token);
    created.serviceToken = token.value.id;
    ever.tokens.add(token.value.id);
    await writeFile(
      tokenHeaders,
      `CF-Access-Client-Id: ${token.value.client_id.reveal()}\nCF-Access-Client-Secret: ${token.value.client_secret.reveal()}\n`,
      { mode: 0o600 },
    );

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
    if (!workerApp) throw new ProbeError("Worker-level Access application was refused");
    await rememberAud("worker-level", workerApp.aud);
    const workerLevelControls = [
      { path: "/mcp", expect: denied },
      { path: "/agent/x", expect: denied },
      { path: "/", expect: denied },
      { path: "/mcp", credential: "service-token", expect: reachesWorker("worker-level") },
    ];
    record.propagation = { workerLevelMs: await converge("worker-level Access active", workerLevelControls) };
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
        await deleteApp(app.id);
        // An accepted variant may have bypassed the whole Worker; wait until it is gone.
        await converge("variant removed", workerLevelControls);
      }
    }

    const pathApp = await createApp("path application", {
      type: "self_hosted",
      name: `${name}-agent`,
      destinations: [{ type: "public", uri: `${host}/agent/*` }],
      session_duration: "1h",
      policies: bypass,
    });
    if (!pathApp) throw new ProbeError("path-scoped bypass application was refused");
    await rememberAud("path", pathApp.aud);
    // Positive and negative controls must converge together before recording.
    record.propagation.pathBypassMs = await converge(
      "path bypass active",
      [
        { path: "/agent/x", expect: reachesWorker("path") },
        { path: "/agent/simon-zack", expect: reachesWorker("path") },
        { path: "/mcp", expect: denied },
        { path: "/", expect: denied },
        { path: "/mcp", credential: "service-token", expect: reachesWorker("worker-level") },
      ],
      5,
    );
    const rounds = [];
    for (const round of [1, 2, 3])
      rounds.push(
        await phase(`worker-level plus /agent/* bypass, round ${round}`, [
          ...PATHS.map((path) => ({ path })),
          { path: "/agent/x", method: "POST", credential: "bearer" },
          { path: "/agent/x", credential: "service-token" },
          { path: "/agent/x", credential: "forged-assertion" },
          { path: "/mcp", credential: "service-token" },
          { path: "/mcp", credential: "bearer" },
          { path: "/", credential: "service-token" },
        ]),
      );
    const summary = (row) => `${row.outcome}|${row.received ?? ""}|${row.access?.audApplication ?? ""}`;
    record.roundsConsistent = rounds.every((rows) => rows.every((row, i) => summary(row) === summary(rounds[0][i])));

    await deleteApp(pathApp.id);
    record.propagation.pathRemovalMs = await converge("path bypass removed", workerLevelControls);
    await phase("after removing the path application", [{ path: "/agent/x" }, { path: "/mcp" }]);
  } catch (error) {
    failures.push(error);
    record.error = describe(error);
  } finally {
    const attempt = async (step) => {
      try {
        await step();
      } catch (error) {
        failures.push(error);
      }
    };
    // Tracked ids first, each deleted on its own, with no dependency on discovery.
    for (const appId of [...created.apps].reverse()) await attempt(() => deleteApp(appId));
    if (created.serviceToken) await attempt(() => deleteToken(created.serviceToken));
    if (workerId) await attempt(() => deleteWorker(workerId));
    // Then discovery by name, for resources whose create response was lost.
    if (created.worker || ever.apps.size || ever.tokens.size || record.inventory.before) {
      let discovered = false;
      for (let round = 0; round < 3 && !discovered; round++) {
        try {
          for (const app of await listApps()) if (app.name.startsWith(name)) await deleteApp(app.id);
          for (const token of await listProbeTokens()) {
            ever.tokens.add(token.id);
            await deleteToken(token.id);
          }
          for (const worker of await searchWorkers("--name", name)) await deleteWorker(worker.id);
          discovered = true;
        } catch {
          await wait(2000);
        }
      }
      if (!discovered) failures.push(new ProbeError("leftover discovery by name did not complete"));
    }
    try {
      const after = await listApps();
      const afterIds = new Set(after.map((app) => app.id));
      const byName = await searchWorkers("--name", name);
      const byId = workerId ? await searchWorkers("--id", workerId) : [];
      record.inventory.after = {
        count: after.length,
        nonProbeIdsUnchanged:
          beforeIds !== undefined &&
          afterIds.size === beforeIds.size &&
          [...beforeIds].every((appId) => afterIds.has(appId)),
        probeApplicationsRemaining: after.filter(
          (app) => ever.apps.has(app.id) || app.name.startsWith("connecta-probe-"),
        ).length,
        probeWorkersRemaining: byName.length + byId.length,
        probeServiceTokensRemaining: (await listProbeTokens()).length,
      };
      const inventory = record.inventory;
      if (
        inventory.after.count !== inventory.before?.count ||
        !inventory.after.nonProbeIdsUnchanged ||
        inventory.after.probeApplicationsRemaining !== 0 ||
        inventory.after.probeWorkersRemaining !== 0 ||
        inventory.after.probeServiceTokensRemaining !== 0
      )
        failures.push(new ProbeError("teardown verification failed; see the inventory in the observations"));
      console.log(`Inventory: ${JSON.stringify(inventory)}`);
    } catch (error) {
      failures.push(error);
      record.inventory.after = "unverified";
    }
    await save();
    await rm(temp, { recursive: true, force: true });
  }
  for (const failure of failures) console.error(`probe: ${describe(failure)}`);
  if (failures.length) process.exitCode = 1;
}

const argv = process.argv.slice(2);
try {
  if (argv.includes("--self-test")) await selfTest();
  else await probe(argv);
} catch (error) {
  console.error(`probe: ${describe(error)}`);
  process.exitCode = 1;
}
