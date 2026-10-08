// Node-only: inspects source files with Node filesystem APIs.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const source = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");

it("INV-5: every agent-facing operation table and serializer retains the redaction boundary", () => {
  const meta = source("meta-tools.ts");
  const execute = source("execute.ts");
  const mcp = source("routes/mcp.ts");
  const secrets = source("sent-secrets.ts");
  // The exported direct API returns only wrapped operations. New keys are
  // covered by Object.keys, rather than a maintained redaction allowlist.
  expect(meta).toMatch(/export function createMetaTools[\s\S]*?return agentOutputOperations\(/);
  expect(secrets).toContain("Object.keys(create(requestScope ?? {}))");
  expect(secrets).toContain("return redactAgentOutput(secrets, await create(scope)[name]!(...args))");
  expect(secrets).toContain("throw redactAgentOutput(secrets, error)");
  expect(execute).toContain("return agentOutputOperations((requestScope) => ({");
  // All guest operations cross the common mapping on success and failure.
  const bridge = execute.slice(execute.indexOf("fns: Object.fromEntries"), execute.indexOf("function awaitExecutor"));
  expect(bridge).toContain("Object.entries(operations).map");
  expect(bridge).toContain("redactAgentOutput(sentSecrets, value)");
  expect(bridge).toContain("throw redactAgentOutput(sentSecrets, err)");
  // Both SDK transports meet at exchange before a Response is constructed.
  const response = mcp.slice(
    mcp.indexOf("const response = await exchange();"),
    mcp.indexOf("export function createMcpRoute"),
  );
  expect(response).toContain("redactAgentOutput(sentSecrets, JSON.parse(body))");
  expect(response).toContain("text ??= redactAgentOutput(sentSecrets, body)");
  expect(response).toContain("return new Response(text,");
});
