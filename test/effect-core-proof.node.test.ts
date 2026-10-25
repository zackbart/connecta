// Node-only: bundles candidates without editing source and drives native workerd isolates.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";

type Wire = { status: number; headers: Record<string, string>; body: string };
type Comparison = { cases: number; equal: boolean; differences: unknown[] };
type Cimd = {
  label: string;
  response: Wire;
  trace: string[];
  bodyUsed: boolean;
  outbound: number;
  admission: { active: number; queued: number; admitted: number };
};
type Latency = {
  constructionBuilds: number;
  totalBuilds: number;
  warmup: number;
  batches: number;
  batchSize: number;
  rows: Array<{ path: string; requests: number; builds: number; buildsPerRequest: number; samplesMs: number[] }>;
};
type Lifetimes = {
  sameReason: boolean;
  rows: Array<{
    mode: string;
    held: number;
    released: number;
    bodyFailed: boolean;
    cancels: number;
    afterSecondCancel: number;
    localAborted: boolean;
  }>;
};
type Report = {
  effect: string;
  sdk: string;
  router: {
    node: Comparison;
    workers: Comparison;
    edges: Record<string, Comparison>;
    nodeAgents: Comparison;
    workersAgents: Comparison;
    runners: { importEdges: number; baseline: number; candidate: number };
    logs: unknown[];
    transforms: Array<{ graph: string; count: number }>;
    cimd: Record<string, [Cimd[], Cimd[]]>;
    latency: Record<string, [Latency, Latency]>;
    latencyReverse: Record<string, [Latency, Latency]>;
    isolation: Record<
      string,
      {
        constructionBuilds: number;
        firstBuilds: number;
        totalBuilds: number;
        selected: string;
        mcpCalls: number;
        first: Array<{
          deferred: number;
          result: { body: string; id: string; path: string; preventYield: boolean; aborted: boolean };
        }>;
        later: Array<{
          deferred: number;
          result: { body: string; id: string; path: string; preventYield: boolean; aborted: boolean };
        }>;
      }
    >;
    seam: Record<
      string,
      {
        identity: boolean;
        missing: number;
        unowned: number;
        unmatchedRetainsError: boolean;
        sameError: boolean;
        sameShapedError: boolean;
        sameTypedRouteError: boolean;
        errorCalls: number[];
        finalized: number;
        response: Wire;
      }
    >;
    lifetimes: Record<string, Lifetimes[]>;
    queue: Array<{
      pending: boolean;
      first: string;
      result: { status: number; body: string };
      state: { secondReads: number; waiterArrived: boolean };
    }>;
    oracle: Array<{ label: string; response: Wire; trace: string[] }>;
  };
  mcp: {
    tools: Array<{ name: string }>;
    node: {
      observations: Record<string, Wire>;
      legacyConstruction: string;
      sdkClient: { tools: string[]; era: string };
    };
    workers: {
      observations: Record<string, Wire>;
      legacyConstruction: string;
      sdkClient: { tools: string[]; era: string };
    };
  };
  sizes: Array<{ name: string; candidate: boolean | string; gzip: number; imports: string[]; effectCopies?: string[] }>;
};

let report: Report;
beforeAll(async () => {
  const directory = await mkdtemp(join(tmpdir(), "connecta-proof-test-"));
  try {
    const path = join(directory, "report.json");
    await promisify(execFile)(process.execPath, ["scripts/probes/effect-core-compatibility.mjs", path], {
      timeout: 180_000,
      maxBuffer: 2_000_000,
    });
    report = JSON.parse(await readFile(path, "utf8")) as Report;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 190_000);

describe("Effect 4.0.5 compatibility proof", () => {
  it("pins the actual runtime and preserves one runner with no import-time fibers or console output (INV-6 INV-12)", () => {
    expect([report.effect, report.sdk]).toEqual(["4.0.5", "2.3.1"]);
    expect(report.router.runners.importEdges).toBe(0);
    expect(report.router.runners.candidate).toBe(report.router.runners.baseline);
    expect(report.router.logs).toEqual([]);
    expect(report.router.transforms).toEqual(
      ["node", "workerd", "root-size", "worker-size"].map((graph) => ({ graph, count: 1 })),
    );
    for (const row of report.sizes) {
      expect(row.imports.filter((path) => path.startsWith("node:"))).toEqual([]);
      if (row.effectCopies) expect(row.effectCopies).toHaveLength(1);
    }
  });

  for (const runtime of ["node", "workers"] as const)
    describe(runtime, () => {
      it("matches exact route bytes, raw paths, ingress order, and both agent presentations (INV-4)", () => {
        expect(report.router.edges[runtime]).toEqual({ cases: 440, equal: true, differences: [] });
        expect(report.router[runtime].cases).toBe(245);
        expect(report.router[runtime].differences).toEqual([]);
        expect(report.router[runtime].equal).toBe(true);
        expect(report.router[runtime === "node" ? "nodeAgents" : "workersAgents"]).toEqual({
          cases: 4,
          equal: true,
          differences: [],
        });
      });

      it("preserves optional fallthrough, Response identity/headers and original handler errors", () => {
        const seam = report.router.seam[runtime]!;
        expect(seam).toMatchObject({
          identity: true,
          missing: 404,
          unowned: 404,
          unmatchedRetainsError: true,
          sameError: true,
          sameShapedError: true,
          sameTypedRouteError: true,
          errorCalls: [1, 1, 1],
          finalized: 1,
        });
        expect(seam.response).toEqual({
          status: 405,
          headers: { allow: "PUT", "content-type": "application/json", "set-cookie": "a=1; Path=/" },
          body: "owned",
        });
      });

      it("serves real configured CIMD before auth/UI/body/admission with exact encoded-path and method refusals (INV-4 INV-10)", () => {
        const [baseline, candidate] = report.router.cimd[runtime]!;
        expect(candidate).toEqual(baseline);
        expect(candidate).toHaveLength(70);
        for (const row of candidate) {
          expect(row).toMatchObject({ bodyUsed: false, outbound: 0, admission: { active: 0, queued: 0, admitted: 0 } });
          expect(row.trace).not.toContain("auth");
          expect(row.trace.filter((entry) => entry.startsWith("storage."))).toEqual([]);
          if (row.label.endsWith(" /oauth/client-metadata/oauth")) {
            expect(row.trace).toEqual([]);
            if (row.label.startsWith("CIMD GET ")) {
              expect(row.response.status).toBe(200);
              expect(row.response.headers["cache-control"]).toBe("public, max-age=300");
              expect(JSON.parse(row.response.body)).toEqual({
                client_id: "https://proof.test/oauth/client-metadata/oauth",
                client_name: "connecta",
                application_type: "web",
                redirect_uris: ["https://proof.test/oauth/callback/oauth"],
                grant_types: ["authorization_code", "refresh_token"],
                response_types: ["code"],
                token_endpoint_auth_method: "none",
                scope: "read",
              });
            } else {
              expect(row.response).toMatchObject({ status: 405, body: "", headers: { allow: "GET" } });
            }
          }
        }
      });

      it("records bounded dispatch timings and verifies two once-per-handler builds without a timing threshold", () => {
        for (const measurement of [report.router.latency, report.router.latencyReverse]) {
          const [baseline, candidate] = measurement[runtime]!;
          expect([baseline.constructionBuilds, candidate.constructionBuilds]).toEqual([0, 0]);
          expect([baseline.totalBuilds, candidate.totalBuilds]).toEqual([0, 2]);
          for (const row of baseline.rows) expect(row.builds).toBe(0);
          expect(candidate.rows).toHaveLength(4);
          for (const row of candidate.rows) {
            expect(row.requests).toBe(250);
            expect(row.samplesMs).toHaveLength(5);
            expect(row.buildsPerRequest).toBe(0);
            expect(row.builds).toBe(0);
          }
        }
      });

      it("builds two routers across concurrent first requests, reuses them and reads each request's services (INV-7)", () => {
        const isolation = report.router.isolation[runtime]!;
        expect(isolation).toMatchObject({
          constructionBuilds: 0,
          firstBuilds: 2,
          totalBuilds: 2,
          selected: "health",
          mcpCalls: 32,
        });
        [...isolation.first, ...isolation.later].forEach((row, i) => {
          expect(row).toEqual({
            deferred: 1,
            result: {
              body: "body-" + i,
              id: String(i),
              path: i % 2 ? "/agent/native" : "/mcp/native",
              preventYield: false,
              aborted: false,
            },
          });
        });
      });

      it("retains body permits and closes exactly once on end/failure/cancel/abort/abandonment (INV-7)", () => {
        const [baseline, candidate] = report.router.lifetimes[runtime]!;
        expect(candidate).toEqual(baseline);
        expect(candidate!.sameReason).toBe(true);
        expect(candidate!.rows.map((r) => r.mode)).toEqual(["end", "failure", "cancel", "abort", "abandon"]);
        for (const row of candidate!.rows) {
          expect(row).toMatchObject({ held: 1, released: 0, localAborted: true });
          expect(row.afterSecondCancel).toBe(row.cancels);
          expect(row.cancels).toBe(["cancel", "abort", "abandon"].includes(row.mode) ? 1 : 0);
          expect(row.bodyFailed).toBe(row.mode === "failure");
        }
      });

      it("preserves all six input/output schemas and records inserted annotation defaults in the real modern codec", () => {
        const observations = report.mcp[runtime].observations;
        const list = JSON.parse(observations["modern list"]!.body).result;
        // The public ToolAnnotations codec adds idempotentHint:false.
        const expected = report.mcp.tools.map((tool) => {
          const value = tool as { name: string; annotations: Record<string, unknown> };
          return { ...value, annotations: { idempotentHint: false, ...value.annotations } };
        });
        expect(list.tools).toEqual(expected);
        expect(list.tools.map((t: { name: string }) => t.name).sort()).toEqual([
          "authorize_connector",
          "call_destructive_tool",
          "call_tool",
          "execute_code",
          "search_tools",
          "skills",
        ]);
        for (const tool of report.mcp.tools) {
          const call = JSON.parse(observations[`modern call ${tool.name}`]!.body).result;
          expect(call).toMatchObject({
            resultType: "complete",
            content: [{ type: "text", text: "proof" }],
            structuredContent: { value: "proof" },
          });
        }
        expect(JSON.parse(observations["modern isError"]!.body).result.isError).toBe(true);
      });

      it("records mandatory legacy/session incompatibility instead of accepting a persistent server (INV-7)", () => {
        const { observations, legacyConstruction } = report.mcp[runtime];
        expect(observations["legacy fresh list"]!.status).toBe(400);
        expect(observations["legacy fresh list"]!.body).toContain("MCP-Session-Id header is required");
        expect(observations["legacy initialize"]!.headers["mcp-session-id"]).toBe("issued");
        expect(observations["legacy fresh handler after initialize"]).toEqual({ status: 404, headers: {}, body: "" });
        expect(legacyConstruction).toBe(
          "McpServer.layerHttpRequestScoped does not support the sessionful MCP protocol 2025-06-18",
        );
      });

      it("records modern envelopes, capabilities, refusal and cache differences without declaring adoption", () => {
        const observations = report.mcp[runtime].observations;
        const discovery = JSON.parse(observations["modern server/discover"]!.body).result;
        expect(discovery).toMatchObject({
          cacheScope: "private",
          ttlMs: 0,
          capabilities: { tools: { listChanged: false }, logging: {}, completions: {} },
        });
        expect(observations["modern method mismatch"]!.status).toBe(400);
        expect(observations["modern name mismatch"]!.status).toBe(400);
        expect(observations["modern subscriptions/listen"]!.headers["content-type"]).toBe("text/event-stream");
        expect(observations["modern subscriptions/listen"]!.status).toBe(200);
        expect(JSON.parse(observations["modern resource read"]!.body).result.contents).toEqual([
          { uri: "connecta://skills/proof", mimeType: "text/plain", text: "proof skill" },
        ]);
      });

      it("uses the real SDK client and exposes the input-required envelope without inventing continuation verification", () => {
        const { observations, sdkClient } = report.mcp[runtime];
        expect(sdkClient).toEqual({ tools: report.mcp.tools.map((t) => t.name), era: "modern" });
        expect(observations["modern input required"]!.status).toBe(400);
        expect(JSON.parse(observations["modern input required supported"]!.body).result).toMatchObject({
          resultType: "input_required",
          requestState: "opaque-proof-state",
          inputRequests: {
            auth: { method: "elicitation/create", params: { mode: "url", url: "https://proof.test/connect/notes" } },
          },
        });
        // Signature/single-use checks are an application responsibility. This
        // synthetic handler deliberately supplies none; do not call it parity.
        expect(JSON.parse(observations["modern unverified continuation"]!.body).result.resultType).toBe("complete");
      });
    });

  it("hands native I/O to the queued workerd request after the first response ends (INV-7)", () => {
    for (const row of report.router.queue)
      expect(row).toEqual({
        pending: true,
        first: "held",
        result: { status: 401, body: "native:/waiter-owned" },
        state: { secondReads: 1, waiterArrived: true },
      });
  });

  it("pins JSON private-route 405 and pre-auth origin/body refusal rather than only comparing two implementations", () => {
    for (const row of report.router.oracle) {
      if (row.label.startsWith("OPTIONS /ui/"))
        expect(row.response).toMatchObject({ status: 405, body: '{"error":"method not allowed"}' });
      if (row.label.startsWith("origin-first")) {
        expect(row.response.status).toBe(403);
        expect(row.trace).toEqual([]);
      }
      if (row.label.startsWith("upgrade")) {
        expect(row.response.status).toBe(308);
        expect(row.trace).toEqual([]);
      }
      if (row.label.startsWith("auth-before")) {
        expect(row.response.status).toBe(401);
        expect(row.trace).toEqual(["ui", "auth"]);
      }
      if (row.label === "health after close") expect(row.response.status).toBe(200);
      if (row.label === "mcp after close") expect(row.response.status).toBe(503);
    }
  });
});
