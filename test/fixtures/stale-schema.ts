// Reviewed reads with recorded schema digests, served through both
// classification wrappers: `list_things` matches its digest, `peek_things`
// (silent) and `scan_things` (claiming `readOnlyHint: true`) have changed
// schemas since review.
import { z } from "zod";
import {
  vettedCatalog,
  vettedSchemaDigest,
  withVettedCatalog,
} from "../../src/catalog-drift.js";
import { remoteMcp } from "../../src/connectors/remote-mcp.js";
import type { Connector } from "../../src/types.js";
import { required } from "../helpers.js";
import { httpDownstream } from "./downstream-mcp.js";
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

/** The digest a review would record for the live `list_things`. */
export async function currentDigest(): Promise<string> {
  const plain = remoteMcp("things", {
    url: "https://things.example/mcp",
    _transportFactory: downstream([]).transport,
  });
  const ctx = connectorContext();
  try {
    const listed = await plain.listTools(ctx);
    return vettedSchemaDigest(required(listed.find((tool) => tool.name === "list_things")));
  } finally {
    await plain.closeScope?.(ctx);
  }
}

export const STALE_SCHEMA_PATHS = {
  classify: (digest: string, calls: string[]): Connector =>
    remoteMcp("things", {
      url: "https://things.example/mcp",
      _transportFactory: downstream(calls).transport,
      classify: {
        tools: {
          list_things: { verdict: "read", schemaDigest: digest },
          peek_things: { verdict: "read", schemaDigest: STALE },
          scan_things: { verdict: "read", schemaDigest: STALE },
        },
      },
    }),
  withVettedCatalog: (digest: string, calls: string[]): Connector =>
    withVettedCatalog(
      remoteMcp("things", {
        url: "https://things.example/mcp",
        _transportFactory: downstream(calls).transport,
      }),
      vettedCatalog({
        reads: new Set(["list_things", "peek_things", "scan_things"]),
        writes: new Map(),
        schemaDigests: { list_things: digest, peek_things: STALE, scan_things: STALE },
      }),
    ),
};
