// Node-only: executes the generator against temporary provider folders.
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../scripts/generate-providers.mjs", import.meta.url));

/** The maintainer OpenAPI compiler, typed for these tests (it is plain ESM). */
interface OpenApiGenerator {
  buildOperationIndex(document: unknown, source: object): any;
  renderOpenApiModule(data: unknown, source: object): string;
  sha256(bytes: string | Uint8Array): string;
}
const generator = async (): Promise<OpenApiGenerator> =>
  (await import(new URL("../scripts/generate-openapi.mjs", import.meta.url).href)) as OpenApiGenerator;
const directories: string[] = [];
const read = (root: string, path: string) => readFileSync(join(root, path), "utf8");
const json = (root: string, path: string) => JSON.parse(read(root, path));
const write = (root: string, path: string, content: string) => writeFileSync(join(root, path), content);

function run(root: string, check = false) {
  return spawnSync(process.execPath, [script, "--root", root, ...(check ? ["--check"] : [])], {
    encoding: "utf8",
    timeout: 30_000,
  });
}

function repository() {
  const root = mkdtempSync(join(tmpdir(), "connecta-provider-generation-"));
  directories.push(root);
  for (const folder of ["src/providers/_shared", "scripts", "test"]) mkdirSync(join(root, folder), { recursive: true });
  write(root, "src/providers/_shared/helpers.ts", "export const helper = true;\n");
  write(
    root,
    "package.json",
    JSON.stringify(
      {
        name: "fixture",
        type: "module",
        exports: {
          ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
          "./providers/retired": { types: "./dist/providers/retired.d.ts", import: "./dist/providers/retired.js" },
          "./worker": { types: "./dist/worker.d.ts", import: "./dist/worker.js" },
        },
      },
      null,
      2,
    ) + "\n",
  );
  write(
    root,
    "knip.jsonc",
    '{\n  // Keep this comment and the Worker entry.\n  "entry": [\n    "src/index.ts",\n    "src/providers/retired.ts",\n    "src/worker.ts"\n  ],\n  "project": ["src/**/*.ts"]\n}\n',
  );
  write(
    root,
    "scripts/bundle-budget.json",
    JSON.stringify(
      {
        notes: ["Root note", "./providers/retired old note", "Worker note"],
        entries: {
          ".": { baselineGzip: 50, maxGzip: 101 },
          "./providers/retired": { baselineGzip: 10, maxGzip: 13 },
          "./worker": { baselineGzip: 30, maxGzip: 75 },
        },
      },
      null,
      2,
    ) + "\n",
  );
  write(
    root,
    "README.md",
    "# Fixture\n\n- **Use maintained connections** for Retired: known endpoints, auth defaults, and\n  vetted read/write classifications, imported one at a time.\n\nUnrelated text.\n",
  );
  return root;
}

function provider(root: string, name: string, node = false) {
  const folder = `src/providers/${name}`;
  mkdirSync(join(root, folder));
  write(
    root,
    `${folder}/index.ts`,
    `import { skill } from "./skill.generated.js";
export const factory = Object.assign((id: string, options: object) => ({ id, kind: "api", options, staticTools: [{ name: "list_items" }] }), {
  definition: { name: ${JSON.stringify(name)}, title: ${JSON.stringify(name.toUpperCase())}, readme: ${JSON.stringify(`Vendor ${name}`)}, kind: "api", skill,
    bundle: { baselineGzip: 17, maxGzip: 23, note: ${JSON.stringify(`./providers/${name} reviewed cap`)} } }
});\n`,
  );
  write(
    root,
    `${folder}/SKILL.md`,
    `---\n${JSON.stringify({ name, instructionsHeading: "Deployment instructions" })}\n---\n\n<!-- fragment: content -->\n  Keep spaces.\n\n<!-- endfragment -->\n\n<!-- fragment: footer -->\nTail without final newline<!-- endfragment -->\n`,
  );
  write(
    root,
    `${folder}/fixtures.ts`,
    `import { factory } from "./index.js";
export const fixture = { name: ${JSON.stringify(name)}, options: { purpose: "fixture" }, cases: [{ label: "default", options: {} }],
  create(id = "fixture", overrides = {}) { return factory(id, { purpose: "fixture", ...overrides }); }
};\n`,
  );
  write(root, `${folder}/drift.json`, '{"kind":"manual","reason":"fixture"}\n');
  write(
    root,
    `${folder}/provider${node ? ".node" : ""}.test.ts`,
    node ? "// Node-only: fixture.\n" : "// Portable fixture.\n",
  );
}

function snapshot(root: string, prefix = ""): Record<string, { content: string; mtime: number }> {
  const files: Record<string, { content: string; mtime: number }> = {};
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) Object.assign(files, snapshot(root, path));
    else files[path] = { content: read(root, path), mtime: statSync(join(root, path)).mtimeMs };
  }
  return files;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("provider folder generation", () => {
  it("adds a provider to every generated membership without central edits and excludes _shared", () => {
    const root = repository();
    provider(root, "alpha");
    const first = run(root);
    expect(first.status, first.stderr).toBe(0);
    provider(root, "beta", true);
    const second = run(root);
    expect(second.status, second.stderr).toBe(0);
    const manifest = json(root, "package.json");
    expect(Object.keys(manifest.exports)).toEqual([".", "./providers/alpha", "./providers/beta", "./worker"]);
    expect(manifest.exports["./providers/beta"]).toEqual({
      types: "./dist/providers/beta/index.d.ts",
      import: "./dist/providers/beta/index.js",
    });
    expect(manifest.exports["./worker"]).toEqual({ types: "./dist/worker.d.ts", import: "./dist/worker.js" });
    const knip = read(root, "knip.jsonc");
    expect(knip).toContain("// Keep this comment and the Worker entry.");
    expect(knip).toContain('"src/worker.ts"');
    expect(knip).toContain('"src/providers/beta/index.ts"');
    expect(knip).not.toContain("retired");
    const budgets = json(root, "scripts/bundle-budget.json");
    expect(budgets.entries["./providers/beta"]).toEqual({ baselineGzip: 17, maxGzip: 23 });
    expect(budgets.entries["."]).toEqual({ baselineGzip: 50, maxGzip: 101 });
    expect(budgets.entries["./worker"]).toEqual({ baselineGzip: 30, maxGzip: 75 });
    expect(budgets.notes).toEqual([
      "Root note",
      "Worker note",
      "./providers/alpha reviewed cap",
      "./providers/beta reviewed cap",
    ]);
    const fixtures = read(root, "test/providers.generated.ts");
    expect(fixtures).toContain("../src/providers/beta/fixtures.js");
    expect(fixtures).toContain("export const providerFixtures");
    const smoke = read(root, "scripts/provider-smoke.generated.mjs");
    expect(smoke).toContain('"@zackbart/connecta/providers/beta"');
    expect(smoke).toContain("export {\n  fixtures\n}");
    expect(smoke).not.toContain("definition:");
    expect(fixtures + smoke + knip + JSON.stringify(manifest.exports)).not.toContain("_shared");
    expect(read(root, "README.md")).toContain("Vendor alpha, and Vendor beta");
    expect(read(root, "README.md")).toContain("Unrelated text.");
    expect(run(root, true).status).toBe(0);
    // Run the bundled fixtures with fake installed subpaths. Their factory is
    // deliberately different from the source factory: bundling that source
    // accidentally would make this fail even though the import smoke passed.
    const installed = join(root, "node_modules/@zackbart/connecta");
    mkdirSync(installed, { recursive: true });
    writeFileSync(
      join(installed, "package.json"),
      JSON.stringify({
        type: "module",
        exports: {
          "./providers/alpha": "./alpha.mjs",
          "./providers/beta": "./beta.mjs",
        },
      }),
    );
    for (const name of ["alpha", "beta"]) {
      writeFileSync(
        join(installed, `${name}.mjs`),
        'export const factory = (id, options) => ({ id, options, kind: "installed" });\n',
      );
    }
    const packed = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import { fixtures } from "./scripts/provider-smoke.generated.mjs";
      if (fixtures.length !== 2 || fixtures.some((fixture) => fixture.create("packed").kind !== "installed")) process.exit(1);
    `,
      ],
      { cwd: root, encoding: "utf8", timeout: 10_000 },
    );
    expect(packed.status, packed.stderr).toBe(0);
  });

  it("computes current skills before imports and checks freshness without creating or changing files", () => {
    const root = repository();
    provider(root, "alpha");
    const before = snapshot(root);
    const missing = run(root, true);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("src/providers/alpha/skill.generated.ts");
    expect(missing.stderr).toContain("scripts/provider-smoke.generated.mjs");
    expect(snapshot(root)).toEqual(before);
    expect(run(root).status).toBe(0);
    const skillSource = read(root, "src/providers/alpha/skill.generated.ts");
    const skill = JSON.parse(skillSource.slice(skillSource.indexOf("= ") + 2, skillSource.lastIndexOf(" as const")));
    expect(skill.content).toBe("  Keep spaces.\n\n");
    expect(skill.fragments.footer).toBe("Tail without final newline");
    write(root, "src/providers/alpha/skill.generated.ts", 'throw new Error("stale skill must not load");\n');
    const staleSnapshot = snapshot(root);
    const stale = run(root, true);
    expect(stale.status).toBe(1);
    expect(stale.stderr).toContain("Stale provider outputs");
    expect(snapshot(root)).toEqual(staleSnapshot);
    expect(run(root).status).toBe(0);
    expect(run(root, true).status).toBe(0);
  });

  it.each(["index.ts", "SKILL.md", "drift.json", "fixtures.ts", "provider.test.ts"])(
    "rejects a missing required %s with a provider-specific error",
    (file) => {
      const root = repository();
      provider(root, "alpha");
      unlinkSync(join(root, "src/providers/alpha", file));
      const before = snapshot(root);
      const result = run(root);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        `src/providers/alpha: missing required file ${file === "provider.test.ts" ? "provider.node.test.ts" : file}`,
      );
      expect(snapshot(root)).toEqual(before);
    },
  );

  it("rejects malformed or duplicated skill fragments before writing outputs", () => {
    const root = repository();
    provider(root, "alpha");
    const skill = "src/providers/alpha/SKILL.md";
    write(root, skill, read(root, skill) + "<!-- fragment: content -->\nDuplicate<!-- endfragment -->\n");
    const before = snapshot(root);
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("providers/alpha: duplicate skill fragment content");
    expect(snapshot(root)).toEqual(before);
  });

  it("joins fragments verbatim when content is absent and checks all memberships for drift", () => {
    const root = repository();
    provider(root, "alpha");
    const path = "src/providers/alpha/SKILL.md";
    write(root, path, read(root, path).replace("fragment: content", "fragment: intro"));
    expect(run(root).status).toBe(0);
    const source = read(root, "src/providers/alpha/skill.generated.ts");
    const skill = JSON.parse(source.slice(source.indexOf("= ") + 2, source.lastIndexOf(" as const")));
    expect(skill.content).toBe("  Keep spaces.\n\nTail without final newline");
    const outputs = [
      "package.json",
      "knip.jsonc",
      "scripts/bundle-budget.json",
      "README.md",
      "test/providers.generated.ts",
      "scripts/provider-smoke.generated.mjs",
    ];
    for (const output of outputs) {
      const original = read(root, output);
      const changed =
        output === "knip.jsonc"
          ? original.replace("src/providers/alpha/index.ts", "src/providers/retired.ts")
          : output === "README.md"
            ? original.replace("Vendor alpha", "Retired")
            : original + "\n";
      write(root, output, changed);
      const before = snapshot(root);
      const result = run(root, true);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(output);
      expect(snapshot(root)).toEqual(before);
      write(root, output, original);
    }
  });

  it("publishes the fragment the frontmatter names as content, so a dual guide never mixes modes", () => {
    const root = repository();
    provider(root, "alpha");
    const path = "src/providers/alpha/SKILL.md";
    const original = read(root, path);
    const named = (content: string) =>
      original.replace(
        '"instructionsHeading":"Deployment instructions"}',
        `"instructionsHeading":"Deployment instructions","content":${JSON.stringify(content)}}`,
      );
    write(root, path, named("footer"));
    expect(run(root).status).toBe(0);
    const source = read(root, "src/providers/alpha/skill.generated.ts");
    const skill = JSON.parse(source.slice(source.indexOf("= ") + 2, source.lastIndexOf(" as const")));
    expect(skill.content).toBe("Tail without final newline");
    expect(Object.keys(skill.fragments)).toEqual(["content", "footer"]);
    write(root, path, named("missing"));
    const before = snapshot(root);
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("providers/alpha: SKILL.md frontmatter content must name one of its fragments");
    expect(snapshot(root)).toEqual(before);
  });

  it("checks each operation index against its pinned source offline and never regenerates it", async () => {
    const { buildOperationIndex, renderOpenApiModule, sha256 } = await generator();
    const root = repository();
    provider(root, "alpha");
    expect(run(root).status).toBe(0);
    const document = JSON.stringify({ openapi: "3.0.0", info: { version: "1" }, paths: { "/v1/items": { get: {} } } });
    const source = { url: "https://vendor.example/openapi.json", revision: "r1", digest: sha256(document) };
    write(root, "src/providers/alpha/openapi.source.json", JSON.stringify(source));
    const stale = run(root, true);
    expect(stale.status).toBe(1);
    expect(stale.stderr).toContain("Operation indexes differ from openapi.source.json (run providers:spec)");
    expect(stale.stderr).toContain("src/providers/alpha/openapi.generated.ts");
    const generated = renderOpenApiModule(buildOperationIndex(JSON.parse(document), source), source);
    write(root, "src/providers/alpha/openapi.generated.ts", generated);
    expect(run(root, true).status).toBe(0);
    write(root, "src/providers/alpha/openapi.source.json", JSON.stringify({ ...source, options: { depth: 1 } }));
    expect(run(root, true).stderr).toContain("src/providers/alpha/openapi.generated.ts");
    write(root, "src/providers/alpha/openapi.source.json", JSON.stringify({ ...source, revision: "r2" }));
    const before = snapshot(root);
    const moved = run(root, true);
    expect(moved.status).toBe(1);
    expect(moved.stderr).toContain("src/providers/alpha/openapi.generated.ts");
    // The offline pass reports; only the network-backed providers:spec writes an index.
    expect(snapshot(root)).toEqual(before);
    expect(run(root).status).toBe(1);
    expect(read(root, "src/providers/alpha/openapi.generated.ts")).toBe(generated);
  });
});

describe("OpenAPI operation index generation", () => {
  const document = {
    openapi: "3.0.0",
    info: { version: "2026-09-30.test" },
    servers: [{ url: "https://api.vendor.example/" }],
    components: {
      schemas: {
        address: {
          type: "object",
          description: "<p>Postal address.</p> More prose.",
          properties: { city: { type: "string", maxLength: 5000 }, line1: { type: "string" } },
        },
      },
    },
    paths: {
      "/v1/things": {
        get: {
          operationId: "GetThings",
          summary: "List things",
          parameters: [
            { name: "limit", in: "query", schema: { type: "integer" }, description: "A limit. Ignored prose." },
            {
              name: "created",
              in: "query",
              style: "deepObject",
              schema: { type: "object", properties: { gte: { type: "integer" } } },
            },
          ],
        },
        post: {
          operationId: "PostThings",
          summary: "Create a thing",
          requestBody: {
            content: {
              "application/x-www-form-urlencoded": {
                schema: {
                  type: "object",
                  required: ["name"],
                  properties: {
                    name: { type: "string", description: "The name." },
                    shipping: { $ref: "#/components/schemas/address" },
                    billing: { $ref: "#/components/schemas/address" },
                    deep: {
                      type: "object",
                      properties: { inner: { type: "object", properties: { leaf: { type: "string" } } } },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/v1/things/{thing}": {
        delete: {
          operationId: "DeleteThing",
          summary: "Delete a thing",
          parameters: [{ name: "thing", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            content: { "application/x-www-form-urlencoded": { schema: { type: "object", properties: {} } } },
          },
        },
        get: { operationId: "GetThing", summary: "Old", deprecated: true },
      },
      "/v1/uploads": {
        post: {
          operationId: "PostUploads",
          summary: "Upload",
          servers: [{ url: "https://files.vendor.example/" }],
          requestBody: {
            content: {
              "multipart/form-data": {
                schema: { type: "object", properties: { file: { type: "string", format: "binary" } } },
              },
            },
          },
        },
      },
    },
  };
  const source = { url: "https://vendor.example/r1.json", revision: "r1", digest: `sha256:${"0".repeat(64)}` };

  it("drops deprecated operations, records per-operation servers, and shares repeated schema nodes", async () => {
    const { buildOperationIndex } = await generator();
    const data = buildOperationIndex(document, { ...source, options: { depth: 2, descriptions: 40 } });
    expect(data.version).toBe("2026-09-30.test");
    expect(data.servers).toEqual(["https://api.vendor.example", "https://files.vendor.example"]);
    expect(data.ops.map((row: unknown[]) => `${row[0]} ${row[1]}`)).toEqual([
      "GET /v1/things",
      "POST /v1/things",
      "DELETE /v1/things/{thing}",
      "POST /v1/uploads",
    ]);
    expect(data.ops[3]).toEqual(["POST", "/v1/uploads", "PostUploads", "Upload", 1, 1]);
    const details = JSON.parse(data.details);
    // The repeated address schema is one shared node referenced twice.
    const create = details.o[1][1][1];
    expect(create.p.shipping).toEqual({ $: expect.any(Number) });
    expect(create.p.billing).toEqual(create.p.shipping);
    expect(details.d[create.p.shipping.$]).toEqual({
      t: "object",
      d: "Postal address.",
      p: { city: { t: "string" }, line1: { t: "string" } },
    });
    // Past the depth an object keeps its type and is marked truncated; top-level descriptions are clipped.
    expect(create.p.deep).toEqual({ t: "object", p: { inner: { t: "object", x: 1 } } });
    expect(details.o[0][0]).toEqual([
      ["limit", "query", 0, { t: "integer" }, "A limit."],
      ["created", "query", 0, { t: "object", p: { gte: { t: "integer" } } }],
    ]);
    // An empty form body is no body at all.
    expect(details.o[2]).toEqual([[["thing", "path", 1, { t: "string" }]], 0]);
  });

  it("reads the API version from a named header parameter when info.version is not the sent version", async () => {
    const { buildOperationIndex } = await generator();
    const versioned = (values: string[]) => ({
      openapi: "3.1.0",
      info: { title: "Vendor", version: "1.0.0" },
      servers: [{ url: "https://api.vendor.example" }],
      components: {
        parameters: { version: { name: "Vendor-Version", in: "header", required: true, schema: { enum: values } } },
      },
      paths: { "/v1/things": { get: { parameters: [{ $ref: "#/components/parameters/version" }] } } },
    });
    const options = { versionHeader: "vendor-version" };
    expect(buildOperationIndex(versioned(["2026-03-11"]), { ...source, options }).version).toBe("2026-03-11");
    expect(buildOperationIndex(versioned(["2026-03-11"]), source).version).toBe("1.0.0");
    // Two offered versions would pin one silently, so generation refuses.
    expect(() => buildOperationIndex(versioned(["2025-09-03", "2026-03-11"]), { ...source, options })).toThrow(
      "expected one vendor-version header value in the document, found 2",
    );
  });

  it("shrinks a large document on request: no restated ids, implied path parameters, and a per-operation budget", async () => {
    const { buildOperationIndex } = await generator();
    const options = { depth: 2, descriptions: 0, operationIds: false, pathParams: "typed", opBudget: 60 };
    const data = buildOperationIndex(document, { ...source, options });
    expect(data.ops.map((row: unknown[]) => row[2])).toEqual(["", "", "", ""]);
    const details = JSON.parse(data.details);
    // The plain-string path parameter is dropped; the template still names it.
    expect(details.o[2]).toEqual(0);
    // Past the budget, the create body falls back to a shallower depth.
    expect(JSON.stringify(details.o[1]).length).toBeLessThan(
      JSON.stringify(JSON.parse(buildOperationIndex(document, { ...source, options: { depth: 2 } }).details).o[1])
        .length,
    );
    const { OperationIndex } = await import("../src/providers/_shared/rest/operation-index.js");
    const index = new OperationIndex(data, { vendor: "acme", title: "Acme" });
    const contract = index.contract(index.resolve("DELETE", "/v1/things/t_1").op);
    expect(contract.parameters).toEqual([{ name: "thing", in: "path", required: true, schema: { type: "string" } }]);
  });

  it("records credential-named success-response fields for value-safety review", async () => {
    const { buildOperationIndex } = await generator();
    const secretive = {
      openapi: "3.0.0",
      info: { version: "1" },
      paths: {
        "/v1/keys": {
          post: {
            summary: "Create a key",
            responses: {
              "200": {
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        result: {
                          type: "object",
                          properties: {
                            id: { type: "string" },
                            client_secret: { type: "string" },
                            password: { type: "string", writeOnly: true },
                            has_token: { type: "boolean" },
                            items: { type: "array", items: { properties: { apiKey: { type: "string" } } } },
                          },
                        },
                      },
                    },
                  },
                },
              },
              "400": { content: { "application/json": { schema: { properties: { token: { type: "string" } } } } } },
            },
          },
        },
        "/v1/plain": { get: { summary: "Plain", responses: { "200": { description: "ok" } } } },
      },
    };
    const data = buildOperationIndex(secretive, { ...source, options: { responseSecrets: true } });
    expect(data.secrets).toEqual([[0, "result.client_secret", "result.items[].apiKey"]]);
    expect(buildOperationIndex(secretive, source).secrets).toBeUndefined();
  });

  it("round-trips through the runtime index: resolve, search, contract, and validation", async () => {
    const { buildOperationIndex } = await generator();
    const { OperationIndex } = await import("../src/providers/_shared/rest/operation-index.js");
    const index = new OperationIndex(buildOperationIndex(document, source), { vendor: "acme", title: "Acme" });
    expect(index.resolve("DELETE", "/v1/things/th_1")).toMatchObject({
      op: { path: "/v1/things/{thing}" },
      params: { thing: "th_1" },
    });
    expect(index.search("create thing", { limit: 5 }).map((op) => op.operationId)).toEqual(["PostThings"]);
    expect(index.contract(index.operation("POST", "/v1/things")!).body?.schema).toMatchObject({
      required: ["name"],
      properties: { shipping: { type: "object", properties: { city: { type: "string" } } } },
    });
    expect(() => index.check(index.operation("POST", "/v1/things")!, {}, { name: "x", shiping: {} })).toThrow(
      "/body/shiping (additionalProperties: shipping? one of",
    );
    expect(() => index.check(index.operation("POST", "/v1/things")!, {}, { deep: { inner: { anything: 1 } } })).toThrow(
      "/body/name (required: a value)",
    );
  });

  // Shapes from Cloudflare's and Vercel's documents: DNS records are oneOf
  // allOf (shared fields plus per-type fields), KV bulk writes take a root
  // array, uploads take binary, and Vercel serves HEAD for artifacts.
  const vendor = {
    openapi: "3.0.0",
    info: { version: "1" },
    servers: [{ url: "https://api.vendor.example/client/v4" }],
    components: {
      schemas: {
        base: {
          type: "object",
          required: ["name"],
          properties: { name: { type: "string" }, ttl: { type: "number" }, proxied: { type: "boolean" } },
        },
        a: {
          allOf: [
            { $ref: "#/components/schemas/base" },
            {
              type: "object",
              required: ["type", "content"],
              properties: { type: { type: "string", enum: ["A"] }, content: { type: "string", format: "ipv4" } },
            },
          ],
        },
        cname: {
          allOf: [
            { $ref: "#/components/schemas/base" },
            {
              properties: { type: { type: "string", enum: ["CNAME"] }, content: { type: "string" } },
              required: ["type", "content"],
            },
          ],
        },
      },
    },
    paths: {
      "/zones/{zone_id}/dns_records": {
        post: {
          operationId: "dns-records-create",
          parameters: [{ name: "zone_id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { oneOf: [{ $ref: "#/components/schemas/a" }, { $ref: "#/components/schemas/cname" }] },
              },
            },
          },
        },
      },
      "/accounts/{account_id}/storage/kv/namespaces/{namespace_id}/bulk": {
        put: {
          operationId: "kv-bulk-write",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: {
                    type: "object",
                    required: ["key", "value"],
                    properties: { key: { type: "string" }, value: { type: "string" }, metadata: {} },
                  },
                },
              },
            },
          },
        },
      },
      "/accounts/{account_id}/scripts/{name}/content": {
        put: {
          operationId: "script-content",
          requestBody: { content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } } },
        },
      },
      "/accounts/{account_id}/settings": {
        patch: {
          operationId: "settings",
          requestBody: {
            content: { "application/json": { schema: { type: "object", additionalProperties: true } } },
          },
        },
      },
      "/v8/artifacts/{hash}": { head: { operationId: "artifactExists", summary: "Check an artifact" } },
    },
  };

  it("folds allOf into complete oneOf alternatives, so misspelled and missing DNS fields are refused", async () => {
    const { buildOperationIndex } = await generator();
    const { OperationIndex } = await import("../src/providers/_shared/rest/operation-index.js");
    const index = new OperationIndex(buildOperationIndex(vendor, source), { vendor: "cf", title: "Cloudflare" });
    const create = index.resolve("POST", "/zones/z1/dns_records").op;
    const body = index.contract(create).body!;
    expect(body.required).toBe(true);
    expect((body.schema as any).anyOf).toHaveLength(2);
    expect((body.schema as any).anyOf[0]).toMatchObject({
      type: "object",
      required: ["name", "type", "content"],
      properties: { name: {}, ttl: {}, proxied: {}, type: { enum: ["A"] }, content: {} },
    });
    expect(() => index.check(create, {}, { type: "A", name: "www", content: "192.0.2.1", ttl: 60 })).not.toThrow();
    expect(() => index.check(create, {}, { type: "CNAME", name: "www", content: "example.com" })).not.toThrow();
    let refusal: any;
    try {
      index.check(create, {}, { typ: "A", nmae: "x", contnet: "192.0.2.1" });
    } catch (error) {
      refusal = error;
    }
    expect(refusal?.code).toBe("invalid_args");
    expect(refusal.validation.issues.map((issue: any) => `${issue.path} ${issue.code}`)).toEqual(
      expect.arrayContaining(["/body/typ additionalProperties", "/body/nmae additionalProperties"]),
    );
    expect(() => index.check(create, {}, undefined)).toThrow("/body (required: a application/json body)");
  });

  it("keeps array, binary, and open bodies with their requiredness, and HEAD operations", async () => {
    const { buildOperationIndex } = await generator();
    const { OperationIndex } = await import("../src/providers/_shared/rest/operation-index.js");
    const data = buildOperationIndex(vendor, source);
    expect(data.ops.map((row: unknown[]) => `${row[0]} ${row[1]}`)).toContain("HEAD /v8/artifacts/{hash}");
    const index = new OperationIndex(data, { vendor: "cf", title: "Cloudflare" });
    const bulk = index.resolve("PUT", "/accounts/a1/storage/kv/namespaces/n1/bulk").op;
    expect(index.contract(bulk).body).toMatchObject({ contentType: "application/json", required: true });
    expect(() => index.check(bulk, {}, [{ key: "k", value: "v" }])).not.toThrow();
    expect(() => index.check(bulk, {}, [{ key: "k" }])).toThrow("/body/0/value (required: a value)");
    expect(() => index.check(bulk, {}, { key: "k", value: "v" })).toThrow("/body (type: array)");
    const script = index.resolve("PUT", "/accounts/a1/scripts/s/content").op;
    expect(index.bodyType(script)).toBe("application/octet-stream");
    const settings = index.resolve("PATCH", "/accounts/a1/settings").op;
    expect(() => index.check(settings, {}, { anything: { goes: true } })).not.toThrow();
    expect(index.resolve("HEAD", "/v8/artifacts/abc").op.operationId).toBe("artifactExists");
  });

  it("intersects duplicate enum and type constraints under allOf, so a narrowed value is refused", async () => {
    const { buildOperationIndex } = await generator();
    const { OperationIndex } = await import("../src/providers/_shared/rest/operation-index.js");
    const narrowing = {
      openapi: "3.0.0",
      info: { version: "1" },
      paths: {
        "/records": {
          post: {
            operationId: "create",
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    allOf: [
                      {
                        type: "object",
                        properties: {
                          type: { type: "string", enum: ["A", "CNAME"] },
                          kind: { type: "string", enum: ["A"] },
                          ttl: { type: "number" },
                          priority: { type: "string" },
                        },
                      },
                      {
                        properties: {
                          type: { enum: ["A"] },
                          kind: { const: "MX" },
                          ttl: { type: "integer" },
                          priority: { type: "integer" },
                        },
                      },
                    ],
                  },
                },
              },
            },
          },
        },
      },
    };
    const index = new OperationIndex(buildOperationIndex(narrowing, source), { vendor: "cf", title: "Cloudflare" });
    const create = index.resolve("POST", "/records").op;
    const properties = (index.contract(create).body!.schema as any).properties;
    expect(properties.type).toEqual({ type: "string", enum: ["A"] });
    expect(properties.kind.enum).toEqual([]);
    expect(properties.ttl.type).toBe("integer");
    expect(properties.priority.enum).toEqual([]);
    expect(() => index.check(create, {}, { type: "A" })).not.toThrow();
    expect(() => index.check(create, {}, { type: "CNAME" })).toThrow("/body/type (enum: one of A)");
    // Disjoint constraints admit nothing, and say so rather than naming an empty list.
    for (const value of ["A", "MX", "anything"]) {
      expect(() => index.check(create, {}, { kind: value })).toThrow(
        "/body/kind (enum: no value: this field's combined constraints admit none)",
      );
    }
    expect(() => index.check(create, {}, { priority: 5 })).toThrow("admit none");
  });

  it("distributes outer enum constraints into union branches and drops branches they empty", async () => {
    const { buildOperationIndex } = await generator();
    const { OperationIndex } = await import("../src/providers/_shared/rest/operation-index.js");
    const body = (field: unknown) => ({
      openapi: "3.0.0",
      info: { version: "1" },
      paths: {
        "/records": {
          post: {
            operationId: "create",
            requestBody: {
              content: {
                "application/json": { schema: { type: "object", properties: { kind: field } } },
              },
            },
          },
        },
      },
    });
    const narrowed = new OperationIndex(
      buildOperationIndex(body({ allOf: [{ enum: ["A"] }, { anyOf: [{ enum: ["A"] }, { enum: ["B"] }] }] }), source),
      { vendor: "cf", title: "Cloudflare" },
    );
    const create = narrowed.resolve("POST", "/records").op;
    expect(() => narrowed.check(create, {}, { kind: "A" })).not.toThrow();
    expect(() => narrowed.check(create, {}, { kind: "B" })).toThrow("/body/kind (enum: one of A)");
    const emptied = new OperationIndex(
      buildOperationIndex(body({ allOf: [{ enum: ["C"] }, { anyOf: [{ enum: ["A"] }, { enum: ["B"] }] }] }), source),
      { vendor: "cf", title: "Cloudflare" },
    );
    for (const kind of ["A", "B", "C"]) {
      expect(() => emptied.check(emptied.resolve("POST", "/records").op, {}, { kind })).toThrow("admit none");
    }
  });
});
