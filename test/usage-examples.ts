import { expect } from "vitest";
import type { McpServer } from "@modelcontextprotocol/server";
import { createExecuteTool, registerExecuteTool } from "../src/execute.js";
import { createMetaTools } from "../src/meta-tools.js";
import { USAGE_SKILL } from "../src/usage-guide.js";
import type { Connector, Executor } from "../src/types.js";
import { makeRegistry, required, silentLogger } from "./helpers.js";

const BASE = "https://usage.test";
const ids = Array.from({ length: 140 }, (_, i) => `item_${i}_é`);
const fixture: Connector = {
  id: "ci",
  kind: "mcp",
  async listTools() {
    return [
      {
        name: "get_run",
        inputSchema: { type: "object", properties: { runId: { type: "number" } }, required: ["runId"] },
        annotations: { readOnlyHint: true },
      },
      {
        name: "get_job_logs",
        inputSchema: { type: "object", properties: { jobId: { type: "string" } }, required: ["jobId"] },
        annotations: { readOnlyHint: true },
      },
      { name: "export", annotations: { readOnlyHint: true } },
    ];
  },
  async callTool(name) {
    if (name === "get_run") return { content: [], structuredContent: { status: "failed", failedJobId: "job_7" } };
    if (name === "get_job_logs")
      return { content: [{ type: "text", text: "INFO starting\nERROR connection refused\nINFO stopped" }] };
    return { content: [], structuredContent: { items: ids.map((id) => ({ id })) } };
  },
};

/** Read the actual registered description, including every deployment variant. */
export function usageDescription(
  executor: Executor,
  trust: "trusted" | "read-only" = "read-only",
  guided = false,
): string {
  let description = "";
  const server = {
    registerTool(_name: string, options: { description: string }) {
      description = options.description;
    },
  } as unknown as McpServer;
  registerExecuteTool(server, makeRegistry([{ ...fixture, ...(guided ? { usageGuide: "CI guide" } : {}) }]), {
    baseUrl: BASE,
    executor,
    logger: silentLogger,
    trust,
  });
  return description;
}

/** Every JS fence is a runnable guest expression; new examples require an assertion. */
export function examples(text: string): string[] {
  const fences = [...text.matchAll(/```([^\n]*)\n([\s\S]*?)\n```/g)];
  expect(fences.every((match) => ["js", "ts"].includes(match[1]!))).toBe(true);
  return fences.filter((match) => match[1] === "js").map((match) => match[2]!);
}

export async function checkUsageExamples(executor: Executor): Promise<void> {
  const directExample = USAGE_SKILL.match(/`(\{ "address": "crm.get_account"[^`]+)`/)![1]!;
  const account: Connector = {
    id: "crm",
    kind: "api",
    async listTools() {
      return [{ name: "get_account", annotations: { readOnlyHint: true } }];
    },
    async callTool(_name, args) {
      return { id: (args as { id: string }).id, name: "Example account" };
    },
  };
  const knownRead = await createMetaTools(makeRegistry([account]), BASE).callTool(JSON.parse(directExample));
  expect(knownRead.isError).toBeFalsy();
  expect(JSON.parse(knownRead.content[0]!.text)).toEqual({ id: "acct_42", name: "Example account" });
  const registry = makeRegistry([fixture], { maxResultBytes: 512 });
  const run = createExecuteTool(registry, BASE, executor, silentLogger);
  const direct = await createMetaTools(registry, BASE).callTool({ address: "ci.export" });
  expect(direct.structuredContent).toBeUndefined();
  const notice = JSON.parse(required(direct.content[0]).text.split("\n")[0]!);
  expect(notice).toMatchObject({ truncated: true, resultId: expect.any(String) });
  const resultId = notice.resultId as string;
  const guideExamples = examples(USAGE_SKILL);
  const expected = [
    { status: "failed", jobId: "job_7" },
    [{ status: "failed" }, { text: ["ERROR connection refused"] }, { error: "invalid_args", retryable: false }],
    ids,
  ];
  expect(guideExamples).toHaveLength(expected.length);
  for (const [index, code] of guideExamples.entries()) {
    // Replace only the documented direct-result handle with one minted by a real call.
    const result = await run({ code: code.replace('"result-id"', JSON.stringify(resultId)) });
    expect(result.isError, JSON.stringify(result.structuredContent)).toBeFalsy();
    expect(result.structuredContent?.result).toEqual(expected[index]);
    if (index === 1)
      expect(result.structuredContent?.hostCalls).toMatchObject({ attempted: 3, succeeded: 2, failed: 1 });
    if (index === 2)
      expect((required(result.structuredContent).hostCalls as { attempted: number }).attempted).toBeGreaterThan(1);
  }
  for (const trust of ["trusted", "read-only"] as const) {
    for (const guided of [false, true]) {
      const description = usageDescription(executor, trust, guided);
      expect(description.length).toBeLessThan(1_800);
      for (const code of examples(description)) {
        const result = await run({ code });
        expect(result.isError).toBeFalsy();
        expect(result.structuredContent?.result).toEqual({ statuses: ["failed", "failed"] });
      }
    }
  }
  // The same extracted fan-out cannot hide terminal exhaustion with allSettled or catch.
  const bounded = createExecuteTool(registry, BASE, executor, silentLogger, undefined, { maxHostCalls: 2 });
  const code = guideExamples[1]!;
  const outcome = await bounded({
    code: `async () => { try { return await (${code})(); } catch { return "caught"; } }`,
  });
  expect(outcome.isError).toBe(true);
  expect(outcome.structuredContent).toMatchObject({ error: { code: "budget_exceeded", retryable: false } });
  expect(outcome.structuredContent).not.toHaveProperty("result");
}
