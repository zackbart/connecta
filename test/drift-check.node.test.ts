// Node-only: spawns the Node maintainer drift checker against filesystem fixtures.
import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { checkView } from "../scripts/drift-validate.mjs";
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
const linearEvidence = await documentedEvidence("linear");
const vercelEvidence = await documentedEvidence("vercel");
const LINEAR_MCP_ENDPOINTS = { "read-write": linearEvidence.endpoints[0] };
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

/**
 * Fixture helpers read/write the endpoint check, preserving its versioned record wrapper. A version 2
 * record is read as the checker reads it: rows keyed by operation become method and path, pages join.
 */
async function readManifestFile(path: string): Promise<string> {
  const record = JSON.parse(await readFile(path, "utf8"));
  const check = record.checks.find((item: any) => item.type === "endpoints" || item.type === "versioned-endpoints");
  return JSON.stringify({ provider: record.provider, ...checkView(record, check) });
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
  const categories = vercelEvidence.inventory.categories as Record<string, string[]>;
  await writeFile(
    toolReference,
    "# Vercel tools\n\n" +
      Object.entries(categories)
        .map(
          ([category, names]) =>
            `[${category}\n${names.length} tools](/docs/agent-resources/vercel-mcp/tools/${category})`,
        )
        .join("\n"),
  );
  await Promise.all(
    Object.entries(categories).map(([category, names]) =>
      writeFile(join(directory, `${category}.md`), names.map((name) => `## \`${name}\``).join("\n\n")),
    ),
  );
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
  it.each(["infisical", "notion", "overflow", "tithely"])(
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

  it.each([
    ["--specs", "linear", "--docs"],
    ["--specs", "revenuecat", "--docs"],
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

  it(
    "reports a pinned OpenAPI index whose live document changed, and stays quiet while it matches",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "connecta-openapi-index-"));
      temporary.push(directory);
      const document = JSON.stringify({ openapi: "3.0.0", info: { version: "2026-01-01" }, paths: {} });
      const { createHash } = await import("node:crypto");
      const digest = `sha256:${createHash("sha256").update(document).digest("hex")}`;
      await mkdir(join(directory, "acme"));
      await writeFile(
        join(directory, "acme", "drift.json"),
        JSON.stringify({
          version: 1,
          provider: "acme",
          checks: [{ type: "openapi-index", source: "openapi.source.json" }],
        }),
      );
      await writeFile(
        join(directory, "acme", "openapi.source.json"),
        JSON.stringify({ url: "https://vendor.example/v1/openapi.json", revision: "v1", digest }),
      );
      const spec = join(directory, "live.json");
      const run = () =>
        spawnSync(
          process.execPath,
          [checker, "--specs", "--provider-dir", directory, "--provider", "acme", "--spec", `acme=${spec}`, "--json"],
          { encoding: "utf8" },
        );
      await writeFile(spec, document);
      const clean = run();
      expect(clean.status).toBe(0);
      expect(JSON.parse(clean.stdout).specs[0]).toMatchObject({ provider: "acme", revision: "v1", findings: [] });
      await writeFile(spec, document.replace("2026-01-01", "2026-02-01"));
      const drifted = run();
      expect(drifted.status).toBe(0);
      const [finding] = JSON.parse(drifted.stdout).specs[0].findings;
      expect(finding.kind).toBe("spec-drift");
      expect(finding.detail).toContain("info.version 2026-02-01");
      expect(finding.detail).toContain("providers:spec -- --provider acme --record");
    },
    CASE_TIMEOUT_MS,
  );

  it("INV-1: reports a captured Vercel tool removal and its stale acknowledgement after complete count reconciliation", async () => {
    const { directory, toolReference, setupReference } = await documentedVercelWorkspace();
    await writeFile(toolReference, (await readFile(toolReference, "utf8")).replace("23 tools", "22 tools"));
    const sandboxes = join(directory, "sandboxes.md");
    await writeFile(sandboxes, (await readFile(sandboxes, "utf8")).replace("## `run_session_command`", ""));
    const result = JSON.parse(runDocumented("vercel", toolReference, setupReference).output).docs[0];
    expect(result).toMatchObject({
      documentedTools: 246,
      added: [],
      removed: ["run_session_command"],
      findings: [
        {
          kind: "stale-unclassified-acknowledgement",
          detail: "run_session_command: acknowledgement no longer applies",
        },
      ],
    });
    expect(result.intentionallyUnclassified).not.toContain("run_session_command");
  });

  it("INV-1: detects documented access changes and stale unclassified acknowledgements", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connecta-drift-access-"));
    temporary.push(directory);
    const records = await recordWorkspace({
      crm: {
        version: 1,
        provider: "crm",
        checks: [
          {
            type: "mcp-docs",
            setup: "https://crm.example/setup",
            inventory: {
              url: "https://crm.example/tools",
              format: "table",
              accessColumn: "Access",
              acknowledgedUnclassified: ["preview"],
            },
            endpoints: ["https://crm.example/mcp"],
            reviewed: ["list"],
            reviewedAccess: { list: "write" },
          },
        ],
      },
    });
    const reference = join(directory, "crm.md");
    const run = () =>
      reportFor(records, ["--docs", "--tool-reference", `crm=${reference}`, "--setup-reference", `crm=${reference}`]);
    await writeFile(
      reference,
      "# MCP\nOAuth https://crm.example/mcp\n\n| Tool | Access | Description |\n| --- | --- | --- |\n| `list` | Read | Checks credentials |\n| `preview` | Read | Renders screenshot |\n| `preview` | | Duplicate with blank access |\n",
    );
    const result = run();
    expect(result.status).toBe(0);
    const report = JSON.parse(result.output).docs[0];
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "documented-access-changed",
          detail: expect.stringContaining("list"),
        }),
        expect.objectContaining({
          kind: "stale-unclassified-acknowledgement",
          detail: expect.stringContaining("preview"),
        }),
      ]),
    );
    expect(report.intentionallyUnclassified).not.toContain("preview");
    expect(report.added).toContain("preview");
    // Reordered columns work too; blank access retains its explicit acknowledgement.
    await writeFile(
      reference,
      "# MCP\nOAuth https://crm.example/mcp\n\n| Access | Description | Tool |\n| --- | --- | --- |\n| Write | Checks credentials | `list` |\n| | Renders screenshot | `preview` |\n",
    );
    const quiet = JSON.parse(run().output).docs[0];
    expect(quiet.findings).toEqual([]);
    expect(quiet.intentionallyUnclassified).toContain("preview");
  });

  it("INV-1: checks Intercom-style Access tables without weakening required columns or write verdicts", async () => {
    const evidence = await documentedEvidence("intercom");
    const { intercom } = await import("../src/providers/intercom/index.js");
    const reviewedAccess = Object.fromEntries(
      Object.entries(intercom.definition.classify!.tools).map(([name, entry]) => [
        name,
        (typeof entry === "string" ? entry : entry.verdict) === "read" ? "read" : "write",
      ]),
    );
    const records = await recordWorkspace({
      intercom: {
        version: 1,
        provider: "intercom",
        checks: [
          {
            ...evidence,
            inventory: { url: evidence.setup, format: "table", accessColumn: "Access" },
            reviewedAccess,
          },
        ],
      },
    });
    const reference = join(records, "intercom.md");
    const run = () =>
      reportFor(records, [
        "--docs",
        "--strict",
        "--tool-reference",
        `intercom=${reference}`,
        "--setup-reference",
        `intercom=${reference}`,
      ]);
    // Credential-free fixture, not a claim the current public docs have this table.
    const text =
      `# MCP\nOAuth ${evidence.endpoints.join(" ")}\n\n| Description | Access | Tool |\n| --- | --- | --- |\n` +
      Object.entries(reviewedAccess)
        .map(([name, access]) => `| Documented behavior | **${access}** | \`${name}\` |`)
        .join("\n");
    await writeFile(reference, text);
    const clean = run();
    expect(clean.status).toBe(0);
    expect(JSON.parse(clean.output).docs[0]).toMatchObject({
      documentedTools: 19,
      findings: [],
      added: [],
      removed: [],
    });
    await writeFile(
      reference,
      text.replace("| **write** | `send_operator_message`", "| Read | `send_operator_message`"),
    );
    const drifted = run();
    expect(drifted.status).toBe(1);
    expect(JSON.parse(drifted.output).docs[0].findings).toEqual([
      { kind: "documented-access-changed", detail: "send_operator_message: docs declare read, reviewed write" },
    ]);
    await writeFile(reference, text.replace("| Description | Access | Tool |", "| Description | Permissions | Tool |"));
    expect(JSON.parse(run().output).docs[0].findings).toEqual([
      expect.objectContaining({ kind: "parser-error", detail: expect.stringContaining("no longer contains Access") }),
    ]);
  });

  it("INV-1: reports reviewed Access evidence that disappears without masking explicit duplicates", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connecta-drift-access-missing-"));
    temporary.push(directory);
    const reference = join(directory, "revenuecat.md");
    const text = "# MCP\nOAuth https://mcp.revenuecat.ai/mcp\n\n| Tool | Access |\n| --- | --- |\n| `get-app` | |\n";
    await writeFile(reference, text);
    const report = JSON.parse(runDocumented("revenuecat", reference, reference).output).docs[0];
    expect(report.findings).toContainEqual(
      expect.objectContaining({ kind: "documented-access-missing", detail: expect.stringContaining("get-app") }),
    );
    await writeFile(reference, `${text}| \`get-app\` | Read |\n`);
    const recovered = JSON.parse(runDocumented("revenuecat", reference, reference).output).docs[0];
    expect(recovered.findings.some((finding: Finding) => finding.kind === "documented-access-missing")).toBe(false);
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
      expect(record.provider).toBe(provider);
      expect([1, 2]).toContain(record.version);
      expect(record.checks.length).toBeGreaterThan(0);
      for (const check of record.checks) {
        expect([
          "endpoints",
          "versioned-endpoints",
          "mcp-docs",
          "oauth-discovery",
          "mcp-catalog",
          "manual",
          "openapi-index",
        ]).toContain(check.type);
        if (check.type === "openapi-index") {
          const source = JSON.parse(await readFile(join(providerDirectory, provider, check.source), "utf8"));
          expect(source.url).toMatch(/^https:\/\//);
          expect(source.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
          expect(existsSync(join(providerDirectory, provider, "openapi.generated.ts"))).toBe(true);
        }
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

const endpointEvidence = {
  type: "endpoints",
  specification: { url: "https://vendor.example/openapi.json" },
  endpoints: [{ method: "GET", path: "/item", specRevision: "1", contract: `sha256:${"a".repeat(64)}` }],
};

describe("drift evidence validation", () => {
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

  it.each([
    [{ name: "duplicate" }, { name: "duplicate" }],
    [{ name: "bad_hint", annotations: { readOnlyHint: "true" } }],
  ])("reports malformed catalogs without a partial comparison", async (...tools) => {
    const { directory, catalog } = await fixture(tools);
    const report = JSON.parse(catalogRun(directory, catalog).stdout);
    expect(report.docs[0].findings).toEqual([expect.objectContaining({ kind: "parser-error" })]);
    expect(report.docs[0].catalogTools).toBeUndefined();
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

describe("version 2 drift records (decision 0011, D)", { timeout: CASE_TIMEOUT_MS }, () => {
  const day = (offset: number) => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
  const generated = (operations: string[] = [], hosted: string[] = []) => ({ operations, hosted, evidence: {} });
  const v2 = (checks: unknown[], extra: object = {}) => ({
    version: 2,
    provider: "vendor",
    generated: generated(),
    checks,
    ...extra,
  });
  const manual = (lastVerified: string) => ({
    type: "manual",
    source: "https://vendor.example/reference",
    reason: "The reference is hand-written HTML.",
    lastVerified,
  });
  const evidenceInvalid = (report: any) =>
    [...report.specs, ...report.docs, ...report.manual, ...report.records].flatMap((entry: any) => entry.findings);

  it.each([
    ["a future lastVerified", { ...manual(day(1)), lastVerified: day(-2) }],
    ["a rationale", { type: "manual", source: "https://vendor.example", rationale: "Prose.", lastVerified: day(1) }],
    ["a nested reviewedAt", { ...manual(day(1)), evidence: { reviewedAt: day(1) } }],
    ["an http source", { ...manual(day(1)), source: "http://vendor.example" }],
    [
      "a reviewed list",
      {
        type: "mcp-docs",
        setup: "https://vendor.example/mcp",
        endpoints: ["https://mcp.vendor.example"],
        reviewed: ["a"],
      },
    ],
    [
      "a legacy catalog",
      { type: "mcp-catalog", endpoint: "https://mcp.vendor.example", catalog: "catalog.fixture.json" },
    ],
    ["a legacy pin", { type: "openapi-index", source: "openapi.source.json" }],
  ])("refuses %s in a version 2 check as invalid evidence", async (_label, check) => {
    const directory = await recordWorkspace({ vendor: v2([check]) });
    expect(evidenceInvalid(JSON.parse(reportFor(directory).output))).toEqual([
      expect.objectContaining({ kind: "evidence-invalid" }),
    ]);
  });

  it("compares a public catalog with evidence/catalog.json, names and all four hints, missing hints included", async () => {
    const directory = await recordWorkspace({
      vendor: v2([
        { type: "mcp-catalog", endpoint: "https://mcp.vendor.example/mcp", catalog: "evidence/catalog.json" },
      ]),
    });
    await mkdir(join(directory, "vendor", "evidence"));
    const capture = {
      capturedAt: day(1),
      method: "tools/list",
      source: "https://mcp.vendor.example/mcp",
      tools: [
        { name: "edit_item", annotations: { readOnlyHint: false, destructiveHint: true } },
        { name: "read_item", annotations: { readOnlyHint: true } },
        { name: "silent_item" },
      ],
    };
    await writeFile(join(directory, "vendor", "evidence", "catalog.json"), JSON.stringify(capture));
    const live = join(directory, "live.json");
    await writeFile(
      live,
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: {
          tools: [
            { name: "read_item", annotations: { readOnlyHint: true, idempotentHint: true } },
            { name: "silent_item" },
            { name: "new_item", annotations: { readOnlyHint: true } },
          ],
        },
      }),
    );
    const run = () =>
      spawnSync(
        process.execPath,
        [checker, "--docs", "--provider-dir", directory, "--tool-reference", `vendor=${live}`, "--json"],
        {
          encoding: "utf8",
        },
      );
    const before = await readFile(join(directory, "vendor", "drift.json"), "utf8");
    expect(JSON.parse(run().stdout).docs[0].findings).toEqual([
      { kind: "catalog-annotations", detail: "read_item: behavioral annotations changed" },
      { kind: "catalog-added", detail: "new_item" },
      { kind: "catalog-removed", detail: "edit_item" },
    ]);
    expect(await readFile(join(directory, "vendor", "drift.json"), "utf8")).toBe(before);
    await writeFile(
      join(directory, "vendor", "evidence", "catalog.json"),
      JSON.stringify({ ...capture, method: "documentation" }),
    );
    expect(JSON.parse(run().stdout).docs[0].findings).toEqual([
      expect.objectContaining({
        kind: "evidence-invalid",
        detail: expect.stringContaining("not a tools/list capture"),
      }),
    ]);
  });

  it("keys endpoint rows by operation, records them in that spelling, and reports a manifest operation no row covers", async () => {
    const pages = await mkdtemp(join(tmpdir(), "connecta-drift-pages-"));
    temporary.push(pages);
    const page = (method: string, path: string, marker = path) =>
      [
        "# OpenAPI definition",
        "",
        "```json",
        JSON.stringify({
          openapi: "3.1.0",
          info: { version: "7" },
          paths: { [path]: { [method]: operation(marker) } },
        }),
        "```",
      ].join("\n");
    await writeFile(join(pages, "list-items.md"), page("get", "/items"));
    await writeFile(join(pages, "create-item.md"), page("post", "/items"));
    const record = v2(
      [
        {
          type: "endpoints",
          specification: { url: "https://docs.vendor.example/reference/", format: "readme-operation-pages" },
          endpoints: [
            { operation: "GET /items", page: "list-items", specRevision: "0" },
            { operation: "POST /items", page: "create-item", specRevision: "0" },
          ],
        },
      ],
      {
        generated: {
          operations: ["DELETE /items/{id}", "GET /items", "POST /items"],
          hosted: [],
          evidence: { "openapi.json": `sha256:${"0".repeat(64)}` },
        },
      },
    );
    const directory = await recordWorkspace({ vendor: record });
    const run = (extra: string[] = []) =>
      spawnSync(
        process.execPath,
        [
          checker,
          "--specs",
          "--provider-dir",
          directory,
          "--provider",
          "vendor",
          "--spec",
          `vendor=${pages}`,
          "--json",
          ...extra,
        ],
        { encoding: "utf8" },
      );
    const unrecorded = {
      provider: "vendor",
      findings: [
        {
          kind: "operation-unrecorded",
          method: "DELETE",
          path: "/items/{id}",
          detail: expect.stringContaining("DELETE /items/{id}"),
        },
      ],
    };
    const recordedRun = JSON.parse(run(["--record"]).stdout);
    expect(recordedRun.specs).toEqual([unrecorded, expect.objectContaining({ check: 0, findings: [] })]);
    const path = join(directory, "vendor", "drift.json");
    const text = await readFile(path, "utf8");
    const recorded = JSON.parse(text);
    expect(Object.keys(recorded)).toEqual(["version", "provider", "generated", "checks"]);
    expect(recorded.generated).toEqual(record.generated);
    expect(recorded.checks[0].endpoints).toEqual([
      { operation: "GET /items", page: "list-items", specRevision: "7", contract: expect.stringMatching(/^sha256:/) },
      { operation: "POST /items", page: "create-item", specRevision: "7", contract: expect.stringMatching(/^sha256:/) },
    ]);
    expect(text).toBe(`${JSON.stringify(recorded, null, 2)}\n`);
    expect(JSON.parse(run().stdout).specs).toEqual([unrecorded, expect.objectContaining({ check: 0, findings: [] })]);
    await writeFile(join(pages, "create-item.md"), page("post", "/items", "changed"));
    expect(JSON.parse(run().stdout).specs[1].findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "contract-changed", method: "POST", path: "/items" })]),
    );
    for (const row of [
      { method: "GET", path: "/items", specRevision: "0" },
      { operation: "GET /unsent", specRevision: "0" },
    ]) {
      const invalid = await recordWorkspace({
        vendor: {
          ...record,
          checks: [{ ...(record.checks[0] as object), endpoints: [{ ...row, page: "list-items" }] }],
        },
      });
      expect(
        evidenceInvalid(JSON.parse(reportFor(invalid, ["--specs"]).output)).filter(
          (finding: any) => finding.kind !== "operation-unrecorded",
        ),
      ).toEqual([
        expect.objectContaining({ kind: "evidence-invalid", detail: expect.stringContaining("keyed by an operation") }),
      ]);
    }
  });

  it("checks an OpenAPI pin kept at evidence/openapi.json", async () => {
    const document = JSON.stringify({ openapi: "3.1.0", info: { version: "1" }, paths: {} });
    const digest = `sha256:${createHash("sha256").update(document).digest("hex")}`;
    const directory = await recordWorkspace({
      vendor: v2([{ type: "openapi-index", source: "evidence/openapi.json" }]),
    });
    await mkdir(join(directory, "vendor", "evidence"));
    const pin = { url: "https://vendor.example/openapi.json", revision: "1", digest };
    await writeFile(join(directory, "vendor", "evidence", "openapi.json"), JSON.stringify(pin));
    const live = join(directory, "live.json");
    await writeFile(live, document);
    const run = () =>
      JSON.parse(
        spawnSync(
          process.execPath,
          [checker, "--specs", "--provider-dir", directory, "--spec", `vendor=${live}`, "--json"],
          {
            encoding: "utf8",
          },
        ).stdout,
      ).specs[0].findings;
    expect(run()).toEqual([]);
    await writeFile(live, document.replace('"1"', '"2"'));
    expect(run()).toEqual([
      expect.objectContaining({ kind: "spec-drift", detail: expect.stringContaining("evidence/openapi.json") }),
    ]);
  });
});
