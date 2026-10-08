// Node-only: spawns the Node maintainer drift checker against filesystem fixtures.
import { existsSync } from "node:fs";
import { execFile, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
// Hosted reviewed names and endpoints are vendor evidence, independent of runtime modules.
const providerDirectory = fileURLToPath(new URL("../src/providers", import.meta.url));
async function driftRecord(provider: string, directory = providerDirectory): Promise<any> {
  return JSON.parse(await readFile(join(directory, provider, "drift.json"), "utf8"));
}
async function documentedEvidence(provider: string) {
  return (await driftRecord(provider)).checks.find(
    (check: any) => check.type === "mcp-docs" || check.type === "oauth-discovery",
  );
}
const basecampEvidence = await documentedEvidence("basecamp");
const cloudflareEvidence = await documentedEvidence("cloudflare");
const linearEvidence = await documentedEvidence("linear");
const notionEvidence = await documentedEvidence("notion");
const stripeEvidence = await documentedEvidence("stripe");
const vercelEvidence = await documentedEvidence("vercel");
const BASECAMP_MCP_ENDPOINT = basecampEvidence.endpoints[0];
const CLOUDFLARE_MCP_ENDPOINT = cloudflareEvidence.endpoints[0];
const LINEAR_MCP_ENDPOINTS = { "read-write": linearEvidence.endpoints[0] };
const NOTION_MCP_ENDPOINT = notionEvidence.endpoints[0];
const STRIPE_MCP_ENDPOINT = stripeEvidence.endpoints[0];
const VERCEL_MCP_ENDPOINT = vercelEvidence.endpoints[0];

const checker = fileURLToPath(new URL("../scripts/drift-check.mjs", import.meta.url));
const manifestDirectory = providerDirectory;
const temporary: string[] = [];

// Every case spawns real checker processes — up to five, and the `--docs` ones
// read vendor records directly. Process startup is wall-clock nothing here can
// fake, so this is a hang guard sized for the heaviest case, not a speed
// assertion: vitest's 5s default failed these for load, never for behavior.
const CASE_TIMEOUT_MS = 60_000;

interface Endpoint {
  method: string;
  path: string;
  specRevision: string;
  deprecated?: boolean;
  contract?: string;
}

interface Manifest {
  provider: string;
  specification: { url: string };
  endpoints: Endpoint[];
}

interface Finding {
  method: string;
  path: string;
  kind: string;
}

async function committed(provider: string): Promise<Manifest> {
  return JSON.parse(await readManifestFile(join(manifestDirectory, provider, "drift.json")));
}

/** Fixture helpers read/write the endpoint check, preserving its versioned record wrapper. */
async function readManifestFile(path: string): Promise<string> {
  const record = JSON.parse(await readFile(path, "utf8"));
  const check = record.checks.find((item: any) => item.type === "endpoints" || item.type === "versioned-endpoints");
  return JSON.stringify({ provider: record.provider, ...check });
}
async function writeManifestFile(path: string, text: string): Promise<void> {
  const { provider, ...check } = JSON.parse(text);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      provider,
      checks: [{ type: check.specifications ? "versioned-endpoints" : "endpoints", ...check }],
    }),
  );
}

/** One synthetic operation, distinguishable by the marker in its parameters. */
function operation(marker: string): Record<string, unknown> {
  return {
    summary: `synthetic ${marker}`,
    parameters: [
      { name: "id", in: "path", required: true, schema: { type: "string" } },
      { name: marker, in: "query", schema: { type: "string" } },
    ],
    responses: {
      "200": { content: { "application/json": { schema: { type: "object" } } } },
    },
  };
}

/**
 * A specification that documents exactly what a manifest touches, plus two
 * endpoints it does not. The untouched pair is the whole point: the checker
 * must stay silent about them no matter what happens to them.
 */
function specificationFor(manifest: Manifest, version = "test-1"): Record<string, any> {
  const paths: Record<string, Record<string, unknown>> = {
    "/untouched/thing": { get: operation("untouched"), delete: operation("untouched") },
    "/untouched/other": { post: operation("untouched") },
  };
  for (const endpoint of manifest.endpoints) {
    paths[endpoint.path] ??= {};
    paths[endpoint.path]![endpoint.method.toLowerCase()] = operation(`${endpoint.method} ${endpoint.path}`);
  }
  return { openapi: "3.1.0", info: { title: "fixture", version }, paths };
}

async function workspace(providers: string[]): Promise<{
  directory: string;
  manifests: Record<string, Manifest>;
  specifications: Record<string, Record<string, any>>;
}> {
  const directory = await mkdtemp(join(tmpdir(), "connecta-drift-"));
  temporary.push(directory);
  const manifests: Record<string, Manifest> = {};
  const specifications: Record<string, Record<string, any>> = {};
  for (const provider of providers) {
    const manifest = await committed(provider);
    manifests[provider] = manifest;
    specifications[provider] = specificationFor(manifest);
    await writeManifestFile(
      join(directory, provider, "drift.json"),
      // Committed digests are of the real published document, so a fixture
      // starts from the rows alone and records its own.
      `${JSON.stringify(
        {
          ...manifest,
          endpoints: manifest.endpoints.map((endpoint) => ({
            method: endpoint.method,
            path: endpoint.path,
            specRevision: endpoint.specRevision,
          })),
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(join(directory, `${provider}-spec.json`), JSON.stringify(specifications[provider]));
  }
  return { directory, manifests, specifications };
}

function run(directory: string, providers: string[], extra: string[] = []) {
  const result = spawnSync(
    process.execPath,
    [
      checker,
      "--specs",
      "--manifest-dir",
      directory,
      ...providers.flatMap((provider) => [
        "--provider",
        provider,
        "--spec",
        `${provider}=${join(directory, `${provider}-spec.json`)}`,
      ]),
      ...extra,
    ],
    { encoding: "utf8" },
  );
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

function findings(output: string, provider: string): Finding[] {
  const report = JSON.parse(output);
  return report.specs.find((entry: any) => entry.provider === provider).findings;
}

async function documentedVercelWorkspace(): Promise<{
  directory: string;
  toolReference: string;
  setupReference: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "connecta-drift-docs-"));
  temporary.push(directory);
  const toolReference = join(directory, "vercel-tools.md");
  const setupReference = join(directory, "vercel-setup.md");
  const headings = (vercelEvidence.reviewed as string[])
    .sort()
    .map((name) => `## \`${name}\``)
    .join("\n\n");
  await writeFile(
    toolReference,
    `# Vercel tools\n\n## Tools by category\n[Tools\n${vercelEvidence.reviewed.length} tools](/docs/agent-resources/vercel-mcp/tools/deployments)\n`,
  );
  await writeFile(join(directory, "deployments.md"), headings);
  await writeFile(setupReference, `# Vercel MCP setup\n\nEndpoint: ${VERCEL_MCP_ENDPOINT}\n\nOAuth is required.\n`);
  return { directory, toolReference, setupReference };
}

function runDocumented(provider: string, toolReference: string, setupReference: string) {
  const result = spawnSync(
    process.execPath,
    [
      checker,
      "--docs",
      "--provider",
      provider,
      ...(toolReference ? ["--tool-reference", `${provider}=${toolReference}`] : []),
      "--setup-reference",
      `${provider}=${setupReference}`,
      "--json",
    ],
    { encoding: "utf8" },
  );
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("maintainer drift check", { timeout: CASE_TIMEOUT_MS }, () => {
  it("records the touched endpoints and then reports no drift against them", async () => {
    const { directory } = await workspace(["cloudflare", "notion"]);
    const recorded = run(directory, ["cloudflare", "notion"], ["--record"]);
    expect(recorded.status).toBe(0);

    const manifest: Manifest = JSON.parse(await readManifestFile(join(directory, "cloudflare", "drift.json")));
    expect(manifest.endpoints.length).toBeGreaterThan(0);
    for (const endpoint of manifest.endpoints) {
      expect(endpoint.specRevision).toBe("test-1");
      expect(endpoint.contract).toMatch(/^sha256:[0-9a-f]{64}$/);
    }

    const again = run(directory, ["cloudflare", "notion"], ["--json"]);
    expect(again.status).toBe(0);
    expect(findings(again.output, "cloudflare")).toEqual([]);
    expect(findings(again.output, "notion")).toEqual([]);
  });

  it.each(["cloudflare", "notion", "overflow", "tithely"])(
    "reports %s changes only for touched endpoints",
    async (provider) => {
      const { directory, manifests, specifications } = await workspace([provider]);
      expect(run(directory, [provider], ["--record"]).status).toBe(0);

      const specification = specifications[provider]!;
      const endpoints = manifests[provider]!.endpoints;
      const gonePath = endpoints[0]!;
      const goneMethod = endpoints.find((endpoint) => endpoint.path !== gonePath.path)!;
      const deprecated = endpoints.find(
        (endpoint) => endpoint.path !== gonePath.path && endpoint.path !== goneMethod.path,
      )!;
      const changed = endpoints.find(
        (endpoint) =>
          endpoint.path !== gonePath.path && endpoint.path !== goneMethod.path && endpoint.path !== deprecated.path,
      )!;

      // Everything the provider does not touch moves at once: one path gone,
      // one operation deprecated, one contract rewritten.
      delete specification.paths["/untouched/other"];
      specification.paths["/untouched/thing"].get.deprecated = true;
      specification.paths["/untouched/thing"].delete = operation("rewritten");

      delete specification.paths[gonePath.path];
      delete specification.paths[goneMethod.path][goneMethod.method.toLowerCase()];
      specification.paths[deprecated.path][deprecated.method.toLowerCase()].deprecated = true;
      specification.paths[changed.path][changed.method.toLowerCase()] = operation("rewritten");

      await writeFile(join(directory, `${provider}-spec.json`), JSON.stringify(specification));

      const result = run(directory, [provider], ["--json"]);
      expect(result.status).toBe(0);
      const reported = findings(result.output, provider);
      // gonePath may carry more than one method; every one of them is a finding.
      const goneRows = endpoints.filter((endpoint) => endpoint.path === gonePath.path);
      expect(reported.filter((finding) => finding.kind === "path-gone")).toEqual(
        goneRows.map((endpoint) =>
          expect.objectContaining({
            kind: "path-gone",
            method: endpoint.method,
            path: endpoint.path,
          }),
        ),
      );
      expect(reported).toContainEqual(
        expect.objectContaining({
          kind: "method-gone",
          method: goneMethod.method,
          path: goneMethod.path,
        }),
      );
      expect(reported).toContainEqual(
        expect.objectContaining({
          kind: "deprecated",
          method: deprecated.method,
          path: deprecated.path,
        }),
      );
      expect(reported).toContainEqual(
        expect.objectContaining({
          kind: "contract-changed",
          method: changed.method,
          path: changed.path,
        }),
      );
      expect(reported.map((finding) => finding.path)).not.toContain("/untouched/thing");
      expect(reported.map((finding) => finding.path)).not.toContain("/untouched/other");
      expect(reported).toHaveLength(goneRows.length + 3);
    },
  );

  it("keeps a revision bump that left the touched contracts alone quiet", async () => {
    const { directory, specifications } = await workspace(["notion"]);
    expect(run(directory, ["notion"], ["--record"]).status).toBe(0);

    specifications["notion"]!["info"].version = "test-2";
    await writeFile(join(directory, "notion-spec.json"), JSON.stringify(specifications["notion"]));

    const result = run(directory, ["notion"], ["--json"]);
    expect(result.status).toBe(0);
    expect(findings(result.output, "notion")).toEqual([]);
  });

  it("reports an unavailable published specification as an advisory finding", async () => {
    const { directory } = await workspace(["notion"]);
    expect(run(directory, ["notion"], ["--record"]).status).toBe(0);
    const result = run(directory, [], ["--provider", "notion", "--spec", `notion=${join(directory, "absent.json")}`]);
    expect(result.status).toBe(0);
    expect(result.output).toContain("could not read notion's published specification");
  });

  it("refuses a provider without a discovered drift record", async () => {
    const { directory } = await workspace(["notion"]);
    const result = run(directory, [], ["--provider", "cloudflare"]);
    expect(result.status).toBe(2);
    expect(result.output).toContain("unknown provider: cloudflare");
  });

  it("assembles Tithe.ly's per-operation reference pages into one contract", async () => {
    // Tithe.ly publishes no combined document: each ReadMe page embeds a
    // one-operation snippet. The checker reads the pages the manifest lists.
    const { directory, manifests } = await workspace(["tithely"]);
    const pagesDirectory = join(directory, "pages");
    await mkdir(pagesDirectory);
    const endpoints = manifests["tithely"]!.endpoints;
    const page = (endpoint: Endpoint, marker: string) =>
      [
        "---",
        "updatedAt: 2025-06-09T22:42:41.000Z",
        "---",
        "",
        "# Synthetic page",
        "",
        "# OpenAPI definition",
        "",
        "```json",
        JSON.stringify(
          {
            openapi: "3.1.0",
            info: { title: "api-settings", version: "1" },
            paths: { [endpoint.path]: { [endpoint.method.toLowerCase()]: operation(marker) } },
          },
          null,
          2,
        ),
        "```",
      ].join("\n");
    const slugs = endpoints.map((_, index) => `page-${index}`);
    await Promise.all(
      endpoints.map((endpoint, index) =>
        writeFile(join(pagesDirectory, `${slugs[index]}.md`), page(endpoint, "original")),
      ),
    );
    const manifestPath = join(directory, "tithely", "drift.json");
    const manifest = JSON.parse(await readManifestFile(manifestPath));
    manifest.specification.pages = slugs;
    await writeManifestFile(manifestPath, JSON.stringify(manifest));
    const runPages = (extra: string[]) =>
      spawnSync(
        process.execPath,
        [
          checker,
          "--specs",
          "--manifest-dir",
          directory,
          "--provider",
          "tithely",
          "--spec",
          `tithely=${pagesDirectory}`,
          ...extra,
        ],
        { encoding: "utf8" },
      );

    expect(runPages(["--record"]).status).toBe(0);
    const quiet = runPages(["--json"]);
    expect(quiet.status).toBe(0);
    expect(findings(quiet.stdout, "tithely")).toEqual([]);

    const target = endpoints[0]!;
    await writeFile(join(pagesDirectory, "page-0.md"), page(target, "rewritten"));
    const drifted = runPages(["--json"]);
    expect(drifted.status).toBe(0);
    expect(findings(drifted.stdout, "tithely")).toEqual([
      expect.objectContaining({ kind: "contract-changed", method: target.method, path: target.path }),
    ]);

    await writeFile(join(pagesDirectory, "page-1.md"), "# Moved\n\nNo snippet here.");
    const broken = runPages([]);
    expect(broken.status).toBe(0);
    expect(`${broken.stdout}${broken.stderr}`).toContain("no longer embeds an OpenAPI definition");
  });

  it("reads a Google Discovery document for a Workspace provider, scopes included", async () => {
    // Workspace APIs publish Discovery, not OpenAPI. The checker re-keys its
    // methods by full path, resolves its bare $refs into `schemas`, and also
    // reports a touched method that stops accepting the provider's scopes.
    const manifest = (await committed("gmail")) as Manifest & { scopes: string[] };
    const directory = await mkdtemp(join(tmpdir(), "connecta-drift-discovery-"));
    temporary.push(directory);
    await writeManifestFile(
      join(directory, "gmail", "drift.json"),
      JSON.stringify({
        ...manifest,
        endpoints: manifest.endpoints.map(({ method, path, specRevision }) => ({ method, path, specRevision })),
      }),
    );
    const discovery = (revision: string, draftField = "string", dropScope?: string) => ({
      kind: "discovery#restDescription",
      discoveryVersion: "v1",
      revision,
      rootUrl: "https://gmail.googleapis.com/",
      servicePath: "",
      schemas: {
        Draft: {
          id: "Draft",
          type: "object",
          description: "prose that must not matter",
          properties: { id: { type: draftField }, message: { $ref: "Message" } },
        },
        Message: {
          id: "Message",
          type: "object",
          properties: { raw: { type: "string" }, payload: { $ref: "MessagePart" } },
        },
        MessagePart: {
          id: "MessagePart",
          type: "object",
          properties: { parts: { type: "array", items: { $ref: "MessagePart" } } },
        },
      },
      resources: {
        users: {
          resources: Object.fromEntries(
            manifest.endpoints.map((endpoint, index) => [
              `r${index}`,
              {
                methods: {
                  call: {
                    httpMethod: endpoint.method,
                    path: endpoint.path.slice(1),
                    flatPath: endpoint.path.slice(1),
                    parameters: {
                      userId: { type: "string", location: "path", required: true, enumDescriptions: ["prose"] },
                    },
                    response: { $ref: "Draft" },
                    // Dropping leaves the draft write on full-mailbox access
                    // alone, which no delegated grant here includes.
                    scopes:
                      dropScope !== undefined && endpoint.method === "POST"
                        ? ["https://mail.google.com/"]
                        : [...manifest.scopes, "https://mail.google.com/"],
                  },
                },
              },
            ]),
          ),
        },
      },
    });
    const source = join(directory, "gmail-discovery.json");
    const check = (extra: string[]) =>
      spawnSync(
        process.execPath,
        [checker, "--specs", "--manifest-dir", directory, "--provider", "gmail", "--spec", `gmail=${source}`, ...extra],
        { encoding: "utf8" },
      );

    await writeFile(source, JSON.stringify(discovery("20260101")));
    expect(check(["--record"]).status).toBe(0);
    const recorded = JSON.parse(await readManifestFile(join(directory, "gmail", "drift.json")));
    expect(recorded.scopes).toEqual(manifest.scopes);
    expect(recorded.endpoints.every((row: Endpoint) => row.specRevision === "20260101")).toBe(true);

    // A new revision with the same contract, reworded prose, is quiet.
    await writeFile(source, JSON.stringify(discovery("20260202")));
    const quiet = check(["--json"]);
    expect(quiet.status).toBe(0);
    expect(findings(quiet.stdout, "gmail")).toEqual([]);

    // A referenced schema changing moves every contract that reaches it.
    await writeFile(source, JSON.stringify(discovery("20260303", "integer")));
    const drifted = check(["--json"]);
    expect(drifted.status).toBe(0);
    expect(new Set(findings(drifted.stdout, "gmail").map((finding) => finding.kind))).toEqual(
      new Set(["contract-changed"]),
    );

    // A touched method that stops accepting the provider's scopes is reported.
    await writeFile(source, JSON.stringify(discovery("20260101", "string", "drop")));
    const scoped = check(["--json"]);
    expect(scoped.status).toBe(0);
    expect(findings(scoped.stdout, "gmail")).toEqual([
      expect.objectContaining({ kind: "scope-dropped", method: "POST", path: "/gmail/v1/users/{userId}/drafts" }),
    ]);

    await writeFile(source, JSON.stringify(specificationFor(manifest)));
    const wrong = check([]);
    expect(wrong.status).toBe(0);
    expect(`${wrong.stdout}${wrong.stderr}`).toContain("not a Google Discovery document");
  });

  it("has no credentialed hosted mode", () => {
    const result = spawnSync(process.execPath, [checker, "--hosted"], {
      encoding: "utf8",
    });
    expect(result.status).toBe(2);
    expect(`${result.stdout}${result.stderr}`).toContain("unknown argument: --hosted");
  });

  it("sees through a response written as a $ref into shared components", async () => {
    const { directory, manifests, specifications } = await workspace(["notion"]);
    const specification = specifications["notion"]!;
    const [alpha, beta] = manifests["notion"]!.endpoints as [Endpoint, Endpoint];

    // Both providers' real documents write whole response objects as
    // references. A digest that reads `.content` off the reference itself sees
    // nothing at all — every such endpoint digests identically, and a rewritten
    // component is invisible. Two different components must digest differently.
    specification["components"] = {
      schemas: {
        alpha: { type: "object", properties: { id: { type: "string" } } },
        beta: { type: "object", properties: { name: { type: "string" } } },
      },
      responses: {
        alpha: {
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/alpha" } },
          },
        },
        beta: {
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/beta" } },
          },
        },
      },
    };
    for (const [endpoint, component] of [
      [alpha, "alpha"],
      [beta, "beta"],
    ] as const) {
      specification["paths"][endpoint.path][endpoint.method.toLowerCase()] = {
        parameters: [{ name: "id", in: "path", schema: { type: "string" } }],
        responses: { "200": { $ref: `#/components/responses/${component}` } },
      };
    }
    await writeFile(join(directory, "notion-spec.json"), JSON.stringify(specification));
    expect(run(directory, ["notion"], ["--record"]).status).toBe(0);

    const recorded: Manifest = JSON.parse(await readManifestFile(join(directory, "notion", "drift.json")));
    const digestFor = (endpoint: Endpoint) =>
      recorded.endpoints.find((row) => row.method === endpoint.method && row.path === endpoint.path)!.contract;
    expect(digestFor(alpha)).not.toBe(digestFor(beta));

    // A change inside the referenced schema is a change to the contract.
    specification["components"].schemas.alpha.properties.id = { type: "number" };
    await writeFile(join(directory, "notion-spec.json"), JSON.stringify(specification));
    const result = run(directory, ["notion"], ["--json"]);
    expect(result.status).toBe(0);
    expect(findings(result.output, "notion")).toEqual([
      expect.objectContaining({
        kind: "contract-changed",
        method: alpha.method,
        path: alpha.path,
      }),
    ]);
  });

  it("acknowledges a recorded deprecation and reports the reverse", async () => {
    const { directory, manifests, specifications } = await workspace(["notion"]);
    const specification = specifications["notion"]!;
    const target = manifests["notion"]!.endpoints[0]!;
    const operationOf = () => specification["paths"][target.path][target.method.toLowerCase()];

    operationOf().deprecated = true;
    await writeFile(join(directory, "notion-spec.json"), JSON.stringify(specification));
    // The first run reports it — nothing has reviewed it yet — and records it.
    const first = run(directory, ["notion"], ["--record", "--json"]);
    expect(first.status).toBe(0);
    expect(findings(first.output, "notion")).toEqual([
      expect.objectContaining({
        kind: "deprecated",
        method: target.method,
        path: target.path,
      }),
    ]);

    const recorded: Manifest = JSON.parse(await readManifestFile(join(directory, "notion", "drift.json")));
    expect(recorded.endpoints.find((row) => row.method === target.method && row.path === target.path)!.deprecated).toBe(
      true,
    );

    // A deprecation a maintainer has read and recorded is not news again.
    const quiet = run(directory, ["notion"], ["--json"]);
    expect(quiet.status).toBe(0);
    expect(findings(quiet.output, "notion")).toEqual([]);

    delete operationOf().deprecated;
    await writeFile(join(directory, "notion-spec.json"), JSON.stringify(specification));
    const reversed = run(directory, ["notion"], ["--json"]);
    expect(reversed.status).toBe(0);
    expect(findings(reversed.output, "notion")).toEqual([
      expect.objectContaining({
        kind: "undeprecated",
        method: target.method,
        path: target.path,
      }),
    ]);
  });

  it.each([
    ["--specs", "linear", "--docs"],
    ["--specs", "stripe", "--docs"],
  ])("refuses %s narrowed to %s, which %s checks", async (half, provider, other) => {
    const result = spawnSync(process.execPath, [checker, half, "--provider", provider], { encoding: "utf8" });
    // Silently checking nothing and exiting 0 is the wrong failure mode for a
    // command whose whole value is its exit code.
    expect(result.status).toBe(2);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toContain(`${provider} is `);
    expect(output).toContain(other);
    expect(output).toContain("which this run did not select");
  });

  it("checks Vercel's public MCP inventory while naming live schema ownership", async () => {
    const { toolReference, setupReference } = await documentedVercelWorkspace();
    const clean = runDocumented("vercel", toolReference, setupReference);
    expect(clean.status).toBe(0);
    const cleanReport = JSON.parse(clean.output).docs[0];
    expect(cleanReport).toMatchObject({
      provider: "vercel",
      documentedTools: 39,
      added: [],
      removed: [],
      findings: [],
      schemaAuthority: "live-tools-list",
      schemasVendored: false,
    });

    await writeFile(toolReference, (await readFile(toolReference, "utf8")).replace("39 tools", "40 tools"));
    const category = join(dirname(toolReference), "deployments.md");
    await writeFile(category, `${await readFile(category, "utf8")}\n## ` + "`new_vercel_tool`\n");
    const drifted = runDocumented("vercel", toolReference, setupReference);
    expect(drifted.status).toBe(0);
    expect(JSON.parse(drifted.output).docs[0].added).toEqual(["new_vercel_tool"]);
  });

  it("reads table inventories and treats documented additions as findings", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connecta-drift-table-"));
    temporary.push(directory);
    const reference = join(directory, "stripe.md");
    const rows = (stripeEvidence.reviewed as string[])
      .sort()
      .map((name) => `| Account | \`${name}\` | Fixture |`)
      .join("\n");
    await writeFile(
      reference,
      `# Stripe MCP\n\n${STRIPE_MCP_ENDPOINT}\n\nOAuth\n\n## Tools\n\n| Resource | Tool | Description |\n| --- | --- | --- |\n${rows}\n\n### Supported API methods\n`,
    );
    const clean = runDocumented("stripe", reference, reference);
    expect(clean.status).toBe(0);
    expect(JSON.parse(clean.output).docs[0]).toMatchObject({
      inventoryChecked: true,
      added: [],
      schemaAuthority: "live-tools-list",
      schemasVendored: false,
    });

    await writeFile(reference, `${await readFile(reference, "utf8")}\n| Other | \`new_stripe_tool\` | New |\n`);
    // The row landed after the configured section boundary, so move the
    // boundary too. This proves the parser checks the named section only.
    expect(runDocumented("stripe", reference, reference).status).toBe(0);
    const content = await readFile(reference, "utf8");
    await writeFile(
      reference,
      content.replace("### Supported API methods", "| Other | `new_stripe_tool` | New |\n\n### Supported API methods"),
    );
    const drifted = runDocumented("stripe", reference, reference);
    expect(drifted.status).toBe(0);
    expect(JSON.parse(drifted.output).docs[0].added).toContain("new_stripe_tool");
  });

  it("reads inline names from Cloudflare and Notion's official doc shapes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connecta-drift-inline-"));
    temporary.push(directory);

    const cloudflare = join(directory, "cloudflare.md");
    await writeFile(
      cloudflare,
      `# Cloudflare MCP\n\nOAuth\n\n## Cloudflare API MCP server\n\nTwo tools: \`search()\` and \`execute()\`.\n\n### Connect to the Cloudflare API MCP server\n\n${CLOUDFLARE_MCP_ENDPOINT}\n`,
    );
    const cloudflareResult = runDocumented("cloudflare", cloudflare, cloudflare);
    expect(cloudflareResult.status).toBe(0);
    expect(JSON.parse(cloudflareResult.output).docs[0]).toMatchObject({
      documentedTools: cloudflareEvidence.reviewed.length,
      added: [],
      findings: [],
    });

    const notionTools = join(directory, "notion-tools.md");
    const notionSetup = join(directory, "notion-setup.md");
    await writeFile(
      notionTools,
      (notionEvidence.reviewed as string[])
        .sort()
        .map((name) => `\`${name}\``)
        .join("\n\n"),
    );
    await writeFile(notionSetup, `# Notion MCP\n\n${NOTION_MCP_ENDPOINT}\n\nOAuth setup.\n`);
    const notionResult = runDocumented("notion", notionTools, notionSetup);
    expect(notionResult.status).toBe(0);
    expect(JSON.parse(notionResult.output).docs[0]).toMatchObject({
      documentedTools: notionEvidence.reviewed.length,
      added: [],
      findings: [],
    });
  });

  it("checks endpoint and OAuth docs when a provider publishes no tool inventory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connecta-drift-setup-"));
    temporary.push(directory);
    const setup = join(directory, "linear.md");
    await writeFile(setup, `# Linear MCP\n\n${LINEAR_MCP_ENDPOINTS["read-write"]}\n\nOAuth setup.\n`);
    const result = runDocumented("linear", "", setup);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.output).docs[0]).toMatchObject({
      inventoryChecked: false,
      added: [],
      removed: [],
      findings: [],
      schemaAuthority: "live-tools-list",
      schemasVendored: false,
    });
  });

  it("reads Basecamp's OAuth discovery when no setup page exists", async () => {
    // Basecamp publishes no setup page or inventory, so the check reads the
    // protected-resource metadata and follows it to the authorization server.
    // Served over loopback HTTP because the second document's address comes
    // out of the first, exactly as it does against Basecamp.
    let server = {
      issuer: "",
      client_id_metadata_document_supported: true,
      code_challenge_methods_supported: ["S256"],
    };
    const http = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/.well-known/oauth-authorization-server") {
        response.end(JSON.stringify(server));
        return;
      }
      response.statusCode = 404;
      response.end("{}");
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    try {
      const issuer = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
      server = { ...server, issuer };
      const directory = await mkdtemp(join(tmpdir(), "connecta-drift-oauth-"));
      temporary.push(directory);
      const setup = join(directory, "basecamp-resource.json");
      const resource = (url: string) =>
        writeFile(
          setup,
          JSON.stringify({
            resource: url,
            authorization_servers: [issuer],
            scopes_supported: ["mcp", "read", "full"],
          }),
        );
      const run = () =>
        new Promise<{ status: number; output: string }>((resolve) => {
          execFile(
            process.execPath,
            [checker, "--docs", "--provider", "basecamp", "--setup-reference", `basecamp=${setup}`, "--json"],
            { encoding: "utf8" },
            (error, stdout, stderr) => {
              resolve({
                status: error ? Number(error.code ?? 1) : 0,
                output: `${stdout}${stderr}`,
              });
            },
          );
        });

      await resource(BASECAMP_MCP_ENDPOINT);
      const clean = await run();
      expect(clean.status).toBe(0);
      expect(JSON.parse(clean.output).docs[0]).toMatchObject({
        provider: "basecamp",
        setupKind: "oauth-discovery",
        inventoryChecked: false,
        added: [],
        findings: [],
        authorizationServer: issuer,
        advertisedScopes: ["mcp", "read", "full"],
        schemaAuthority: "live-tools-list",
        schemasVendored: false,
      });

      // The constructor requires a metadata-document client id, so losing
      // that support is a finding; so is the resource naming another endpoint.
      server = { ...server, client_id_metadata_document_supported: false };
      await resource("https://mcp.basecamp.com/v2/mcp");
      const drifted = await run();
      expect(drifted.status).toBe(0);
      expect(JSON.parse(drifted.output).docs[0].findings.map((finding: { kind: string }) => finding.kind)).toEqual([
        "mcp-endpoint",
        "mcp-auth",
      ]);
    } finally {
      await new Promise((resolve) => http.close(resolve));
    }
  });

  it("commits one well-formed row per touched endpoint", async () => {
    for (const entry of await readdir(providerDirectory, { withFileTypes: true })) {
      if (
        !entry.isDirectory() ||
        entry.name.startsWith("_") ||
        !existsSync(join(providerDirectory, entry.name, "drift.json"))
      )
        continue;
      const record = await driftRecord(entry.name);
      const check = record.checks.find((item: any) => item.type === "endpoints");
      if (!check) continue;
      const provider = entry.name;
      const manifest = { provider, ...check };
      expect(manifest.provider).toBe(provider);
      expect(manifest.specification.url).toMatch(/^https:\/\//);
      const seen = new Set<string>();
      for (const endpoint of manifest.endpoints) {
        const row = `${endpoint.method} ${endpoint.path}`;
        expect(seen.has(row)).toBe(false);
        seen.add(row);
        expect(endpoint.method).toMatch(/^(GET|POST|PUT|PATCH|DELETE)$/);
        expect(endpoint.path.startsWith("/")).toBe(true);
        expect(endpoint.specRevision).toBeTruthy();
        expect(endpoint.contract).toMatch(/^sha256:[0-9a-f]{64}$/);
      }
    }
  });

  it("stops touching Cloudflare's deprecated bulk zone-settings read", async () => {
    // #361: the tool that called it is gone, so the row goes with it. A
    // manifest row is a claim that this connection calls the endpoint, and
    // leaving a deprecated one behind would make `--specs` argue with a
    // surface that stopped calling it.
    const rows = (await committed("cloudflare")).endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`);
    expect(rows).not.toContain("GET /zones/{zone_id}/settings");
    expect(rows).toContain("GET /zones/{zone_id}/settings/{setting_id}");
    expect(rows).toContain("PATCH /zones/{zone_id}/settings/{setting_id}");
  });
});

interface VersionedManifest {
  provider: string;
  specifications: Record<string, { version: string; url: string; documentation: string; latestPublished?: string }>;
  endpoints: Endpoint[];
}

/**
 * Planning Center's manifest names one OpenAPI document and one documentation
 * graph per product. A fixture rewrites every source to a local file, so the
 * whole versioned path runs offline.
 */
async function planningCenterWorkspace(): Promise<{
  directory: string;
  manifest: VersionedManifest;
  specification: (app: string) => string;
  documentation: (app: string) => string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "connecta-drift-pco-"));
  temporary.push(directory);
  const committedManifest = JSON.parse(
    await readManifestFile(join(manifestDirectory, "planning-center", "drift.json")),
  ) as VersionedManifest;
  const specification = (app: string) => join(directory, `${app}-openapi.json`);
  const documentation = (app: string) => join(directory, `${app}-documentation.json`);
  const manifest: VersionedManifest = {
    ...committedManifest,
    specifications: Object.fromEntries(
      Object.entries(committedManifest.specifications).map(([app, entry]) => [
        app,
        { version: entry.version, url: specification(app), documentation: documentation(app) },
      ]),
    ),
    endpoints: committedManifest.endpoints.map(({ method, path, specRevision }) => ({
      method,
      path,
      specRevision,
    })),
  };
  for (const [app, entry] of Object.entries(manifest.specifications)) {
    await writeFile(
      documentation(app),
      JSON.stringify({
        data: {
          relationships: {
            versions: {
              data: [
                { type: "Version", id: entry.version, attributes: { beta: false } },
                { type: "Version", id: "2018-08-01", attributes: { beta: false } },
                { type: "Version", id: "2099-01-01", attributes: { beta: true } },
              ],
            },
          },
        },
      }),
    );
    const paths: Record<string, Record<string, unknown>> = {};
    for (const endpoint of manifest.endpoints.filter((row) => row.path.startsWith(`/${app}/v2`))) {
      const path = endpoint.path.slice(`/${app}/v2`.length);
      paths[path] ??= {};
      paths[path]![endpoint.method.toLowerCase()] = operation(`${endpoint.method} ${path}`);
    }
    await writeFile(
      specification(app),
      JSON.stringify({ openapi: "3.1.1", info: { title: app, version: entry.version }, paths }),
    );
  }
  await writeManifestFile(join(directory, "planning-center", "drift.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { directory, manifest, specification, documentation };
}

function runPlanningCenter(directory: string, extra: string[] = []) {
  const result = spawnSync(
    process.execPath,
    [checker, "--specs", "--provider", "planning-center", "--manifest-dir", directory, "--json", ...extra],
    { encoding: "utf8" },
  );
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

function rowPattern(path: string): RegExp {
  return new RegExp(`^${path.replace(/\{[^}]+\}/g, "[^/]+")}$`);
}

describe("Planning Center's per-product drift check", { timeout: CASE_TIMEOUT_MS }, () => {
  it("records every product, then reports a contract change and a new version as transitions", async () => {
    const { directory, manifest, specification, documentation } = await planningCenterWorkspace();
    const recorded = runPlanningCenter(directory, ["--record"]);
    expect(recorded.status, recorded.output).toBe(0);
    const after = JSON.parse(
      await readManifestFile(join(directory, "planning-center", "drift.json")),
    ) as VersionedManifest;
    for (const endpoint of after.endpoints) {
      expect(endpoint.contract).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
    // A beta is not a publication a pin can move to.
    expect(after.specifications["people"]!.latestPublished).toBe(manifest.specifications["people"]!.version);
    expect(runPlanningCenter(directory).status).toBe(0);

    const touched = manifest.endpoints.find(
      (row) => row.path === "/people/v2/people/{person_id}" && row.method === "GET",
    )!;
    const people = JSON.parse(await readFile(specification("people"), "utf8"));
    people.paths["/people/{person_id}"].get = operation("rewritten");
    await writeFile(specification("people"), JSON.stringify(people));
    const groups = JSON.parse(await readFile(documentation("groups"), "utf8"));
    groups.data.relationships.versions.data.push({
      type: "Version",
      id: "2027-01-01",
      attributes: { beta: false },
    });
    await writeFile(documentation("groups"), JSON.stringify(groups));

    const drifted = runPlanningCenter(directory);
    expect(drifted.status).toBe(0);
    expect(findings(drifted.output, "planning-center")).toEqual([
      expect.objectContaining({ app: "groups", kind: "version-published" }),
      expect.objectContaining({ kind: "contract-changed", method: touched.method, path: touched.path }),
    ]);

    // Reviewed and recorded, neither is news again.
    expect(runPlanningCenter(directory, ["--record"]).status).toBe(0);
    expect(runPlanningCenter(directory).status).toBe(0);
  });

  it("reports a pinned version the graph no longer lists and a document for the wrong version", async () => {
    const { directory, specification, documentation } = await planningCenterWorkspace();
    expect(runPlanningCenter(directory, ["--record"]).status).toBe(0);
    await writeFile(
      documentation("webhooks"),
      JSON.stringify({
        data: { relationships: { versions: { data: [{ id: "2018-08-01", attributes: { beta: false } }] } } },
      }),
    );
    const giving = JSON.parse(await readFile(specification("giving"), "utf8"));
    giving.info.version = "2018-08-01";
    await writeFile(specification("giving"), JSON.stringify(giving));
    const result = runPlanningCenter(directory);
    expect(result.status).toBe(0);
    const kinds = findings(result.output, "planning-center").map((finding: any) => `${finding.app} ${finding.kind}`);
    expect(kinds).toEqual(
      expect.arrayContaining(["webhooks version-gone", "webhooks version-published", "giving version-mismatch"]),
    );
  });

  it("takes a per-product specification override and refuses a provider-wide one", async () => {
    const { directory, specification } = await planningCenterWorkspace();
    expect(runPlanningCenter(directory, ["--record"]).status).toBe(0);
    const calendar = JSON.parse(await readFile(specification("calendar"), "utf8"));
    delete calendar.paths["/event_instances"];
    const override = join(directory, "calendar-override.json");
    await writeFile(override, JSON.stringify(calendar));
    const overridden = runPlanningCenter(directory, ["--spec", `planning-center/calendar=${override}`]);
    expect(overridden.status).toBe(0);
    expect(findings(overridden.output, "planning-center")).toEqual([
      expect.objectContaining({ kind: "path-gone", path: "/calendar/v2/event_instances" }),
    ]);
    const refused = runPlanningCenter(directory, ["--spec", `planning-center=${override}`]);
    expect(refused.status).toBe(2);
    expect(refused.output).toContain("one specification per product");
  });

  it("pins the manifest to the provider's versions and covers exactly what the named tools call", async () => {
    const folderEntry = join(providerDirectory, "planning-center", "index.ts");
    const source = existsSync(folderEntry) ? folderEntry : join(providerDirectory, "planning-center.ts");
    const { PLANNING_CENTER_API_VERSIONS, planningCenter } = await import(pathToFileURL(source).href);
    const { memoryStorage } = await import("../src/storage/memory.js");
    const { silentLogger } = await import("./helpers.js");
    const manifest = JSON.parse(
      await readManifestFile(join(manifestDirectory, "planning-center", "drift.json")),
    ) as VersionedManifest;
    expect(
      Object.fromEntries(Object.entries(manifest.specifications).map(([app, entry]) => [app, entry.version])),
    ).toEqual(PLANNING_CENTER_API_VERSIONS);
    for (const [app, entry] of Object.entries(manifest.specifications)) {
      expect(entry.url).toBe(`https://api.planningcenteronline.com/${app}/v2/open_api/${entry.version}`);
      expect(entry.documentation).toBe(`https://api.planningcenteronline.com/${app}/v2/documentation`);
    }

    // Call every named tool with its smallest valid arguments and require
    // each request to be a reviewed row: a tool that starts calling a new
    // endpoint fails here, not in a release that never checked it.
    const sent = new Set<string>();
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
      sent.add(`${init.method ?? "GET"} ${new URL(String(input)).pathname}`);
      return new Response(JSON.stringify({ data: { type: "Thing", id: "1", attributes: {} } }), { status: 200 });
    }) as typeof fetch;
    try {
      const connector = planningCenter("pco", { purpose: "manifest coverage" });
      const ctx = {
        storage: memoryStorage(),
        logger: silentLogger,
        baseUrl: "https://connecta.example",
        credential: {
          get: async () => "x",
          getAll: async () => ({ applicationId: "x", secret: "x" }),
        },
      };
      const minimal = (schema: any): Record<string, unknown> =>
        Object.fromEntries(
          (schema.required ?? []).map((key: string) => {
            const property = schema.properties[key];
            const value = property.enum
              ? property.enum[0]
              : property.type === "integer"
                ? 1
                : property.pattern === "^[0-9]+$"
                  ? "1"
                  : "x".repeat(property.minLength ?? 1);
            return [key, value];
          }),
        );
      for (const tool of await connector.listTools(ctx)) {
        if (tool.name.startsWith("pco_api_")) continue;
        const schema = tool.inputSchema as any;
        const variants: Record<string, unknown>[] =
          tool.name === "apply_workflow_card_action"
            ? schema.properties.action.enum.map((action: string) => ({
                ...minimal(schema),
                action,
                ...(action === "snooze" ? { snoozeDays: 1 } : {}),
              }))
            : tool.name === "update_person"
              ? [{ ...minimal(schema), status: "active" }]
              : [minimal(schema)];
        for (const args of variants) await connector.callTool(tool.name, args, ctx);
      }
      // The optional ids that switch a list to a nested collection.
      for (const [tool, args] of [
        ["list_donations", { personId: "1" }],
        ["list_group_events", { groupId: "1" }],
        ["list_check_ins", { eventId: "1" }],
      ] as const) {
        await connector.callTool(tool, args, ctx);
      }
    } finally {
      globalThis.fetch = realFetch;
    }
    const matches = (request: string, endpoint: Endpoint) => {
      const [method, path] = request.split(" ");
      return method === endpoint.method && rowPattern(endpoint.path).test(path!);
    };
    expect([...sent].filter((request) => !manifest.endpoints.some((endpoint) => matches(request, endpoint)))).toEqual(
      [],
    );
    expect(
      manifest.endpoints
        .filter((endpoint) => ![...sent].some((request) => matches(request, endpoint)))
        .map((endpoint) => `${endpoint.method} ${endpoint.path}`),
    ).toEqual([]);
  });
});

async function recordWorkspace(records: Record<string, unknown>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "connecta-drift-records-"));
  temporary.push(directory);
  for (const [provider, record] of Object.entries(records)) {
    await mkdir(join(directory, provider), { recursive: true });
    await writeFile(join(directory, provider, "drift.json"), JSON.stringify(record));
  }
  return directory;
}

function reportFor(directory: string, extra: string[] = []) {
  const result = spawnSync(process.execPath, [checker, "--provider-dir", directory, "--json", ...extra], {
    encoding: "utf8",
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

const manualCheck = {
  type: "manual",
  source: "https://vendor.example/reference",
  rationale: "Review the vendor's HTML endpoint table.",
};

describe("discovered provider drift evidence", { timeout: CASE_TIMEOUT_MS }, () => {
  it("discovers new providers without a central list and ignores shared/helper folders", async () => {
    const directory = await recordWorkspace({
      "new-vendor": { version: 1, provider: "new-vendor", checks: [manualCheck] },
    });
    await mkdir(join(directory, "helper"));
    await mkdir(join(directory, "_shared"));
    await writeFile(join(directory, "_shared", "drift.json"), "invalid shared data");
    const result = reportFor(directory);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.output)).toMatchObject({
      manual: [{ provider: "new-vendor", findings: [{ kind: "manual-required" }] }],
      records: [],
      findings: 1,
    });
    expect(reportFor(directory, ["--strict"]).status).toBe(1);
  });

  it("discovers exactly the published provider set, with versioned vendor evidence for every folder", async () => {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    const published = Object.keys(pkg.exports)
      .filter((key) => key.startsWith("./providers/"))
      .map((key) => key.slice("./providers/".length))
      .sort();
    const discovered = (await readdir(providerDirectory, { withFileTypes: true }))
      .filter(
        (entry) =>
          entry.isDirectory() &&
          !entry.name.startsWith("_") &&
          existsSync(join(providerDirectory, entry.name, "drift.json")),
      )
      .map((entry) => entry.name)
      .sort();
    expect(discovered).toEqual(published);
    for (const provider of discovered) {
      const record = await driftRecord(provider);
      expect(record).toMatchObject({ version: 1, provider });
      expect(record.checks.length).toBeGreaterThan(0);
      for (const check of record.checks) {
        expect(["endpoints", "versioned-endpoints", "mcp-docs", "oauth-discovery", "mcp-catalog", "manual"]).toContain(
          check.type,
        );
        if (check.type === "mcp-docs" || check.type === "oauth-discovery") {
          expect(check.setup).toMatch(/^https:\/\//);
          expect(check.endpoints.length).toBeGreaterThan(0);
          expect(check.endpoints.every((endpoint: string) => endpoint.startsWith("https://"))).toBe(true);
          expect(check.reviewed.length).toBeGreaterThan(0);
          expect(new Set(check.reviewed).size).toBe(check.reviewed.length);
          if (check.inventory) expect(check.inventory.url).toMatch(/^https:\/\//);
        }
        if (check.type === "endpoints" || check.type === "versioned-endpoints") {
          expect(check.endpoints.length).toBeGreaterThan(0);
          for (const endpoint of check.endpoints) {
            expect(endpoint.contract).toMatch(/^sha256:[0-9a-f]{64}$/);
            expect(endpoint.specRevision).toBeTruthy();
          }
        }
      }
    }
    expect((await driftRecord("basecamp")).checks.map((check: any) => check.type)).toEqual(["oauth-discovery"]);
  });

  it("reports Breeze's manual source and rationale on every advisory run", async () => {
    const result = reportFor(providerDirectory, ["--provider", "breeze"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.output).manual[0]).toMatchObject({
      provider: "breeze",
      source: "https://app.breezechms.com/api",
      findings: [{ kind: "manual-required", detail: expect.stringContaining("hand-written HTML") }],
    });
    expect(reportFor(providerDirectory, ["--provider", "breeze", "--strict"]).status).toBe(1);
    expect(
      JSON.parse(reportFor(providerDirectory, ["--specs", "--docs", "--provider", "breeze"]).output).manual[0]
        .findings[0].kind,
    ).toBe("manual-required");
  });

  it.each(["source", "rationale"])("rejects a manual check without %s while continuing other checks", async (field) => {
    const incomplete = { ...manualCheck, [field]: " " };
    const directory = await recordWorkspace({
      vendor: { version: 1, provider: "vendor", checks: [incomplete, manualCheck] },
    });
    const result = reportFor(directory);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.output).manual.map((entry: any) => entry.findings[0].kind)).toEqual([
      "evidence-invalid",
      "manual-required",
    ]);
  });

  it.each([
    { version: 2, provider: "bad", checks: [manualCheck] },
    { version: 1, provider: "wrong-folder", checks: [manualCheck] },
    { version: 1, provider: "bad", checks: [] },
  ])("reports malformed record headers without losing another provider", async (bad) => {
    const directory = await recordWorkspace({ bad, good: { version: 1, provider: "good", checks: [manualCheck] } });
    const result = reportFor(directory);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.output)).toMatchObject({
      records: [{ provider: "bad", findings: [{ kind: "evidence-invalid" }] }],
      manual: [{ provider: "good" }],
    });
  });

  it("reports a Vercel parser failure and a network failure while still checking a later provider", async () => {
    const directory = await recordWorkspace({
      vercel: { version: 1, provider: "vercel", checks: [vercelEvidence, manualCheck] },
      "z-vendor": { version: 1, provider: "z-vendor", checks: [linearEvidence] },
    });
    const moved = join(directory, "moved.md");
    const setup = join(directory, "setup.md");
    await writeFile(moved, "# Tools moved to category pages\n");
    await writeFile(setup, `OAuth ${VERCEL_MCP_ENDPOINT} ${LINEAR_MCP_ENDPOINTS["read-write"]}`);
    const result = reportFor(directory, [
      "--tool-reference",
      `vercel=${moved}`,
      "--setup-reference",
      `vercel=${setup}`,
      "--setup-reference",
      `z-vendor=${setup}`,
    ]);
    const report = JSON.parse(result.output);
    expect(result.status).toBe(0);
    expect(report.docs).toMatchObject([
      { provider: "vercel", findings: [{ kind: "unavailable" }] },
      { provider: "z-vendor", findings: [] },
    ]);
    expect(report.manual).toMatchObject([{ provider: "vercel", findings: [{ kind: "manual-required" }] }]);
    const network = reportFor(directory, [
      "--setup-reference",
      `vercel=${join(directory, "absent.md")}`,
      "--tool-reference",
      `vercel=${moved}`,
      "--setup-reference",
      `z-vendor=${setup}`,
    ]);
    expect(JSON.parse(network.output).docs).toMatchObject([
      { provider: "vercel", findings: [{ kind: "unavailable" }] },
      { provider: "z-vendor", findings: [] },
    ]);
  });

  it("reports malformed specification JSON without recording it or stopping the next provider", async () => {
    const { directory } = await workspace(["cloudflare", "notion"]);
    const path = join(directory, "cloudflare", "drift.json");
    const before = await readFile(path, "utf8");
    await writeFile(join(directory, "cloudflare-spec.json"), "{bad json");
    const result = run(directory, ["cloudflare", "notion"], ["--record", "--json"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.output).specs).toMatchObject([
      { provider: "cloudflare", findings: [{ kind: "parser-error" }] },
      { provider: "notion", findings: [] },
    ]);
    expect(await readFile(path, "utf8")).toBe(before);
    expect((await driftRecord("notion", directory)).checks[0].endpoints[0].contract).toMatch(/^sha256:/);
  });

  it("refuses implicit recording and writes only explicitly selected endpoint evidence", async () => {
    const { directory, specifications } = await workspace(["cloudflare", "notion"]);
    expect(reportFor(directory, ["--record"]).status).toBe(2);
    const path = join(directory, "cloudflare", "drift.json");
    const record = await driftRecord("cloudflare", directory);
    record.checks[0].endpoints[0].evidence = { source: "https://vendor.example/review" };
    record.checks.push(cloudflareEvidence, manualCheck);
    await writeFile(path, JSON.stringify(record));
    const untouchedPath = join(directory, "notion", "drift.json");
    const untouched = await readFile(untouchedPath, "utf8");
    const before = await readFile(path, "utf8");
    expect(run(directory, ["cloudflare"], ["--json"]).status).toBe(0);
    expect(await readFile(path, "utf8")).toBe(before);
    const result = run(directory, ["cloudflare"], ["--record", "--json"]);
    expect(result.status).toBe(0);
    const after = await driftRecord("cloudflare", directory);
    expect(after.checks[0].specification).toEqual(record.checks[0].specification);
    expect(after.checks[0].endpoints[0].evidence).toEqual(record.checks[0].endpoints[0].evidence);
    expect(after.checks.slice(1)).toEqual(record.checks.slice(1));
    expect(after.checks[0].endpoints[0].specRevision).toBe(specifications.cloudflare!.info.version);
    expect(await readFile(untouchedPath, "utf8")).toBe(untouched);
    expect(
      run(directory, ["cloudflare"], ["--spec", `notion=${join(directory, "notion-spec.json")}`, "--record"]).status,
    ).toBe(2);
  });

  it("reports per-product parser errors and continues version and endpoint checks without recording partial evidence", async () => {
    const { directory, documentation, specification } = await planningCenterWorkspace();
    expect(runPlanningCenter(directory, ["--record"]).status).toBe(0);
    const path = join(directory, "planning-center", "drift.json");
    const before = await readFile(path, "utf8");
    await writeFile(documentation("people"), "{}");
    await writeFile(specification("people"), "[]");
    const groups = JSON.parse(await readFile(documentation("groups"), "utf8"));
    groups.data.relationships.versions.data.push({ id: "2027-01-01" });
    await writeFile(documentation("groups"), JSON.stringify(groups));
    const result = runPlanningCenter(directory, ["--record"]);
    expect(result.status).toBe(0);
    expect(findings(result.output, "planning-center")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ app: "people", kind: "parser-error" }),
        expect.objectContaining({ app: "groups", kind: "version-published" }),
      ]),
    );
    expect(await readFile(path, "utf8")).toBe(before);
  });
});

describe("hosted vendor evidence", () => {
  it("retains each runtime endpoint and release-reviewed name list through folder discovery", async () => {
    for (const entry of await readdir(providerDirectory, { withFileTypes: true })) {
      if (
        !entry.isDirectory() ||
        entry.name.startsWith("_") ||
        !existsSync(join(providerDirectory, entry.name, "drift.json"))
      )
        continue;
      const checks = (await driftRecord(entry.name)).checks.filter(
        (check: any) => check.type === "mcp-docs" || check.type === "oauth-discovery",
      );
      if (checks.length === 0) continue;
      const folderEntry = join(providerDirectory, entry.name, "index.ts");
      const source = existsSync(folderEntry) ? folderEntry : join(providerDirectory, `${entry.name}.ts`);
      const module = await import(pathToFileURL(source).href);
      const endpointValues = Object.entries(module)
        .filter(([name]) => /_MCP_ENDPOINTS?$/.test(name))
        .flatMap(([, value]) => (typeof value === "string" ? [value] : Object.values(value as object)));
      const reviewedLists = Object.values(module).flatMap((value: any) => {
        if (value?.tools instanceof Map) return [[...value.tools.keys()].sort()];
        if (value?.definition?.classify?.tools) return [Object.keys(value.definition.classify.tools).sort()];
        return [];
      });
      for (const check of checks) {
        expect(
          check.endpoints.every((endpoint: string) => endpointValues.includes(endpoint)),
          entry.name,
        ).toBe(true);
        expect(reviewedLists, entry.name).toContainEqual([...check.reviewed].sort());
      }
    }
  });
});

const endpointEvidence = {
  type: "endpoints",
  specification: { url: "https://vendor.example/openapi.json" },
  endpoints: [{ method: "GET", path: "/item", specRevision: "1", contract: `sha256:${"a".repeat(64)}` }],
};

describe("drift evidence validation", () => {
  it.each(["spec", "setup-reference"])("keeps null checks provider-local with a %s override", async (override) => {
    const check = override === "spec" ? endpointEvidence : linearEvidence;
    const directory = await recordWorkspace({
      vendor: { version: 1, provider: "vendor", checks: [null, check] },
      other: { version: 1, provider: "other", checks: [manualCheck] },
    });
    const source = join(directory, "reference");
    await writeFile(
      source,
      override === "spec"
        ? JSON.stringify({ openapi: "3.1.0", info: { version: "1" }, paths: { "/item": { get: operation("item") } } })
        : `${linearEvidence.endpoints.join(" ")} OAuth`,
    );
    const result = reportFor(directory, [`--${override}`, `vendor=${source}`]);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.output);
    expect(report.records).toEqual([
      { provider: "vendor", check: 0, findings: [expect.objectContaining({ kind: "evidence-invalid" })] },
    ]);
    expect(report.manual).toEqual([expect.objectContaining({ provider: "other" })]);
    expect(override === "spec" ? report.specs : report.docs).toEqual([expect.objectContaining({ provider: "vendor" })]);
  });

  it.each([
    { ...endpointEvidence, endpoints: [{ ...endpointEvidence.endpoints[0], contract: "not-a-digest" }] },
    { ...endpointEvidence, endpoints: [{ method: "GET", path: "/item", specRevision: "1" }] },
    { ...endpointEvidence, endpoints: [endpointEvidence.endpoints[0], endpointEvidence.endpoints[0]] },
    { ...endpointEvidence, specification: { url: "https://vendor.example/openapi.json", format: "guess" } },
    { ...vercelEvidence, inventory: { url: "https://vendor.example/tools", format: "guess" } },
    { ...vercelEvidence, reviewed: [] },
    { type: "unknown" },
    null,
  ])("reports invalid check evidence before network access and continues manual review", async (check) => {
    const directory = await recordWorkspace({
      vendor: { version: 1, provider: "vendor", checks: [check, manualCheck] },
    });
    const result = reportFor(directory);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.output);
    expect([...report.specs, ...report.docs, ...report.records].flatMap((entry: any) => entry.findings)).toEqual([
      expect.objectContaining({ kind: "evidence-invalid" }),
    ]);
    expect(report.manual[0].findings[0].kind).toBe("manual-required");
  });
});

describe("public reference availability", { timeout: CASE_TIMEOUT_MS }, () => {
  it("reports HTTP failures per provider and completes the remaining checks", async () => {
    const http = createServer((_request, response) => {
      response.statusCode = 503;
      response.end("temporarily unavailable");
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    try {
      const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/setup`;
      const directory = await recordWorkspace({
        failed: { version: 1, provider: "failed", checks: [{ ...linearEvidence, setup: url }] },
        good: { version: 1, provider: "good", checks: [manualCheck] },
      });
      const result = await new Promise<{ status: number; output: string }>((resolve) => {
        execFile(
          process.execPath,
          [checker, "--provider-dir", directory, "--json"],
          { encoding: "utf8" },
          (error, stdout, stderr) => {
            resolve({ status: error ? Number(error.code) : 0, output: `${stdout}${stderr}` });
          },
        );
      });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.output)).toMatchObject({
        docs: [
          { provider: "failed", findings: [{ kind: "unavailable", detail: expect.stringContaining("HTTP 503") }] },
        ],
        manual: [{ provider: "good", findings: [{ kind: "manual-required" }] }],
      });
    } finally {
      await new Promise((resolve) => http.close(resolve));
    }
  });
});

describe("public hosted catalog drift", () => {
  const reviewed = [
    { name: "read_item", annotations: { readOnlyHint: true, destructiveHint: false } },
    { name: "edit_item", annotations: { readOnlyHint: false, destructiveHint: true } },
  ];
  const check = { type: "mcp-catalog", endpoint: "https://catalog.example/mcp", reviewed };

  async function fixture(tools: unknown[], nextCursor?: string) {
    const directory = await recordWorkspace({ vendor: { version: 1, provider: "vendor", checks: [check] } });
    const catalog = join(directory, "catalog.json");
    await writeFile(
      catalog,
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools, ...(nextCursor === undefined ? {} : { nextCursor }) } }),
    );
    return { directory, catalog };
  }
  function catalogRun(directory: string, catalog: string, extra: string[] = []) {
    return spawnSync(
      process.execPath,
      [checker, "--docs", "--provider-dir", directory, "--tool-reference", `vendor=${catalog}`, "--json", ...extra],
      { encoding: "utf8" },
    );
  }

  it("reports additions, removals and weakened read/write annotations without adopting or recording them", async () => {
    const { directory, catalog } = await fixture([
      { name: "read_item", annotations: { readOnlyHint: false, destructiveHint: false } },
      { name: "new_item", annotations: { readOnlyHint: true } },
    ]);
    const path = join(directory, "vendor", "drift.json");
    const before = await readFile(path, "utf8");
    const result = catalogRun(directory, catalog, ["--record", "--provider", "vendor"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).docs[0].findings).toEqual([
      { kind: "catalog-annotations", detail: "read_item: behavioral annotations changed" },
      { kind: "catalog-added", detail: "new_item" },
      { kind: "catalog-removed", detail: "edit_item" },
    ]);
    expect(await readFile(path, "utf8")).toBe(before);
    expect(catalogRun(directory, catalog, ["--strict"]).status).toBe(1);
  });

  it("ignores titles and schemas but reports missing hints", async () => {
    const { directory, catalog } = await fixture(
      reviewed.map((tool) => ({
        ...tool,
        annotations: { ...tool.annotations, title: "new title" },
        inputSchema: { changed: true },
      })),
    );
    expect(JSON.parse(catalogRun(directory, catalog).stdout).findings).toBe(0);
    await writeFile(
      catalog,
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: reviewed.map((tool) => ({ name: tool.name })) } }),
    );
    expect(
      JSON.parse(catalogRun(directory, catalog).stdout).docs[0].findings.map((finding: any) => finding.kind),
    ).toEqual(["catalog-annotations", "catalog-annotations"]);
  });

  it.each([
    [{ name: "duplicate" }, { name: "duplicate" }],
    [{ name: "bad_hint", annotations: { readOnlyHint: "true" } }],
  ])("reports malformed catalogs without a partial comparison", async (...tools) => {
    const { directory, catalog } = await fixture(tools);
    const report = JSON.parse(catalogRun(directory, catalog).stdout);
    expect(report.docs[0].findings).toEqual([expect.objectContaining({ kind: "parser-error" })]);
    expect(report.docs[0].catalogTools).toBeUndefined();
  });

  it("never compares an incomplete file catalog", async () => {
    const { directory, catalog } = await fixture(reviewed, "more");
    expect(JSON.parse(catalogRun(directory, catalog).stdout).docs[0].findings).toEqual([
      expect.objectContaining({ kind: "parser-error" }),
    ]);
  });

  it("sends only unauthenticated tools/list, follows pagination and isolates protected catalogs", async () => {
    const requests: { method: string | undefined; authorization: string | undefined; body: any }[] = [];
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      requests.push({ method: request.method, authorization: request.headers.authorization, body: JSON.parse(body) });
      if (request.url === "/protected") {
        response.writeHead(401).end();
        return;
      }
      const cursor = JSON.parse(body).params.cursor;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            tools: cursor === undefined ? [reviewed[0]] : [reviewed[1]],
            ...(cursor === undefined ? { nextCursor: "page-2" } : {}),
          },
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const directory = await recordWorkspace({
        vendor: { version: 1, provider: "vendor", checks: [check] },
        protected: { version: 1, provider: "protected", checks: [check] },
      });
      const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        execFile(
          process.execPath,
          [
            checker,
            "--docs",
            "--provider-dir",
            directory,
            "--json",
            "--tool-reference",
            `vendor=${origin}/catalog`,
            "--tool-reference",
            `protected=${origin}/protected`,
          ],
          (error, stdout, stderr) => (error ? reject(error) : resolve({ stdout, stderr })),
        );
      });
      const report = JSON.parse(result.stdout);
      expect(report.docs.find((entry: any) => entry.provider === "vendor")).toMatchObject({
        catalogTools: 2,
        findings: [],
      });
      expect(report.docs.find((entry: any) => entry.provider === "protected").findings).toEqual([
        expect.objectContaining({ kind: "unavailable" }),
      ]);
      expect(requests).toHaveLength(3);
      for (const request of requests) {
        expect(request.method).toBe("POST");
        expect(request.authorization).toBeUndefined();
        expect(request.body).toMatchObject({ jsonrpc: "2.0", id: 1, method: "tools/list" });
        expect(Object.keys(request.body.params).every((key) => key === "cursor")).toBe(true);
      }
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});
