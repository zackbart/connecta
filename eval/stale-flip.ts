/**
 * Stale-flip reproduction, no paid model: real host processes, a real Connecta
 * deployment, a scripted local model and a fake vendor that counts physical
 * writes. Each case lists tools, flips or keeps the downstream classification,
 * has the scripted model call one tool once, and closes the connection after
 * Connecta answered that first call. Then it reports how many times the vendor
 * was physically written.
 *
 *   pnpm exec tsx eval/stale-flip.ts [--cases a,b] [--hosts claude,codex] [--modes reset,parallel] [--target worker] [--out file]
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { Surface } from "./agent/surface.js";
import { runClaude } from "./agent/claude.js";
import { runCodex } from "./agent/codex.js";
import { startDeployment, parseTarget } from "./deploy/targets.js";
import { FakeService, Ledger, type FakeTool } from "./fakes/service.js";
import { NO_INJECTION } from "./fakes/injection.js";
import { World } from "./fakes/world.js";
import { flags } from "./support/meta.js";
import { connectMcp } from "./support/mcp.js";
import { claudeWrapper, codexWrapper, scriptedClaudeModel, scriptedCodexModel } from "./support/scripted-model.js";
import type { ActiveTask } from "./tasks/types.js";

const READ = { readOnlyHint: true, destructiveHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: true };
const ARGS = { id: "A-1", status: "closed" };
const ADDRESS = "crm.set_status";

export interface FlipCase {
  id: string;
  surface: Surface;
  /** Classification served when the host lists tools. */
  listed: "read" | "write";
  /** Classification Connecta enforces when the call arrives. */
  called: "read" | "write";
  tool: string;
  input: Record<string, unknown>;
  /** The most physical writes the contract allows; a read case allows none. */
  maxWrites: number;
  /** The vendor declares a write throughout and deployment code classifies it read: no flip needed. */
  overrideRead?: boolean;
  note: string;
}

const program = `async () => (await connecta.call(${JSON.stringify(ADDRESS)}, ${JSON.stringify(ARGS)})).data`;
export const FLIP_CASES: FlipCase[] = [
  {
    id: "native-flip",
    surface: "native",
    listed: "read",
    called: "write",
    tool: "crm__set_status",
    input: ARGS,
    maxWrites: 1,
    note: "native tool listed read, now a write; the suspected hazard",
  },
  {
    id: "native-write-control",
    surface: "native",
    listed: "write",
    called: "write",
    tool: "crm__set_status",
    input: ARGS,
    maxWrites: 1,
    note: "native tool always a write; destructive annotation should stop the replay",
  },
  {
    id: "native-read-control",
    surface: "native",
    listed: "read",
    called: "read",
    tool: "crm__set_status",
    input: ARGS,
    maxWrites: 0,
    note: "native tool always a read; a replay is harmless and shows the host does retry",
  },
  {
    id: "six-call-tool-flip",
    surface: "six",
    listed: "read",
    called: "write",
    tool: "call_tool",
    input: { address: ADDRESS, args: ARGS },
    maxWrites: 0,
    note: "call_tool is annotated read-only and must refuse a current write",
  },
  {
    id: "native-override-read",
    surface: "native",
    listed: "read",
    called: "write",
    overrideRead: true,
    tool: "crm__set_status",
    input: ARGS,
    maxWrites: 1,
    note: "source write classified read by deployment code; INV-1 says overrides never relax replay safety",
  },
  {
    id: "six-override-read",
    surface: "six",
    listed: "read",
    called: "write",
    overrideRead: true,
    tool: "call_tool",
    input: { address: ADDRESS, args: ARGS },
    maxWrites: 1,
    note: "the same override through the meta surface's read-only call_tool",
  },
  {
    id: "native-bound-flip",
    surface: "native-bound",
    listed: "read",
    called: "write",
    tool: "crm__set_status",
    input: ARGS,
    maxWrites: 0,
    note: "mitigation prototype: a write's wire name differs, so a stale read name is refused before dispatch",
  },
  {
    id: "six-program-flip",
    surface: "six",
    listed: "read",
    called: "write",
    tool: "execute_code",
    input: { code: program },
    maxWrites: 1,
    note: "execute_code is annotated destructive on a writable endpoint",
  },
  {
    id: "read-program-flip",
    surface: "read-six",
    listed: "read",
    called: "write",
    tool: "execute_read_code",
    input: { code: program },
    maxWrites: 0,
    note: "the read-only program route must refuse a current write in the guest",
  },
];

/** The same call for a different record, so a replay shows up per record. */
function withRecord(flipCase: FlipCase, id: string): Record<string, unknown> {
  const args = { ...ARGS, id };
  if (flipCase.tool === "call_tool") return { address: ADDRESS, args };
  if ("code" in flipCase.input)
    return { code: `async () => (await connecta.call(${JSON.stringify(ADDRESS)}, ${JSON.stringify(args)})).data` };
  return args;
}

interface Observed {
  jsonrpcId: unknown;
  session: string | null;
  protocol: string | null;
  bodyBytes: string;
}

/**
 * How the connection fails after Connecta has already answered the call:
 * - reset: the socket dies before response headers.
 * - sse-end: 200 event stream, then a clean end with no JSON-RPC response.
 * - sse-reset: 200 event stream, then the socket dies.
 * - http-404, http-503: an intermediary status instead of Connecta's answer.
 * - parallel: the first call hangs; the next three die with reset, tripping the
 *   host's "max consecutive terminal errors" close while the first is pending.
 */
export const DROP_MODES = ["reset", "sse-end", "sse-reset", "http-404", "http-503", "parallel"] as const;
export type DropMode = (typeof DROP_MODES)[number];

/** Forward to Connecta; fail the planned calls' replies after each call completed upstream. */
async function closingProxy(upstream: string, tool: string, mode: DropMode) {
  const target = new URL(upstream);
  const observed: Observed[] = [];
  let matched = 0;
  const held: (() => void)[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      let message: { method?: string; id?: unknown; params?: { name?: string } } = {};
      try {
        message = JSON.parse(body.toString());
      } catch {
        /* Not a JSON-RPC body. */
      }
      const matches = message.method === "tools/call" && message.params?.name === tool;
      if (matches)
        observed.push({
          jsonrpcId: message.id,
          session: (req.headers["mcp-session-id"] as string | undefined) ?? null,
          protocol: (req.headers["mcp-protocol-version"] as string | undefined) ?? null,
          bodyBytes: body.toString(),
        });
      if (matches) matched += 1;
      const position = matches ? matched : 0;
      const drop = mode === "parallel" ? position >= 1 && position <= 4 : position === 1;
      if (drop && (mode === "sse-end" || mode === "sse-reset")) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.flushHeaders();
      }
      const forward = httpRequest(
        upstream,
        {
          method: req.method,
          path: req.url,
          headers: { ...req.headers, host: target.host },
        },
        (reply) => {
          if (!drop) {
            res.writeHead(reply.statusCode ?? 502, reply.headers);
            reply.pipe(res);
            return;
          }
          reply.on("data", () => {});
          reply.on("end", () => {
            if (mode === "reset" || mode === "sse-reset") req.socket.destroy();
            else if (mode === "sse-end") res.end();
            else if (mode === "http-404" || mode === "http-503") {
              res.writeHead(mode === "http-404" ? 404 : 503, { "content-type": "application/json" });
              res.end(JSON.stringify({ error: "intermediary" }));
            } else if (position === 1) {
              // The pending call: unanswered until the transport closes it. A host that
              // runs calls one at a time would wait forever, so release it after a while.
              const release = () => req.socket.destroy();
              held.push(release);
              setTimeout(release, 20_000).unref();
            } else {
              req.socket.destroy();
            }
          });
        },
      );
      forward.on("error", () => req.socket.destroy());
      forward.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${target.pathname}`;
  return {
    url,
    observed,
    close: () =>
      new Promise<void>((resolve) => {
        for (const release of held) release();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function runClaudeHost(
  mcpUrl: string,
  token: string,
  flipCase: FlipCase,
  beforeCall: () => Promise<void>,
  mode: DropMode,
) {
  const root = await mkdtemp(join(tmpdir(), "connecta-flip-claude-"));
  const inputs = mode === "parallel" ? [1, 2, 3, 4].map((n) => withRecord(flipCase, `A-${n}`)) : [flipCase.input];
  const tool = `mcp__connecta__${flipCase.tool}`;
  const model = await scriptedClaudeModel([inputs.map((input) => ({ tool, input }))], beforeCall);
  const session = await connectMcp(mcpUrl, { Authorization: `Bearer ${token}` });
  const names = (await session.listTools()).map((listed) => listed.name);
  await session.close();
  const run = await runClaude({
    model: "claude-sonnet-5-5",
    surface: flipCase.surface,
    mcpUrl,
    token,
    allowedTools: names,
    deniedTools: [],
    toolSearch: false,
    timeoutMs: 180_000,
    firstPrompt: "Call the tool.",
    nextTurn: async () => undefined,
    testHost: { executable: await claudeWrapper(root, model.url), args: [] },
  });
  await model.close();
  await rm(root, { recursive: true, force: true });
  return {
    exit: run.exitCode,
    timedOut: run.timedOut,
    results: model.toolResults.map((result) => JSON.stringify(result).slice(0, 400)),
    stderr: run.exitCode === 0 ? "" : run.stderrTail,
  };
}

/** Codex code mode: one exec program calls the tool once. */
async function runCodexHost(
  mcpUrl: string,
  token: string,
  flipCase: FlipCase,
  beforeCall: () => Promise<void>,
  mode: DropMode,
) {
  if (mode === "parallel") throw new Error("The parallel drop mode scripts Claude Code only.");
  const root = await mkdtemp(join(tmpdir(), "connecta-flip-codex-"));
  const model = await scriptedCodexModel(
    [
      `const tool = ALL_TOOLS.find((t) => t.name.endsWith(${JSON.stringify(flipCase.tool)}));` +
        `text(JSON.stringify(await tools[tool.name](${JSON.stringify(flipCase.input)})));`,
    ],
    beforeCall,
  );
  const session = await connectMcp(mcpUrl, { Authorization: `Bearer ${token}` });
  const names = (await session.listTools()).map((listed) => listed.name);
  await session.close();
  const { executable, authFile } = await codexWrapper(root, model.url);
  const run = await runCodex({
    model: "gpt-6.1-sol",
    surface: flipCase.surface,
    mcpUrl,
    token,
    allowedTools: names,
    deniedTools: [],
    timeoutMs: 180_000,
    firstPrompt: "Call the tool.",
    nextTurn: async () => undefined,
    testHost: { executable, args: [], authFile, version: "codex-cli scripted" },
  });
  await model.close();
  await rm(root, { recursive: true, force: true });
  return {
    exit: run.exitCode,
    timedOut: run.timedOut,
    results: model.toolResults.map((result) => JSON.stringify(result).slice(0, 400)),
    stderr: run.exitCode === 0 ? "" : run.stderrTail,
  };
}

export async function runFlipCase(
  flipCase: FlipCase,
  host: "claude" | "codex",
  target: "node" | "worker",
  mode: DropMode = "reset",
) {
  const ledger = new Ledger();
  const tool: FakeTool = {
    name: "set_status",
    description: "Set a record's status.",
    input: z.object({ id: z.string(), status: z.string() }),
    annotations: flipCase.listed === "read" && !flipCase.overrideRead ? { ...READ } : { ...WRITE },
    run: () => ({ json: { ok: true } }),
  };
  const crm = new FakeService("crm", "Customer records.", [tool], ledger);
  await crm.start();
  const world = new World({}, NO_INJECTION);
  await world.start();
  const specs = world.connectorSpecs.bind(world);
  world.connectorSpecs = () => [
    ...specs(),
    { id: "crm", title: "crm", description: "Customer records.", url: crm.url },
  ];
  const task = {
    id: "stale-flip",
    deployment: flipCase.overrideRead ? { classification: { crm: { set_status: "read" } } } : undefined,
  } as unknown as ActiveTask;
  const deployment = await startDeployment(target, world, task, flipCase.surface);
  const proxy = await closingProxy(deployment.mcpUrl, flipCase.tool, mode);
  let flippedList: boolean | undefined;
  const beforeCall = async () => {
    if (flipCase.listed === flipCase.called || flipCase.overrideRead) return;
    tool.annotations = flipCase.called === "read" ? { ...READ } : { ...WRITE };
    await deployment.restart!(false);
    if (flipCase.surface === "native") {
      // The current listing must show the write, or this case would prove nothing.
      const session = await connectMcp(deployment.mcpUrl, { Authorization: `Bearer ${deployment.token}` });
      const now = (await session.listTools()).find((candidate) => candidate.name === flipCase.tool);
      flippedList = now?.readOnly === false;
      await session.close();
    }
  };
  try {
    const hostRun = await (host === "claude" ? runClaudeHost : runCodexHost)(
      proxy.url,
      deployment.token,
      flipCase,
      beforeCall,
      mode,
    );
    const calls = crm.calls.filter((call) => call.tool === "set_status");
    const physical = calls.length;
    const counted = flipCase.called === "write" ? physical : 0;
    const perRecord = new Map<string, number>();
    for (const call of calls) perRecord.set(String(call.args.id), (perRecord.get(String(call.args.id)) ?? 0) + 1);
    const repeated = [...perRecord].filter(([, count]) => count > 1).map(([id, count]) => ({ id, count }));
    return {
      case: flipCase.id,
      mode,
      host,
      target,
      surface: flipCase.surface,
      listed: flipCase.listed,
      called: flipCase.called,
      hostToolCallsSeen: proxy.observed.length,
      physicalVendorCalls: physical,
      physicalWrites: counted,
      maxWrites: flipCase.maxWrites,
      duplicateWrite: flipCase.called === "write" && repeated.length > 0,
      repeatedRecords: repeated,
      exceededContract: flipCase.called === "write" && (repeated.length > 0 || flipCase.maxWrites === 0) && counted > 0,
      ...(flippedList === undefined ? {} : { listAfterFlipShowsWrite: flippedList }),
      retryIdentity: proxy.observed.map((seen) => ({
        jsonrpcId: seen.jsonrpcId,
        session: seen.session ? "present" : "absent",
        protocol: seen.protocol,
      })),
      sameBodyOnRetry:
        proxy.observed.length > 1 && proxy.observed.every((o) => o.bodyBytes === proxy.observed[0]!.bodyBytes),
      hostResults: hostRun.results,
      exit: hostRun.exit,
      timedOut: hostRun.timedOut,
      ...(hostRun.stderr ? { stderr: hostRun.stderr } : {}),
    };
  } finally {
    await Promise.allSettled([proxy.close(), deployment.close(), world.stop(), crm.stop()]);
  }
}

if (process.argv[1]?.endsWith("stale-flip.ts")) {
  const args = flags(process.argv.slice(2));
  const hosts = (args.get("hosts") ?? "claude").split(",") as ("claude" | "codex")[];
  const wanted = args.get("cases")?.split(",");
  const target = parseTarget(args.get("target") ?? "worker");
  const cases = FLIP_CASES.filter((item) => !wanted || wanted.includes(item.id));
  const modes = (args.get("modes") ?? "reset").split(",") as DropMode[];
  const reports = [];
  for (const host of hosts)
    for (const mode of modes)
      for (const flipCase of cases) {
        if (host === "codex" && mode === "parallel") continue;
        const report = await runFlipCase(flipCase, host, target, mode);
        reports.push(report);
        console.log(JSON.stringify(report));
      }
  const out = args.get("out");
  if (out) await writeFile(out, `${JSON.stringify(reports, null, 1)}\n`);
  process.exit(0);
}
