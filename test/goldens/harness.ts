// Characterization goldens for every maintained `api()` provider: the oracle a
// provider migration must match byte for byte. A spec says how to build the
// provider and which fixture calls to make; this harness owns everything else
// (the fetch fake, the fixed clock and ids, redaction, failure statuses, and
// the JSON layout), so a migration changes the provider, never the golden.
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

/** A request the harness answers itself and records by method and URL only. */
export interface AuxiliaryRoute {
  /** The name recorded in place of the request, e.g. `token`. */
  name: string;
  match(request: SeenRequest): boolean;
  reply: StubResponse | ((request: SeenRequest) => StubResponse);
}

export interface GoldenSpec {
  /** Provider folder under `src/providers/` and golden folder under `test/goldens/`. */
  provider: string;
  /** A fresh connector; called once per scenario. */
  create(): Connector;
  /**
   * The vault credential: one value, or named fields. Each value is replaced
   * by `<secret:field>` wherever it appears in a golden.
   */
  credential?: string | Record<string, string>;
  /** Further secrets the deployment configures (client secrets, private keys). */
  secrets?: Record<string, string>;
  /** Token exchanges and other requests that are not the tool's own. */
  auxiliary?: readonly AuxiliaryRoute[];
  /**
   * Runs before every scenario on the connector's registry context, e.g. to
   * complete an OAuth consent. Its requests reach `auxiliary` routes (others
   * get `200 {}`) and are not recorded.
   */
  setup?(connector: Connector, ctx: ConnectorContext): Promise<void>;
  /** At least one representative call per tool. */
  calls: readonly GoldenCall[];
  /** One read and one write tool driven through every failure status. */
  failures: { read: GoldenFailureCall; write: GoldenFailureCall };
  /** The vendor's error body for a failure status; defaults to a generic JSON body. */
  failureReply?: (status: number) => StubResponse;
}

export function defineGoldenSpec(spec: GoldenSpec): GoldenSpec {
  return spec;
}

/** Failure statuses every golden drives, plus a transport failure. */
export const FAILURE_CASES = ["400", "401", "403", "404", "409", "422", "429", "500", "network"] as const;
/** The `retry-after` every 429 carries, in seconds. */
export const GOLDEN_RETRY_AFTER_SECONDS = 7;

function defaultFailureReply(status: number): StubResponse {
  return { status, body: { error: { code: `golden_${status}`, message: `Golden ${status} failure` } } };
}

// ---------------------------------------------------------------------------
// Determinism

/**
 * Fix the clock and the ids for one capture. Only `Date` is faked, so timers
 * still run. `crypto.randomUUID` counts and `Math.random` is a fixed sequence;
 * both restart for every scenario, so adding or reordering a call never moves
 * another call's ids.
 */
function deterministic(): { restart(): void; restore(): void } {
  vi.useFakeTimers({ now: GOLDEN_NOW, toFake: ["Date"] });
  let uuid = 0;
  const randomUUID = vi
    .spyOn(crypto, "randomUUID")
    .mockImplementation(
      () => `00000000-0000-4000-8000-${(++uuid).toString(16).padStart(12, "0")}` as ReturnType<Crypto["randomUUID"]>,
    );
  let seed = 0;
  const random = vi.spyOn(Math, "random").mockImplementation(() => (seed = (seed * 9301 + 49297) % 233280) / 233280);
  return {
    restart() {
      uuid = 0;
      seed = 0;
      vi.setSystemTime(GOLDEN_NOW);
    },
    restore() {
      randomUUID.mockRestore();
      random.mockRestore();
      vi.useRealTimers();
    },
  };
}

// ---------------------------------------------------------------------------
// The fake network

async function bodyOf(input: unknown, init: RequestInit): Promise<unknown> {
  const body = init.body ?? (input instanceof Request ? await input.clone().arrayBuffer() : undefined);
  if (body === undefined || body === null) return undefined;
  if (body instanceof FormData) {
    const entries: unknown[] = [];
    for (const [name, value] of body.entries()) {
      entries.push(
        typeof value === "string"
          ? [name, value]
          : [name, { file: value.name, type: value.type, text: await value.text() }],
      );
    }
    return { formData: entries };
  }
  const bytes = new Uint8Array(await new Response(body as BodyInit).arrayBuffer());
  if (bytes.byteLength === 0 && typeof body !== "string") return undefined;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return { base64: btoa(binary) };
  }
  try {
    return { json: JSON.parse(text) };
  } catch {
    return text;
  }
}

async function seen(input: unknown, init: RequestInit = {}): Promise<SeenRequest> {
  const request = input instanceof Request ? input : undefined;
  const headers = new Headers(request?.headers);
  new Headers(init.headers).forEach((value, name) => headers.set(name, value));
  const sorted: Record<string, string> = {};
  for (const name of [...headers.keys()].sort()) sorted[name] = headers.get(name)!;
  return {
    method: (init.method ?? request?.method ?? "GET").toUpperCase(),
    url: new URL(request ? request.url : String(input)),
    headers: sorted,
    body: await bodyOf(input, init),
  };
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

interface Recorded {
  request: SeenRequest;
  auxiliary?: string;
}

type Answer = (request: SeenRequest, index: number) => StubResponse | "network";

function installFetch(spec: GoldenSpec, answer: Answer): { recorded: Recorded[]; restore(): void } {
  const recorded: Recorded[] = [];
  const realFetch = globalThis.fetch;
  let index = 0;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const request = await seen(input, init);
    const route = spec.auxiliary?.find((candidate) => candidate.match(request));
    if (route) {
      recorded.push({ request, auxiliary: route.name });
      return respond(typeof route.reply === "function" ? route.reply(request) : route.reply);
    }
    recorded.push({ request });
    const reply = answer(request, index++);
    if (reply === "network") throw networkFailure();
    return respond(reply);
  }) as typeof fetch;
  return {
    recorded,
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

function requestRecord(entry: Recorded): unknown {
  const { request } = entry;
  if (entry.auxiliary) return { auxiliary: entry.auxiliary, method: request.method, url: request.url.href };
  return {
    method: request.method,
    url: request.url.href,
    headers: request.headers,
    ...(request.body !== undefined ? { body: request.body } : {}),
  };
}

async function run(spec: GoldenSpec, call: GoldenCall, answer: Answer, restart: () => void) {
  restart();
  const connector = spec.create();
  const registry = await registryFor(spec, connector);
  const tools =
    connector.staticTools ?? (await connector.listTools(registry.contextFor(connector.id, GOLDEN_BASE_URL)));
  const tool = tools.find((candidate) => candidate.name === call.tool);
  if (!tool) throw new Error(`${spec.provider}: no tool "${call.tool}"`);
  const write = classifyTool(tool) !== "read";
  if (spec.setup) {
    const quiet = installFetch(spec, () => ({}));
    try {
      await spec.setup(connector, registry.contextFor(connector.id, GOLDEN_BASE_URL));
    } finally {
      quiet.restore();
    }
  }
  const network = installFetch(spec, answer);
  try {
    const result = await new InvocationService(registry, new CatalogService(registry, GOLDEN_BASE_URL)).invoke(
      `${connector.id}.${call.tool}`,
      call.args ?? {},
      { source: write ? "call_destructive_tool" : "call_tool", readOnly: false },
    );
    return { requests: network.recorded.map(requestRecord), result: outcome(result) };
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

async function catalog(spec: GoldenSpec, restart: () => void): Promise<unknown> {
  restart();
  const connector = spec.create();
  const registry = await registryFor(spec, connector);
  try {
    const tools = await connector.listTools(registry.contextFor(connector.id, GOLDEN_BASE_URL));
    return {
      id: connector.id,
      kind: connector.kind,
      title: connector.title,
      description: connector.description,
      ...(connector.credential ? { credential: connector.credential } : {}),
      ...(connector.classification ? { classification: connector.classification } : {}),
      guide: { summary: connectorGuideSummary(connector), content: connectorGuide(connector) },
      tools: tools.map(toolRecord),
    };
  } finally {
    registry.closeCallAdmission();
  }
}

async function calls(spec: GoldenSpec, restart: () => void): Promise<unknown> {
  const rows = [];
  for (const call of spec.calls) {
    const reply = fromReplies(call.replies);
    rows.push({
      label: call.label ?? call.tool,
      tool: call.tool,
      args: call.args ?? {},
      ...(await run(spec, call, reply, restart)),
    });
  }
  return rows;
}

async function failures(spec: GoldenSpec, restart: () => void): Promise<unknown> {
  const out: Record<string, unknown> = {};
  for (const kind of ["read", "write"] as const) {
    const call = spec.failures[kind];
    const before = fromReplies(call.replies);
    const failAt = call.failAt ?? 0;
    const cases: Record<string, unknown> = {};
    for (const failure of FAILURE_CASES) {
      const answer: Answer = (request, index) => {
        if (index < failAt) return before(request, index);
        if (failure === "network") return "network";
        const status = Number(failure);
        const reply = (spec.failureReply ?? defaultFailureReply)(status);
        return status === 429
          ? { ...reply, headers: { ...reply.headers, "retry-after": String(GOLDEN_RETRY_AFTER_SECONDS) } }
          : reply;
      };
      cases[failure] = await run(spec, call, answer, restart);
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
function stable(value: unknown, secrets: Record<string, string>): string {
  return `${redact(JSON.stringify(value, null, 2), secrets)}\n`;
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

export const GOLDEN_FILES = ["catalog", "calls", "failures"] as const;
export type GoldenFile = (typeof GOLDEN_FILES)[number];

/** Every golden file's exact bytes for one spec. */
export async function captureGoldens(spec: GoldenSpec): Promise<Record<GoldenFile, string>> {
  const secrets: Record<string, string> = {
    ...(typeof spec.credential === "string" ? { credential: spec.credential } : (spec.credential ?? {})),
    ...spec.secrets,
  };
  const clock = deterministic();
  try {
    return {
      catalog: stable(await catalog(spec, clock.restart), secrets),
      calls: stable(await calls(spec, clock.restart), secrets),
      failures: stable(await failures(spec, clock.restart), secrets),
    };
  } finally {
    clock.restore();
  }
}

/** Tools in the catalog that no call exercises. */
export async function uncoveredTools(spec: GoldenSpec): Promise<string[]> {
  const connector = spec.create();
  const named = new Set(spec.calls.map((call) => call.tool));
  return (connector.staticTools ?? []).map((tool) => tool.name).filter((name) => !named.has(name));
}
