import { describe, expect, it } from "vitest";
import {
  compactOpenApi,
  expandIndexDetails,
  parseIndexDetails,
  type CompactIndex,
} from "../src/providers/_shared/rest/compact-index.js";
import { OperationIndex, type OpenApiData } from "../src/providers/_shared/rest/operation-index.js";

const metadata = {
  source: "https://example.com/api.json",
  revision: "fixed",
  digest: "sha256:fixed",
  version: "1",
  servers: ["https://example.com"],
  tags: ["records"],
  ops: [
    ["GET", "/records", "listRecords", "List records", 0],
    ["GET", "/other", "listOther", "List other", 0],
  ],
} as const;
const parameter = '["kind","query",0,{"e":["a","🙂"]}]';
const row = `[[${parameter}],0]`;
const root = `{"d":[],"o":[${row},${row}]}`;
const packed: CompactIndex = {
  length: root.length,
  definitions: "[]",
  parameters: [parameter],
  operations: [
    [[0], "0"],
    [[0], "0"],
  ],
};

describe("compact index decoding", () => {
  it(
    "INV-12: expands exact Unicode JSON text and refuses invalid references, expansion lengths and malformed rows",
    { tags: ["node"] },
    () => {
      expect(expandIndexDetails(packed)).toBe(root);
      for (const broken of [
        { ...packed, operations: [[[-1], "0"]] },
        { ...packed, operations: [[[1], "0"]] },
        { ...packed, operations: [[[0.5], "0"]] },
        { ...packed, length: packed.length - 1 },
        { ...packed, length: packed.length + 1 },
        { ...packed, length: 67108865 },
        { ...packed, length: -1 },
      ] as CompactIndex[])
        expect(() => expandIndexDetails(broken)).toThrow();
      const malformed = compactOpenApi({ ...metadata }, { ...packed, parameters: ["!"] });
      expect(() =>
        new OperationIndex(malformed, { vendor: "crm", title: "CRM" }).contract({
          method: "GET",
          path: "/records",
          operationId: "listRecords",
          summary: "List records",
          tag: "records",
          server: undefined,
          row: 0,
        }),
      ).toThrow();
    },
  );

  it(
    "INV-11: construction and a selected row never parse unrelated contracts or hash/decode the complete index",
    { tags: ["node"] },
    () => {
      const data = compactOpenApi(
        { ...metadata },
        {
          ...packed,
          operations: [
            [[0], "0"],
            [[1], "0"],
          ],
        },
      );
      const index = new OperationIndex(data, { vendor: "crm", title: "CRM" });
      expect(index.contract(index.ops[0]!).parameters[0]!.schema).toEqual({ enum: ["a", "🙂"] });
      expect(() => index.contract(index.ops[1]!)).toThrow("reference");
    },
  );

  it("INV-1: keeps fresh parse identity and replaceable logical properties", { tags: ["node"] }, () => {
    const data = compactOpenApi({ ...metadata }, packed);
    const first = new OperationIndex(data, { vendor: "crm", title: "CRM" });
    const second = new OperationIndex(data, { vendor: "crm", title: "CRM" });
    const contract = first.contract(first.ops[0]!);
    (contract.parameters[0]!.schema["enum"] as string[]).push("c");
    expect(first.contract(first.ops[0]!).parameters[0]!.schema["enum"]).toEqual(["a", "🙂", "c"]);
    expect(first.contract(first.ops[1]!).parameters[0]!.schema["enum"]).toEqual(["a", "🙂"]);
    expect(second.contract(second.ops[0]!).parameters[0]!.schema["enum"]).toEqual(["a", "🙂"]);
    expect(data.details).toBe(root);
    (data as { details: string }).details = '{"d":[],"o":[0,0]}';
    expect(parseIndexDetails(data)).toEqual({ d: [], o: [0, 0] });
    expect(new OperationIndex(data, { vendor: "crm", title: "CRM" }).contract(first.ops[0]!).parameters).toEqual([]);
    const plain: OpenApiData = { ...metadata, details: root };
    expect(parseIndexDetails(plain)).toEqual(JSON.parse(root));
  });

  it(
    "INV-1: retains the existing sharing of schema refs, defaults and recursive request graphs",
    { tags: ["node"] },
    () => {
      const definitions = [{ t: "object", p: { status: { e: ["a", "b"] } }, r: ["status"] }];
      const body = ["application/json", { $: 0 }, 1];
      const details = JSON.stringify({
        d: definitions,
        o: [
          [[], body],
          [[], body],
        ],
      });
      const encoded: CompactIndex = {
        length: details.length,
        definitions: JSON.stringify(definitions),
        parameters: [],
        operations: [
          [[], JSON.stringify(body)],
          [[], JSON.stringify(body)],
        ],
      };
      const mutate = (data: OpenApiData) => {
        const index = new OperationIndex(data, { vendor: "crm", title: "CRM" });
        const schema = index.contract(index.ops[0]!).body!.schema;
        (schema["required"] as string[]).push("extra");
        return index.ops.map((op) => index.contract(op));
      };
      expect(mutate(compactOpenApi({ ...metadata }, encoded))).toEqual(mutate({ ...metadata, details }));
      const requestSchemas = JSON.stringify({
        definitions: {
          Node: {
            type: ["object", "null"],
            properties: {
              child: { $ref: "#/$defs/Node" },
              count: { type: "integer", minimum: 1, maximum: 4, default: 2 },
            },
            required: ["count"],
          },
        },
        roots: [{ $ref: "#/$defs/Node" }, { $ref: "#/$defs/Node" }],
      });
      expect(mutate(compactOpenApi({ ...metadata, requestSchemas }, encoded))).toEqual(
        mutate({ ...metadata, requestSchemas, details }),
      );
    },
  );

  it(
    "INV-12: native Web Crypto binds the same Unicode content and policy to the same cursor bytes",
    { tags: ["workers"] },
    async () => {
      const data = compactOpenApi({ ...metadata }, packed);
      const logical = { ...metadata, details: root };
      for (const policy of [{}, { slashParams: ["key", "path"] }, { pathMatching: "uri-template" as const }]) {
        const names = { vendor: "crm", title: "CRM", ...policy };
        const before = new OperationIndex(logical, names);
        const after = new OperationIndex(data, names);
        expect(await after.cursorRevision()).toBe(await before.cursorRevision());
        expect(await after.cursorRevision()).not.toBe(
          await new OperationIndex({ ...logical, details: root.replace("🙂", "🙃") }, names).cursorRevision(),
        );
      }
    },
  );
});
