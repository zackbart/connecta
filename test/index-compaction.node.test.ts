// Node-only: runs the offline generator and discovers every maintained provider.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { compactOpenApi, type CompactIndex } from "../src/providers/_shared/rest/compact-index.js";
import { OperationIndex, type OpenApiData } from "../src/providers/_shared/rest/operation-index.js";
import { canonicalJson } from "../src/canonical-json.js";

const { discoverProviders } = await import(new URL("../scripts/providers.mjs", import.meta.url).href);
const { compactIndex } = (await import(new URL("../scripts/compact-index.mjs", import.meta.url).href)) as {
  compactIndex(data: OpenApiData): CompactIndex;
};
const { buildOperationIndex, readOpenApiSource, composeOpenApi } = await import(
  new URL("../scripts/generate-openapi.mjs", import.meta.url).href
);
const providers = await discoverProviders();
const names = { vendor: "crm", title: "CRM" };
const pack = (logical: OpenApiData) => {
  const { details: _details, ...metadata } = logical;
  return compactOpenApi(metadata, compactIndex(logical));
};
const refused = (call: () => unknown) => {
  try {
    call();
    return "accepted";
  } catch (error) {
    return error instanceof Error
      ? JSON.stringify({ ...error, name: error.name, message: error.message })
      : String(error);
  }
};

describe("lossless generated indexes", () => {
  for (const provider of providers) {
    it(`INV-1 INV-11: ${provider.name} preserves every pinned contract, field, search result, refusal and content identity`, async () => {
      if (["overflow", "tithely"].includes(provider.name)) {
        // These two indexes are derived from kit declarations and do not use
        // generated physical storage. Their complete contracts stay covered.
        const api = await import(pathToFileURL(join(provider.directory, "api.ts")).href);
        const index: OperationIndex = api[`${provider.name.toUpperCase()}_INDEX`];
        expect(index.ops.length).toBeGreaterThan(0);
        for (const op of index.ops) expect(index.contract(op).path).toBe(op.path);
        return;
      }
      const { openapi: generated } = (await import(
        pathToFileURL(join(provider.directory, "openapi.generated.ts")).href
      )) as { openapi: OpenApiData };
      const logical: OpenApiData = JSON.parse(JSON.stringify(generated));
      const source = await readOpenApiSource(provider.directory);
      if (source.vendored || source.documents) {
        const document = source.documents
          ? (await composeOpenApi(provider.directory, source)).document
          : JSON.parse(await readFile(join(provider.directory, "evidence/openapi.document.json"), "utf8"));
        expect(canonicalJson(buildOperationIndex(document, source))).toBe(canonicalJson(logical));
      }
      const packed = compactIndex(logical);
      expect(compactIndex(logical)).toEqual(packed);
      expect(canonicalJson(pack(logical))).toBe(canonicalJson(logical));
      const previous = new OperationIndex(logical, names);
      const next = new OperationIndex(generated, names);
      expect(next.ops).toEqual(previous.ops);
      for (const op of previous.ops) {
        expect(next.contract(op)).toEqual(previous.contract(op));
        expect(next.fields(op)).toEqual(previous.fields(op));
        expect(next.bodyType(op)).toEqual(previous.bodyType(op));
        expect(refused(() => next.check(op, { _unknown_compaction_control: 1 }, undefined))).toBe(
          refused(() => previous.check(op, { _unknown_compaction_control: 1 }, undefined)),
        );
      }
      for (const query of [
        "list",
        "people",
        "person",
        "create thing",
        "",
        ...(previous.ops.length < 100 ? ["/unknown", previous.ops[0]!.path] : []),
      ]) {
        for (const partial of [true, false])
          expect(next.search(query, { partial, limit: 25 })).toEqual(previous.search(query, { partial, limit: 25 }));
      }
      for (const options of [{}, { slashParams: ["key"] }, { pathMatching: "uri-template" as const }]) {
        expect(await new OperationIndex(generated, { ...names, ...options }).cursorRevision()).toBe(
          await new OperationIndex(logical, { ...names, ...options }).cursorRevision(),
        );
      }
      // A same-length semantic mutation must still invalidate continuations.
      const changed = { ...logical, revision: `${logical.revision}!` };
      expect(await new OperationIndex(pack(changed), names).cursorRevision()).not.toBe(await previous.cursorRevision());
    }, 120_000);
  }
});
