// Reviewed reads with recorded schema digests, served through both
// classification wrappers: `list_things` matches its digest, `peek_things`
// (silent) and `scan_things` (claiming `readOnlyHint: true`) have changed
// schemas since review. A deployment can also restart onto a catalog an
// earlier process persisted, in today's layout or in 0.28's, with the
// downstream unavailable so the cache is the only source.
import { z } from "zod";
import { snapshotCatalog } from "../../src/catalog-fingerprint.js";
import {
  vettedCatalog,
  vettedSchemaDigest,
  withVettedCatalog,
} from "../../src/catalog-drift.js";
import { remoteMcp } from "../../src/connectors/remote-mcp.js";
import type { Connector, KVStorage, ToolDef } from "../../src/types.js";
import { required } from "../helpers.js";
import { httpDownstream, throwingTransport } from "./downstream-mcp.js";
import { connectorContext } from "./misc.js";

const STALE = `sha256:${"0".repeat(64)}`;

/** Each served tool records its name in `calls` when it runs downstream. */
function downstream(calls: string[]) {
  return httpDownstream((mcp) => {
    const tool = (name: string, annotations?: { readOnlyHint: true }) =>
      mcp.registerTool(
        name,
        {
          description: `Things: ${name}`,
          inputSchema: z.object({ cursor: z.string().optional() }),
          ...(annotations ? { annotations } : {}),
        },
        async () => {
          calls.push(name);
          return { content: [{ type: "text", text: name }] };
        },
      );
    tool("list_things");
    tool("peek_things");
    tool("scan_things", { readOnlyHint: true });
  });
}

/** What the downstream lists, before connecta classifies any of it. */
export async function downstreamListing(): Promise<ToolDef[]> {
  const plain = remoteMcp("things", {
    url: "https://things.example/mcp",
    _transportFactory: downstream([]).transport,
  });
  const ctx = connectorContext();
  try {
    return await plain.listTools(ctx);
  } finally {
    await plain.closeScope?.(ctx);
  }
}

/** The digest a review would record for the live `list_things`. */
export async function currentDigest(): Promise<string> {
  const listed = await downstreamListing();
  return vettedSchemaDigest(required(listed.find((tool) => tool.name === "list_things")));
}

/**
 * The listing 0.28 persisted for these reviewed reads: its wrapper stored
 * classified tools, and a stale digest only counted, so all three were cached
 * as `readOnlyHint: true, destructiveHint: false`.
 */
export async function mainEraListing(): Promise<ToolDef[]> {
  return (await downstreamListing()).map((tool) => ({
    ...tool,
    annotations: { ...tool.annotations, readOnlyHint: true, destructiveHint: false },
  }));
}

/**
 * Persist `tools` as the "things" catalog the way a registry writes it:
 * manifest `version` 2 is 0.28's layout, 3 is today's. `fresh` decides
 * whether the restarted process may serve it without a refresh.
 */
export async function seedThingsCatalog(
  storage: KVStorage,
  tools: ToolDef[],
  { version, fresh }: { version: 2 | 3; fresh: boolean },
): Promise<void> {
  const now = Date.now();
  const snapshot = await snapshotCatalog(tools);
  await storage.set(
    `catalog:things:chunk:${snapshot.fingerprint}:0`,
    new TextDecoder().decode(snapshot.serializedBytes),
  );
  await storage.set(
    "catalog:things",
    JSON.stringify({
      version,
      revision: snapshot.fingerprint,
      toolCount: tools.length,
      byteCount: snapshot.serializedBytes.byteLength,
      chunkCount: 1,
      fetchedAt: now - 1_000,
      expiresAt: fresh ? now + 600_000 : now - 1,
      staleUntil: now + 1_200_000,
    }),
  );
}

/** Each path's downstream, or one that refuses every connection. */
function transport(calls: string[], unavailable: boolean) {
  return unavailable
    ? () => throwingTransport(new Error("downstream unavailable"))
    : downstream(calls).transport;
}

export const STALE_SCHEMA_PATHS = {
  classify: (digest: string, calls: string[], unavailable = false): Connector =>
    remoteMcp("things", {
      url: "https://things.example/mcp",
      _transportFactory: transport(calls, unavailable),
      classify: {
        tools: {
          list_things: { verdict: "read", schemaDigest: digest },
          peek_things: { verdict: "read", schemaDigest: STALE },
          scan_things: { verdict: "read", schemaDigest: STALE },
        },
      },
    }),
  withVettedCatalog: (digest: string, calls: string[], unavailable = false): Connector =>
    withVettedCatalog(
      remoteMcp("things", {
        url: "https://things.example/mcp",
        _transportFactory: transport(calls, unavailable),
      }),
      vettedCatalog({
        reads: new Set(["list_things", "peek_things", "scan_things"]),
        writes: new Map(),
        schemaDigests: { list_things: digest, peek_things: STALE, scan_things: STALE },
      }),
    ),
};
