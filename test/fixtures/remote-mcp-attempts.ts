import { inject } from "vitest";
import { remoteMcp } from "../../src/connectors/remote-mcp.js";
import { attachCallClassification } from "../../src/call-classification.js";
import { makeRegistry } from "../helpers.js";

export async function probeRemoteAttempt(
  challenge: string,
  operation: "write" | "source-write" | "effective-write" | "read" | "resource",
  options: { versionNegotiation?: "legacy" | "auto"; signal?: AbortSignal } = {},
) {
  const control = inject("remoteMcpAttemptServer");
  const { origin, id } = await (await fetch(`${control}/${challenge}`, { method: "POST" })).json() as {
    origin: string;
    id: string;
  };
  const connector = remoteMcp("remote", { url: `${origin}/mcp`, versionNegotiation: options.versionNegotiation ?? "legacy", headers: { "x-probe": "fixture" } });
  const registry = makeRegistry([connector]);
  const ctx = registry.contextFor("remote", "https://connecta.example", undefined, { signal: options.signal ?? AbortSignal.timeout(10_000) });
  // Ordinary writes exercise the direct edge too, including its abort verdict.
  if (operation !== "write") attachCallClassification(ctx, operation === "effective-write" ? "write" : "read");
  let result: unknown;
  let error: unknown;
  try {
    if (operation !== "resource") await connector.listTools(ctx);
    result = await (operation === "resource"
      ? connector.readResource!("fixture://items", ctx)
      : connector.callTool(operation === "write" || operation === "source-write" ? "create_item" : "list_items", {}, ctx));
  } catch (failure) {
    error = failure;
  } finally {
    await connector.closeScope?.(ctx);
  }
  const inspect = async () => await (await fetch(`${control}/${id}`)).json() as {
    received: string[];
    closed: number;
    wire: Array<{ method: string; headers: Record<string, string>; body: string }>;
  };
  return { result, error, ...await inspect(), inspect };
}
