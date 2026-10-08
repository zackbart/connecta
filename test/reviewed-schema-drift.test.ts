// A reviewed read vouches for the schema its review read. When the live
// schema no longer matches the recorded digest, or the digest cannot be
// checked, the tool is a write on every public path (INV-1): discovery at the
// top level and inside a program, `call_tool`, and a program's call. Both
// classification wrappers share this rule, so each case runs through
// `remoteMcp({ classify })` and the legacy `withVettedCatalog()`. The rule
// holds for a catalog a restarted process finds in storage too: the cache
// keeps downstream facts, and every read classifies them again.

import { afterEach, describe, expect, it, vi } from "vitest";
import { memoryStorage } from "../src/storage/memory.js";
import type { ToolDef } from "../src/types.js";
import {
  STALE_SCHEMA_PATHS as PATHS,
  currentDigest,
  downstreamListing,
  mainEraListing,
  seedThingsCatalog,
} from "./fixtures/stale-schema.js";
import { thingsDeployment as deployment } from "./fixtures/things-deployment.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe.each(Object.keys(PATHS) as Array<keyof typeof PATHS>)(
  "a reviewed read whose schema digest no longer matches (%s)",
  (path) => {
    it("INV-1: is discovered as a write at the top level and inside a program", async () => {
      const app = deployment(PATHS[path](await currentDigest(), []));
      try {
        expect(await app.searched("readOnly")).toEqual(["things.list_things"]);
        expect(await app.searched("approvalRequired")).toEqual([
          "things.peek_things",
          "things.scan_things",
        ]);
        const found = await app.run(async (connecta) => {
          const page = await connecta.search!({ connector: "things", query: "", safety: "readOnly" });
          return page.tools.map((tool: { address: string }) => tool.address).sort();
        });
        expect(found.structuredContent?.result).toEqual(["things.list_things"]);
      } finally {
        await app.connecta.close();
      }
    });

    it("INV-1: is refused by call_tool and dispatched only by call_destructive_tool", async () => {
      const calls: string[] = [];
      const app = deployment(PATHS[path](await currentDigest(), calls));
      try {
        expect((await app.call("call_tool", { address: "things.list_things", args: {} })).isError)
          .toBeFalsy();
        for (const address of ["things.peek_things", "things.scan_things"]) {
          const refused = await app.call("call_tool", { address, args: {} });
          expect(refused.isError).toBe(true);
          expect(JSON.stringify(refused.structuredContent)).toContain(
            "destructive_tool_requires_approval",
          );
        }
        expect(calls).toEqual(["list_things"]);
        const approved = await app.call("call_destructive_tool", {
          address: "things.peek_things",
          args: {},
        });
        expect(approved.isError).toBeFalsy();
        expect(calls).toEqual(["list_things", "peek_things"]);
      } finally {
        await app.connecta.close();
      }
    });

    it("INV-1: is refused inside execute_code before it is sent", async () => {
      const calls: string[] = [];
      const app = deployment(PATHS[path](await currentDigest(), calls));
      try {
        const result = await app.run(async (connecta) => {
          await connecta.call!("things.list_things", {});
          const refused: string[] = [];
          for (const address of ["things.peek_things", "things.scan_things"]) {
            try {
              await connecta.call!(address, {});
            } catch (error) {
              refused.push(String((error as Error).message));
            }
          }
          return refused;
        });
        const refused = result.structuredContent?.result as string[];
        expect(refused).toHaveLength(2);
        for (const message of refused) {
          expect(message).toContain("destructive_tool_requires_approval");
        }
        expect(calls).toEqual(["list_things"]);
      } finally {
        await app.connecta.close();
      }
    });

    it("INV-1: becomes a write with every other digested review when the digest cannot be checked", async () => {
      const digest = await currentDigest();
      const calls: string[] = [];
      const app = deployment(PATHS[path](digest, calls));
      // Only the schema digest fails; the catalog cache hashes with the same
      // primitive and must keep working.
      const digestBytes = crypto.subtle.digest.bind(crypto.subtle);
      vi.spyOn(crypto.subtle, "digest").mockImplementation(async (algorithm, data) => {
        if (new TextDecoder().decode(data as Uint8Array).startsWith('{"inputSchema"')) {
          throw new Error("digest unavailable");
        }
        return digestBytes(algorithm, data);
      });
      try {
        expect(await app.searched("readOnly")).toEqual([]);
        const refused = await app.call("call_tool", { address: "things.list_things", args: {} });
        expect(refused.isError).toBe(true);
        expect(JSON.stringify(refused.structuredContent)).toContain(
          "destructive_tool_requires_approval",
        );
        expect(calls).toEqual([]);
      } finally {
        await app.connecta.close();
      }
    });
  },
);

const RESTARTS: Array<{
  name: string;
  version: 2 | 3;
  fresh: boolean;
  listing: () => Promise<ToolDef[]>;
}> = [
  { name: "a fresh 0.28 catalog", version: 2, fresh: true, listing: mainEraListing },
  { name: "a stale 0.28 catalog", version: 2, fresh: false, listing: mainEraListing },
  { name: "a fresh catalog", version: 3, fresh: true, listing: downstreamListing },
  { name: "a stale catalog", version: 3, fresh: false, listing: downstreamListing },
];

describe.each(Object.keys(PATHS) as Array<keyof typeof PATHS>)(
  "a stale reviewed read after a restart (%s)",
  (path) => {
    it.each(RESTARTS)(
      "INV-1: stays a write when the downstream is unavailable and $name is all there is",
      async ({ version, fresh, listing }) => {
        const storage = memoryStorage();
        await seedThingsCatalog(storage, await listing(), { version, fresh });
        const app = deployment(PATHS[path](await currentDigest(), [], true), storage);
        try {
          expect(await app.searched("readOnly")).toEqual(["things.list_things"]);
          expect(await app.searched("approvalRequired")).toEqual([
            "things.peek_things",
            "things.scan_things",
          ]);
          for (const address of ["things.peek_things", "things.scan_things"]) {
            const refused = await app.call("call_tool", { address, args: {} });
            expect(refused.isError).toBe(true);
            expect(JSON.stringify(refused.structuredContent)).toContain(
              "destructive_tool_requires_approval",
            );
          }
          const result = await app.run(async (connecta) => {
            const page = await connecta.search!({ connector: "things", query: "", safety: "readOnly" });
            const refused: string[] = [];
            for (const address of ["things.peek_things", "things.scan_things"]) {
              try {
                await connecta.call!(address, {});
              } catch (error) {
                refused.push(String((error as Error).message));
              }
            }
            return { readOnly: page.tools.map((tool: { address: string }) => tool.address), refused };
          });
          const ran = result.structuredContent?.result as { readOnly: string[]; refused: string[] };
          expect(ran.readOnly).toEqual(["things.list_things"]);
          expect(ran.refused).toHaveLength(2);
          for (const message of ran.refused) {
            expect(message).toContain("destructive_tool_requires_approval");
          }
        } finally {
          await app.connecta.close();
        }
      },
    );

    it("INV-1: refreshes a fresh 0.28 catalog and persists the downstream facts", async () => {
      const storage = memoryStorage();
      await seedThingsCatalog(storage, await mainEraListing(), { version: 2, fresh: true });
      const calls: string[] = [];
      const app = deployment(PATHS[path](await currentDigest(), calls), storage);
      try {
        expect(await app.searched("readOnly")).toEqual(["things.list_things"]);
        const refused = await app.call("call_tool", { address: "things.scan_things", args: {} });
        expect(JSON.stringify(refused.structuredContent)).toContain(
          "destructive_tool_requires_approval",
        );
        expect(calls).toEqual([]);
        // The refresh replaced the 0.28 catalog with what the downstream said,
        // and nothing connecta derived from it.
        await vi.waitFor(async () => {
          expect(JSON.parse(String(await storage.get("catalog:things"))).version).toBe(3);
        });
        const manifest = JSON.parse(String(await storage.get("catalog:things")));
        const persisted = JSON.parse(String(
          await storage.get(`catalog:things:chunk:${manifest.revision}:0`),
        )) as ToolDef[];
        expect(persisted).toEqual(await downstreamListing());
      } finally {
        await app.connecta.close();
      }
    });
  },
);
