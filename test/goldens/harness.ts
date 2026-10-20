// Characterization goldens for every maintained `api()` provider: the oracle a
// provider migration must match byte for byte. A spec says how to build the
// provider and which fixture calls to make; this harness owns everything else
// (the fetch fake, the fixed clock and ids, secret placeholders and leak
// checks, failure cases, and the JSON layout), so a migration changes the
// provider, never the golden.
import { vi } from "vitest";
import { CatalogService } from "../../src/catalog-service.js";
import { CredentialVault } from "../../src/credentials.js";
import { InvocationService, type InvocationOutcome } from "../../src/invocation.js";
import { Registry } from "../../src/registry.js";
import { connectorGuide, connectorGuideSummary } from "../../src/skills.js";
import { memoryStorage } from "../../src/storage/memory.js";
import { classifyTool } from "../../src/tool-safety.js";
import { CONNECTA_VERSION } from "../../src/version.js";
import type { Connector, ConnectorContext, ToolDef } from "../../src/types.js";
import { silentLogger } from "../helpers.js";

export const GOLDEN_BASE_URL = "https://connecta.example";
/** 2026-01-02T03:04:05.000Z: every clock read during a golden sees this instant. */
export const GOLDEN_NOW = Date.UTC(2026, 0, 2, 3, 4, 5);
const SEAL_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

/** One reply from the fake network. `body` is sent as JSON; `text` verbatim. */
export interface StubResponse {
  status?: number;
  body?: unknown;
  text?: string;
  headers?: Record<string, string>;
}

/** What the fake network saw, before redaction. */
export interface SeenRequest {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: unknown;
}

/** A reply source: a queue consumed in order, or a router over the request. */
export type Replies = readonly StubResponse[] | ((request: SeenRequest, index: number) => StubResponse | undefined);

export interface GoldenCall {
  /** Distinguishes several calls of one tool; defaults to the tool name. */
  label?: string;
  tool: string;
  args?: Record<string, unknown>;
  /** Replies to the provider's requests; an unanswered request gets `200 {}`. */
  replies?: Replies;
}

export interface GoldenFailureCall extends GoldenCall {
  /**
   * Requests before this index get the call's `replies`; it and every later
   * request get the failure. Defaults to 0, the first request.
   */
  failAt?: number;
}

/**
 * A request the harness answers itself: a token exchange or other request
 * that is not the tool's own. It is recorded under its name with its headers
 * and body, so a changed credential, assertion, or scope changes the golden.
 */
export interface AuxiliaryRoute {
  /** The name recorded in place of the request, e.g. `token`. */
  name: string;
  match(request: SeenRequest): boolean;
  reply: StubResponse | ((request: SeenRequest) => StubResponse);
}

export interface GoldenSpec {
  /** Provider folder under `src/providers/` and golden folder under `test/goldens/`. */
  provider: string;
  /**
   * A fresh connector; called once per scenario. `scenario` is a slug unique
   * in the process: the scenario's name (`catalog`, a call's label,
   * `read-401-echo`) and a per-capture suffix the goldens never show, for
   * specs that must defeat a process-wide cache without a counter.
   */
  create(scenario: string): Connector;
  /**
   * The vault credential: one value, or named fields. Each value is replaced
   * by `<secret:field>` wherever it appears in a golden.
   */
  credential?: string | Record<string, string>;
  /** Further secrets the deployment configures (client secrets, private keys). */
  secrets?: Record<string, string>;
  /**
   * Secrets a tool call never sends, such as a private key that only signs or
   * a client secret used only at consent. Vendors echo every other credential
   * and secret in the echo fixtures. No secret may reach a result, sent or not.
   */
  unsent?: readonly string[];
  /**
   * HTTP Basic pairs the provider sends, as `[user, password]` secret names.
   * The echo also carries each pair's base64, the bytes an echoed
   * Authorization header would show.
   */
  basic?: readonly (readonly [user: string, password: string])[];
  /** Token exchanges and other requests that are not the tool's own. */
  auxiliary?: readonly AuxiliaryRoute[];
  /**
   * Runs before every scenario on the connector's registry context, e.g. to
   * complete an OAuth consent. Its requests reach `auxiliary` routes (others
   * get `200 {}`). They are recorded once, in `setup.json`, and must be the
   * same for every scenario.
   */
  setup?(connector: Connector, ctx: ConnectorContext): Promise<void>;
  /** At least one representative call per tool. */
  calls: readonly GoldenCall[];
  /**
   * A call whose success reply carries `text` into the caller-visible
   * result. The harness passes every sent secret in `text`, in each of its
   * `secretEncodings` and as each `basic` pair, as a vendor that echoes a
   * credential would, and records the call last in `calls.json`.
   */
  echo: Omit<GoldenCall, "label" | "replies"> & { replies(text: string): Replies };
  /** One read and one write tool driven through every failure status. */
  failures: { read: GoldenFailureCall; write: GoldenFailureCall };
  /**
   * The vendor's error body for a failure status, carrying `message` where
   * the vendor puts its prose; defaults to a generic JSON body. The `401 echo`
   * case passes a message that echoes every sent secret.
   */
  failureReply?: (status: number, message: string) => StubResponse;
}

export function defineGoldenSpec(spec: GoldenSpec): GoldenSpec {
  return spec;
}

/**
 * Failure cases every golden drives: each status, a 401 whose message echoes
 * every sent secret, a refused connection, and a transport timeout (what
 * `AbortSignal.timeout` rejects with once a request has left).
 */
export const FAILURE_CASES = [
  "400",
  "401",
  "401 echo",
  "403",
  "404",
  "409",
  "422",
  "429",
  "500",
  "network",
  "timeout",
] as const;
/** The `retry-after` every 429 carries, in seconds. */
export const GOLDEN_RETRY_AFTER_SECONDS = 7;

function defaultFailureReply(status: number, message: string): StubResponse {
  return { status, body: { error: { code: `golden_${status}`, message } } };
}

// ---------------------------------------------------------------------------
// Determinism

/**
 * Fix the clock and the ids for one capture. Only `Date` is faked, so timers
 * still run. `crypto.randomUUID` counts, and `crypto.getRandomValues` and
 * `Math.random` are fixed sequences; all restart for every scenario, so adding
 * or reordering a call never moves another call's ids, states, or verifiers.
 */
function deterministic(): { restart(): void; restore(): void } {
  vi.useFakeTimers({ now: GOLDEN_NOW, toFake: ["Date"] });
  let uuid = 0;
  const randomUUID = vi
    .spyOn(crypto, "randomUUID")
    .mockImplementation(
      () => `00000000-0000-4000-8000-${(++uuid).toString(16).padStart(12, "0")}` as ReturnType<Crypto["randomUUID"]>,
    );
  let byte = 0;
  const randomValues = vi.spyOn(crypto, "getRandomValues").mockImplementation((array) => {
    const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    for (let index = 0; index < bytes.length; index++) bytes[index] = byte++ & 0xff;
    return array;
  });
  let seed = 0;
  const random = vi.spyOn(Math, "random").mockImplementation(() => (seed = (seed * 9301 + 49297) % 233280) / 233280);
  return {
    restart() {
      uuid = 0;
      byte = 0;
      seed = 0;
      vi.setSystemTime(GOLDEN_NOW);
    },
    restore() {
      randomUUID.mockRestore();
      randomValues.mockRestore();
      random.mockRestore();
      vi.useRealTimers();
    },
  };
}

// ---------------------------------------------------------------------------
// The fake network

// Fetch picks a random boundary for FormData; other multipart framing is the provider's own.
const FORM_DATA_BOUNDARY = /^(multipart\/form-data;\s*boundary=).*$/i;

async function bodyOf(request: Request): Promise<unknown> {
  if (request.body === null) return undefined;
  const type = request.headers.get("content-type") ?? "";
  if (FORM_DATA_BOUNDARY.test(type)) {
    const entries: unknown[] = [];
    for (const [name, value] of (await request.formData()).entries()) {
      entries.push(
        typeof value === "string"
          ? [name, value]
          : [name, { file: value.name, type: value.type, text: await value.text() }],
      );
    }
    return { formData: entries };
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return { base64: btoa(binary) };
  }
  if (/^application\/x-www-form-urlencoded\b/i.test(type)) {
    // Fields when they re-encode to the exact bytes sent, so nothing is lost.
    const form = new URLSearchParams(text);
    if (form.toString() === text) return { form: [...form] };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return text;
  }
  // `json` alone means the body is exactly its compact serialization; any other
  // spacing, key order, number spelling, or escape keeps the exact text too.
  return JSON.stringify(json) === text ? { json } : { json, text };
}

/**
 * The request exactly as `fetch(input, init)` sends it: `new Request` applies
 * Fetch's rules, so `init.headers` replaces a Request's headers rather than
 * merging with them, and a body gets its implied `content-type`.
 */
async function seen(input: unknown, init?: RequestInit): Promise<SeenRequest> {
  const request = new Request(input as RequestInfo | URL, init);
  const sorted: Record<string, string> = {};
  for (const name of [...request.headers.keys()].sort()) {
    const value = request.headers.get(name)!;
    // The parts are recorded instead of the runtime's boundary.
    sorted[name] = name === "content-type" ? value.replace(FORM_DATA_BOUNDARY, "$1<boundary>") : value;
  }
  return { method: request.method, url: new URL(request.url), headers: sorted, body: await bodyOf(request) };
}

function respond(reply: StubResponse): Response {
  const text = reply.text ?? (reply.body === undefined ? "{}" : JSON.stringify(reply.body));
  const status = reply.status ?? 200;
  const headers = new Headers(reply.headers);
  if (reply.text === undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  return new Response(status === 204 || status === 304 ? null : text, { status, headers });
}

/** A runtime-shaped transport failure: what a refused connection rejects with. */
function networkFailure(): Error {
  return new TypeError("fetch failed", {
    cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
  });
}

/** What a request rejects with when its `AbortSignal.timeout` fires after it left. */
function timeoutFailure(): Error {
  return new DOMException("The operation was aborted due to timeout", "TimeoutError");
}

interface Recorded {
  request: SeenRequest;
  auxiliary?: string;
}

type Answer = (request: SeenRequest, index: number) => StubResponse | "network" | "timeout";

/** Test-only: wraps the fake network, standing in for a provider that calls fetch differently. */
export type FetchSeam = (send: typeof fetch) => typeof fetch;

/** Test-only scheduling noise for the fake network, from a seeded generator. */
interface Jitter {
  /** An integer in [0, bound). */
  below(bound: number): number;
}

function jitterFrom(seed: number): Jitter {
  // mulberry32: independent of the faked Math.random.
  let state = seed >>> 0;
  return {
    below(bound) {
      state = (state + 0x6d2b79f5) >>> 0;
      let mixed = Math.imul(state ^ (state >>> 15), state | 1);
      mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
      return Math.floor((((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296) * bound);
    },
  };
}

async function microtasks(count: number): Promise<void> {
  for (let left = count; left > 0; left--) await Promise.resolve();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Timer turns with no new request before a batch is answered. */
const QUIET_TURNS = 2;

interface Waiting {
  request: SeenRequest;
  /** Method, URL, headers, and body: the order requests in one batch are recorded and answered in. */
  key: string;
  resolve(response: Response): void;
  reject(error: Error): void;
}

/**
 * The fake network holds every request until the provider has gone quiet,
 * then records and answers the batch in canonical order. A batch is one
 * causal step: the requests sent before any of them was answered, which is
 * what concurrent requests are, sorted by method, URL, headers, and body.
 * Sequential requests are each their own batch, so a token exchange before
 * its call, a retry after its failure, and a write's single attempt keep the
 * order they were sent in. `jitter` reorders arrivals, delays answers, and
 * answers a batch in a shuffled order, none of which may change a golden.
 */
function installFetch(
  spec: GoldenSpec,
  answer: Answer,
  options: { seam?: FetchSeam; jitter?: Jitter },
): { recorded: Recorded[]; settled(): Promise<void>; restore(): void } {
  const { seam, jitter } = options;
  const recorded: Recorded[] = [];
  const realFetch = globalThis.fetch;
  let index = 0;
  let started = 0;
  let queued = 0;
  let waiting: Waiting[] = [];
  let flushing: Promise<void> | undefined;
  const flush = async () => {
    for (let quiet = 0; quiet < QUIET_TURNS;) {
      const before = started;
      await sleep(0);
      quiet = started === before && queued === started ? quiet + 1 : 0;
    }
    if (jitter) await sleep(jitter.below(3));
    const batch = waiting.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    waiting = [];
    flushing = undefined;
    const settle: (() => void)[] = batch.map((entry) => {
      const { request } = entry;
      const route = spec.auxiliary?.find((candidate) => candidate.match(request));
      if (route) {
        recorded.push({ request, auxiliary: route.name });
        const response = respond(typeof route.reply === "function" ? route.reply(request) : route.reply);
        return () => entry.resolve(response);
      }
      recorded.push({ request });
      const reply = answer(request, index++);
      if (reply === "network") return () => entry.reject(networkFailure());
      if (reply === "timeout") return () => entry.reject(timeoutFailure());
      const response = respond(reply);
      return () => entry.resolve(response);
    });
    if (!jitter) {
      for (const release of settle) release();
      return;
    }
    for (let left = settle.length; left > 0; left--) {
      const [release] = settle.splice(jitter.below(left), 1);
      release!();
      await microtasks(jitter.below(4));
    }
  };
  const fake = (async (input: unknown, init?: RequestInit) => {
    started++;
    let request: SeenRequest;
    try {
      request = await seen(input, init);
    } catch (error) {
      started--;
      throw error;
    }
    if (jitter) await microtasks(jitter.below(8));
    const { method, url, headers, body } = request;
    const key = JSON.stringify([method, url.href, headers, body ?? null]);
    const response = new Promise<Response>((resolve, reject) => waiting.push({ request, key, resolve, reject }));
    queued++;
    flushing ??= flush();
    return response;
  }) as typeof fetch;
  globalThis.fetch = seam ? seam(fake) : fake;
  return {
    recorded,
    async settled() {
      while (flushing) await flushing;
    },
    restore() {
      globalThis.fetch = realFetch;
    },
  };
}

function fromReplies(replies: Replies | undefined): (request: SeenRequest, index: number) => StubResponse {
  if (typeof replies === "function") return (request, index) => replies(request, index) ?? {};
  return (_request, index) => replies?.[index] ?? {};
}

// ---------------------------------------------------------------------------
// Running a call the way an agent does

async function registryFor(spec: GoldenSpec, connector: Connector): Promise<Registry> {
  const storage = memoryStorage();
  const credentialVault = new CredentialVault(storage, SEAL_KEY);
  if (spec.credential !== undefined) {
    const values = typeof spec.credential === "string" ? { value: spec.credential } : spec.credential;
    await credentialVault.setAll(connector.id, values, "golden");
  }
  return new Registry([connector], { storage, logger: silentLogger, credentialVault });
}

function outcome(result: InvocationOutcome<unknown>): unknown {
  return result.ok
    ? { ok: true, format: result.format, value: result.value }
    : {
        ok: false,
        dispatched: result.dispatched,
        ...(result.answered ? { answered: true } : {}),
        error: result.error,
      };
}

const JWT = /^((?:Bearer|token) )?(eyJ[\w-]*)\.(eyJ[\w-]*)\.[\w-]+$/;

function base64UrlJson(segment: string): unknown {
  const padded = segment
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(segment.length / 4) * 4, "=");
  const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

/**
 * A JWT anywhere in a request (a bearer header, an assertion form field)
 * becomes its decoded header and claims, so its issuer, subject, scope,
 * audience, and lifetime are characterized. Its signature comes from a key
 * generated per run, so only its presence is.
 */
function decodeJwts(value: unknown): unknown {
  if (typeof value === "string") {
    const match = JWT.exec(value);
    if (!match) return value;
    try {
      return {
        ...(match[1] ? { scheme: match[1].trim() } : {}),
        jwt: { header: base64UrlJson(match[2]!), claims: base64UrlJson(match[3]!), signature: "<signature>" },
      };
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) return value.map(decodeJwts);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, decodeJwts(entry)]));
  return value;
}

function requestRecord(entry: Recorded): unknown {
  const { request } = entry;
  return decodeJwts({
    ...(entry.auxiliary ? { auxiliary: entry.auxiliary } : {}),
    method: request.method,
    url: request.url.href,
    headers: request.headers,
    ...(request.body !== undefined ? { body: request.body } : {}),
  });
}

/** One capture's fixed inputs, and the setup requests every scenario must repeat. */
interface Capture {
  spec: GoldenSpec;
  restart(): void;
  /** Every credential field and secret, by the name its placeholder shows. */
  secrets: Record<string, string>;
  /** What a vendor echoing every sent secret, in every encoding, says. */
  echo: string;
  /**
   * What a vendor error echoing every sent secret says: raw only, because
   * some providers cap a vendor message before redaction sees it (Google at
   * 500 characters), and a cut through a secret leaks its first part.
   */
  errorEcho: string;
  /** Appended to every scenario slug and removed from the goldens: unique to this capture in the process. */
  nonce: string;
  seam?: FetchSeam;
  jitter?: Jitter;
  setup?: string;
}

function base64(value: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Every encoding a vendor might echo a sent secret in, and that sent-secret
 * redaction covers: raw, percent-encoded with upper- and lowercase hex,
 * base64, unpadded base64url, and JSON `\uXXXX` escapes with upper- and
 * lowercase hex. Percent and `\u` hex digits are case-insensitive; base64 and
 * the secret itself are not, so no case variant of them is the same secret.
 */
export function secretEncodings(value: string): string[] {
  const percent = encodeURIComponent(value);
  const encoded = base64(value);
  const escaped = [...Array(value.length).keys()]
    .map((at) => `\\u${value.charCodeAt(at).toString(16).padStart(4, "0")}`)
    .join("");
  return [
    ...new Set([
      value,
      percent,
      percent.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase()),
      encoded,
      encoded.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
      escaped,
      escaped.toUpperCase().replace(/\\U/g, "\\u"),
    ]),
  ];
}

/**
 * The shortest start of a secret the leak guard treats as the secret, so a
 * truncated echo still leaks. Longer than public token-format prefixes such
 * as `sk_test_` or `github_pat_`, which guides and fixtures may print.
 */
export const LEAK_PREFIX_UNITS = 12;

const SHORT_ESCAPES: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

function fromBase64(run: string): string {
  const normalized = run.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  const usable = normalized.slice(0, normalized.length - (normalized.length % 4 === 1 ? 1 : 0));
  try {
    return new TextDecoder().decode(
      Uint8Array.from(atob(usable.padEnd(Math.ceil(usable.length / 4) * 4, "=")), (char) => char.charCodeAt(0)),
    );
  } catch {
    return "";
  }
}

/** One layer of each encoding a secret can hide in, decoded wherever it occurs. */
const DECODERS: readonly ((text: string) => string)[] = [
  (text) =>
    text.replace(/\\(?:u([0-9a-fA-F]{4})|(["\\/bfnrt]))/g, (_whole, unit: string | undefined, short: string) =>
      unit ? String.fromCharCode(Number.parseInt(unit, 16)) : SHORT_ESCAPES[short]!,
    ),
  (text) =>
    text.replace(/(?:%[0-9a-fA-F]{2})+/g, (run) =>
      new TextDecoder().decode(Uint8Array.from(run.slice(1).split("%"), (pair) => Number.parseInt(pair, 16))),
    ),
  // A run may start inside its encoding, so it is decoded at every alignment.
  (text) =>
    (text.match(/[A-Za-z0-9+/_-]{11,}={0,2}/g) ?? [])
      .flatMap((run) => [0, 1, 2, 3].map((offset) => fromBase64(run.slice(offset))))
      .join("\n"),
];
const DECODE_LAYERS = 3;

/**
 * The secret a caller-visible value leaks, or undefined. The guard decodes
 * the value itself rather than trusting redaction's list of forms: JSON
 * escapes, percent escapes in either hex case, and base64 or base64url runs
 * at any alignment, nested up to three layers. It finds any start of a
 * secret at least `LEAK_PREFIX_UNITS` long, so a truncated echo leaks too.
 * Shorter fragments, fragments that do not start the secret, and a secret
 * whose case was changed are not detected.
 */
export function leakedSecret(value: unknown, secrets: Record<string, string>): string | undefined {
  const views = new Set([JSON.stringify(value) ?? ""]);
  let layer = [...views];
  for (let depth = 0; depth < DECODE_LAYERS && layer.length; depth++) {
    const next: string[] = [];
    for (const view of layer) {
      for (const decode of DECODERS) {
        const decoded = decode(view);
        if (!views.has(decoded)) {
          views.add(decoded);
          next.push(decoded);
        }
      }
    }
    layer = next;
  }
  for (const [name, secret] of Object.entries(secrets)) {
    const start = secret.slice(0, LEAK_PREFIX_UNITS);
    if (start && [...views].some((view) => view.includes(start))) return name;
  }
  return undefined;
}

/**
 * Credentials stay home (INV-5): no secret, sent or not, reaches a result in
 * any form. Checked on the raw outcome, before placeholders are applied, so a
 * placeholder can never hide a leak.
 */
function assertNoLeak(capture: Capture, where: string, value: unknown): void {
  const name = leakedSecret(value, capture.secrets);
  if (name !== undefined) {
    throw new Error(`${capture.spec.provider} ${where}: the caller-visible result leaks <secret:${name}>`);
  }
}

function slug(where: string): string {
  return where
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

async function run(capture: Capture, where: string, call: GoldenCall, answer: Answer) {
  const { spec } = capture;
  capture.restart();
  const connector = spec.create(slug(where) + capture.nonce);
  const registry = await registryFor(spec, connector);
  const tools =
    connector.staticTools ?? (await connector.listTools(registry.contextFor(connector.id, GOLDEN_BASE_URL)));
  const tool = tools.find((candidate) => candidate.name === call.tool);
  if (!tool) throw new Error(`${spec.provider}: no tool "${call.tool}"`);
  const write = classifyTool(tool) !== "read";
  if (spec.setup) {
    const consent = installFetch(spec, () => ({}), capture);
    try {
      await spec.setup(connector, registry.contextFor(connector.id, GOLDEN_BASE_URL));
      await consent.settled();
    } finally {
      consent.restore();
    }
    const setup = JSON.stringify(consent.recorded.map(requestRecord));
    if (capture.setup !== undefined && setup !== capture.setup) {
      throw new Error(`${spec.provider} ${where}: setup sent different requests than the first scenario`);
    }
    capture.setup = setup;
  }
  const network = installFetch(spec, answer, capture);
  try {
    const result = await new InvocationService(registry, new CatalogService(registry, GOLDEN_BASE_URL)).invoke(
      `${connector.id}.${call.tool}`,
      call.args ?? {},
      { source: write ? "call_destructive_tool" : "call_tool", readOnly: false },
    );
    await network.settled();
    const visible = outcome(result);
    assertNoLeak(capture, where, visible);
    return { requests: network.recorded.map(requestRecord), result: visible };
  } finally {
    network.restore();
    registry.closeCallAdmission();
  }
}

// ---------------------------------------------------------------------------
// The three goldens

function toolRecord(tool: ToolDef): unknown {
  return {
    name: tool.name,
    ...(tool.title !== undefined ? { title: tool.title } : {}),
    description: tool.description,
    inputSchema: tool.inputSchema,
    ...(tool.outputSchema !== undefined ? { outputSchema: tool.outputSchema } : {}),
    ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
  };
}

async function catalog(capture: Capture): Promise<unknown> {
  const { spec } = capture;
  capture.restart();
  const connector = spec.create(`catalog${capture.nonce}`);
  const registry = await registryFor(spec, connector);
  try {
    const tools = await connector.listTools(registry.contextFor(connector.id, GOLDEN_BASE_URL));
    const record = {
      id: connector.id,
      kind: connector.kind,
      title: connector.title,
      description: connector.description,
      ...(connector.credential ? { credential: connector.credential } : {}),
      ...(connector.classification ? { classification: connector.classification } : {}),
      guide: { summary: connectorGuideSummary(connector), content: connectorGuide(connector) },
      tools: tools.map(toolRecord),
    };
    assertNoLeak(capture, "catalog", record);
    return record;
  } finally {
    registry.closeCallAdmission();
  }
}

function echoCall(capture: Capture): GoldenCall {
  const { echo } = capture.spec;
  return { ...echo, label: `${echo.tool} echoes sent secrets`, replies: echo.replies(capture.echo) };
}

async function calls(capture: Capture): Promise<unknown> {
  const rows = [];
  const labels = new Set<string>();
  for (const call of [...capture.spec.calls, echoCall(capture)]) {
    const label = call.label ?? call.tool;
    if (labels.has(slug(label))) throw new Error(`${capture.spec.provider}: two calls are labelled "${label}"`);
    labels.add(slug(label));
    rows.push({
      label,
      tool: call.tool,
      args: call.args ?? {},
      ...(await run(capture, label, call, fromReplies(call.replies))),
    });
  }
  return rows;
}

async function failures(capture: Capture): Promise<unknown> {
  const { spec } = capture;
  const out: Record<string, unknown> = {};
  for (const kind of ["read", "write"] as const) {
    const call = spec.failures[kind];
    const before = fromReplies(call.replies);
    const failAt = call.failAt ?? 0;
    const cases: Record<string, unknown> = {};
    for (const failure of FAILURE_CASES) {
      const answer: Answer = (request, index) => {
        if (index < failAt) return before(request, index);
        if (failure === "network" || failure === "timeout") return failure;
        const status = Number.parseInt(failure, 10);
        const message =
          failure === "401 echo" ? `Golden 401 failure: rejected ${capture.errorEcho}` : `Golden ${status} failure`;
        const reply = (spec.failureReply ?? defaultFailureReply)(status, message);
        return status === 429
          ? { ...reply, headers: { ...reply.headers, "retry-after": String(GOLDEN_RETRY_AFTER_SECONDS) } }
          : reply;
      };
      cases[failure] = await run(capture, `${kind} ${failure}`, call, answer);
    }
    out[kind] = { tool: call.tool, args: call.args ?? {}, ...(failAt ? { failAt } : {}), cases };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Serialization

/**
 * Two-space JSON with secrets replaced, ending in a newline. Keys keep the
 * order the provider produced them in: that order is part of what an agent
 * reads, so a migration that reorders a schema or a result changes a golden.
 */
function stable(value: unknown, capture: Capture): string {
  return `${redact(JSON.stringify(value, null, 2), capture.secrets)
    .split(capture.nonce)
    .join("")}\n`;
}

function redact(text: string, secrets: Record<string, string>): string {
  // Longest first, so a secret that contains another is replaced whole.
  const entries = Object.entries(secrets)
    .filter(([, value]) => value.length > 0)
    .sort(([, a], [, b]) => b.length - a.length);
  let out = text.replace(/"(Basic) ([A-Za-z0-9+/=]+)"/g, (whole, scheme: string, encoded: string) => {
    try {
      const decoded = atob(encoded);
      return entries.some(([, value]) => decoded.includes(value)) ? `"${scheme} base64(${decoded})"` : whole;
    } catch {
      return whole;
    }
  });
  for (const [name, value] of entries) {
    const escaped = JSON.stringify(value).slice(1, -1);
    out = out.split(escaped).join(`<secret:${name}>`);
    const encoded = encodeURIComponent(value);
    if (encoded !== value) out = out.split(encoded).join(`<secret:${name}>`);
  }
  // A default User-Agent names the release; the golden must not change with it.
  return out.split(`connecta/${CONNECTA_VERSION}`).join("connecta/<version>");
}

export const GOLDEN_FILES = ["catalog", "calls", "failures", "setup"] as const;
export type GoldenFile = (typeof GOLDEN_FILES)[number];

/** The golden files a spec has: `setup.json` only when it completes a consent. */
export function goldenFiles(spec: GoldenSpec): GoldenFile[] {
  return GOLDEN_FILES.filter((file) => file !== "setup" || spec.setup !== undefined);
}

/** Test-only inputs: `seam` stands in for a provider that calls fetch differently; `jitter` seeds scheduling noise. */
export interface CaptureOptions {
  seam?: FetchSeam;
  jitter?: number;
}

let captures = 0;

function captureFor(spec: GoldenSpec, restart: () => void, options: CaptureOptions): Capture {
  const secrets: Record<string, string> = {
    ...(typeof spec.credential === "string" ? { credential: spec.credential } : (spec.credential ?? {})),
    ...spec.secrets,
  };
  const sent = Object.entries(secrets).filter(([name]) => !spec.unsent?.includes(name));
  if (sent.length === 0) throw new Error(`${spec.provider}: no sent secret to echo`);
  const pairs = (spec.basic ?? []).map(([user, password]) => {
    if (secrets[user] === undefined || secrets[password] === undefined) {
      throw new Error(`${spec.provider}: basic names an unknown secret`);
    }
    return base64(`${secrets[user]}:${secrets[password]}`);
  });
  return {
    spec,
    restart,
    secrets,
    echo: [...sent.flatMap(([, value]) => secretEncodings(value)), ...pairs].join(" "),
    errorEcho: sent.map(([, value]) => value).join(" "),
    // Process-wide caches (Google's delegated tokens) never carry over from an earlier capture.
    nonce: `--capture-${++captures}--`,
    ...(options.seam ? { seam: options.seam } : {}),
    ...(options.jitter !== undefined ? { jitter: jitterFrom(options.jitter) } : {}),
  };
}

/** Every golden file's exact bytes for one spec. */
export async function captureGoldens(
  spec: GoldenSpec,
  options: CaptureOptions = {},
): Promise<Partial<Record<GoldenFile, string>>> {
  const clock = deterministic();
  try {
    const capture = captureFor(spec, clock.restart, options);
    const files: Partial<Record<GoldenFile, string>> = {
      catalog: stable(await catalog(capture), capture),
      calls: stable(await calls(capture), capture),
      failures: stable(await failures(capture), capture),
    };
    if (spec.setup) files.setup = stable(JSON.parse(capture.setup ?? "[]"), capture);
    return files;
  } finally {
    clock.restore();
  }
}

/** Run only the echo call: it rejects if a sent secret reaches the result. */
export async function captureEcho(spec: GoldenSpec): Promise<void> {
  const clock = deterministic();
  try {
    const capture = captureFor(spec, clock.restart, {});
    const call = echoCall(capture);
    await run(capture, call.label!, call, fromReplies(call.replies));
  } finally {
    clock.restore();
  }
}

/** Tools in the catalog that no call exercises. */
export async function uncoveredTools(spec: GoldenSpec): Promise<string[]> {
  const connector = spec.create("coverage");
  const named = new Set(spec.calls.map((call) => call.tool));
  return (connector.staticTools ?? []).map((tool) => tool.name).filter((name) => !named.has(name));
}
