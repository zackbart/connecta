import { execFile, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { BASECAMP_MCP_ENDPOINT } from "../src/providers/basecamp.js";
import {
  CLOUDFLARE_MCP_ENDPOINT,
  CLOUDFLARE_MCP_VETTED_CATALOG,
} from "../src/providers/cloudflare.js";
import { LINEAR_MCP_ENDPOINTS } from "../src/providers/linear.js";
import {
  NOTION_MCP_ENDPOINT,
  NOTION_MCP_VETTED_CATALOG,
} from "../src/providers/notion.js";
import {
  STRIPE_MCP_ENDPOINT,
  STRIPE_VETTED_CATALOG,
} from "../src/providers/stripe.js";
import {
  VERCEL_MCP_ENDPOINT,
  VERCEL_MCP_VETTED_CATALOG,
} from "../src/providers/vercel.js";

const checker = fileURLToPath(
  new URL("../scripts/drift-check.mjs", import.meta.url),
);
const tsx = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));
const manifestDirectory = fileURLToPath(new URL("../scripts/drift", import.meta.url));
const temporary: string[] = [];

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
  return JSON.parse(
    await readFile(join(manifestDirectory, `${provider}-endpoints.json`), "utf8"),
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
function specificationFor(
  manifest: Manifest,
  version = "test-1",
): Record<string, any> {
  const paths: Record<string, Record<string, unknown>> = {
    "/untouched/thing": { get: operation("untouched"), delete: operation("untouched") },
    "/untouched/other": { post: operation("untouched") },
  };
  for (const endpoint of manifest.endpoints) {
    paths[endpoint.path] ??= {};
    paths[endpoint.path]![endpoint.method.toLowerCase()] = operation(
      `${endpoint.method} ${endpoint.path}`,
    );
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
    await writeFile(
      join(directory, `${provider}-endpoints.json`),
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
    await writeFile(
      join(directory, `${provider}-spec.json`),
      JSON.stringify(specifications[provider]),
    );
  }
  return { directory, manifests, specifications };
}

function run(
  directory: string,
  providers: string[],
  extra: string[] = [],
) {
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
  const headings = [...VERCEL_MCP_VETTED_CATALOG.tools.keys()]
    .sort()
    .map((name) => `### ${name.replaceAll("_", "\\_")}`)
    .join("\n\n");
  await writeFile(toolReference, `# Vercel tools\n\n${headings}\n`);
  await writeFile(
    setupReference,
    `# Vercel MCP setup\n\nEndpoint: ${VERCEL_MCP_ENDPOINT}\n\nOAuth is required.\n`,
  );
  return { directory, toolReference, setupReference };
}

function runDocumented(
  provider: string,
  toolReference: string,
  setupReference: string,
) {
  const result = spawnSync(
    process.execPath,
    [
      tsx,
      checker,
      "--docs",
      "--provider",
      provider,
      ...(toolReference
        ? ["--tool-reference", `${provider}=${toolReference}`]
        : []),
      "--setup-reference",
      `${provider}=${setupReference}`,
      "--json",
    ],
    { encoding: "utf8" },
  );
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("maintainer drift check", () => {
  it("records the touched endpoints and then reports no drift against them", async () => {
    const { directory } = await workspace(["cloudflare", "notion"]);
    const recorded = run(directory, ["cloudflare", "notion"], ["--record"]);
    expect(recorded.status).toBe(0);

    const manifest: Manifest = JSON.parse(
      await readFile(join(directory, "cloudflare-endpoints.json"), "utf8"),
    );
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
      const goneMethod = endpoints.find(
        (endpoint) => endpoint.path !== gonePath.path,
      )!;
      const deprecated = endpoints.find(
        (endpoint) =>
          endpoint.path !== gonePath.path && endpoint.path !== goneMethod.path,
      )!;
      const changed = endpoints.find(
        (endpoint) =>
          endpoint.path !== gonePath.path &&
          endpoint.path !== goneMethod.path &&
          endpoint.path !== deprecated.path,
      )!;

      // Everything the provider does not touch moves at once: one path gone,
      // one operation deprecated, one contract rewritten.
      delete specification.paths["/untouched/other"];
      specification.paths["/untouched/thing"].get.deprecated = true;
      specification.paths["/untouched/thing"].delete = operation("rewritten");

      delete specification.paths[gonePath.path];
      delete specification.paths[goneMethod.path][goneMethod.method.toLowerCase()];
      specification.paths[deprecated.path][
        deprecated.method.toLowerCase()
      ].deprecated = true;
      specification.paths[changed.path][changed.method.toLowerCase()] =
        operation("rewritten");

      await writeFile(
        join(directory, `${provider}-spec.json`),
        JSON.stringify(specification),
      );

      const result = run(directory, [provider], ["--json"]);
      expect(result.status).toBe(1);
      const reported = findings(result.output, provider);
      // gonePath may carry more than one method; every one of them is a finding.
      const goneRows = endpoints.filter(
        (endpoint) => endpoint.path === gonePath.path,
      );
      expect(reported.filter((finding) => finding.kind === "path-gone")).toEqual(
        goneRows.map((endpoint) => expect.objectContaining({
          kind: "path-gone",
          method: endpoint.method,
          path: endpoint.path,
        })),
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
      expect(reported.map((finding) => finding.path)).not.toContain(
        "/untouched/thing",
      );
      expect(reported.map((finding) => finding.path)).not.toContain(
        "/untouched/other",
      );
      expect(reported).toHaveLength(goneRows.length + 3);
    },
  );

  it("keeps a revision bump that left the touched contracts alone quiet", async () => {
    const { directory, specifications } = await workspace(["notion"]);
    expect(run(directory, ["notion"], ["--record"]).status).toBe(0);

    specifications["notion"]!["info"].version = "test-2";
    await writeFile(
      join(directory, "notion-spec.json"),
      JSON.stringify(specifications["notion"]),
    );

    const result = run(directory, ["notion"], ["--json"]);
    expect(result.status).toBe(0);
    expect(findings(result.output, "notion")).toEqual([]);
  });

  it("fails clearly when a published specification is unavailable", async () => {
    const { directory } = await workspace(["notion"]);
    const result = run(directory, [], [
      "--provider",
      "notion",
      "--spec",
      `notion=${join(directory, "absent.json")}`,
    ]);
    expect(result.status).toBe(2);
    expect(result.output).toContain(
      "could not read notion's published specification",
    );
  });

  it("fails clearly when a touched-endpoint manifest is unavailable", async () => {
    const { directory } = await workspace(["notion"]);
    const result = run(directory, [], ["--provider", "cloudflare"]);
    expect(result.status).toBe(2);
    expect(result.output).toContain(
      "could not read cloudflare's touched-endpoint manifest",
    );
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
    const manifestPath = join(directory, "tithely-endpoints.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.specification.pages = slugs;
    await writeFile(manifestPath, JSON.stringify(manifest));
    const runPages = (extra: string[]) =>
      spawnSync(
        process.execPath,
        [checker, "--specs", "--manifest-dir", directory, "--provider", "tithely", "--spec", `tithely=${pagesDirectory}`, ...extra],
        { encoding: "utf8" },
      );

    expect(runPages(["--record"]).status).toBe(0);
    const quiet = runPages(["--json"]);
    expect(quiet.status).toBe(0);
    expect(findings(quiet.stdout, "tithely")).toEqual([]);

    const target = endpoints[0]!;
    await writeFile(join(pagesDirectory, "page-0.md"), page(target, "rewritten"));
    const drifted = runPages(["--json"]);
    expect(drifted.status).toBe(1);
    expect(findings(drifted.stdout, "tithely")).toEqual([
      expect.objectContaining({ kind: "contract-changed", method: target.method, path: target.path }),
    ]);

    await writeFile(join(pagesDirectory, "page-1.md"), "# Moved\n\nNo snippet here.");
    const broken = runPages([]);
    expect(broken.status).toBe(2);
    expect(`${broken.stdout}${broken.stderr}`).toContain("no longer embeds an OpenAPI definition");
  });

  it("has no credentialed hosted mode", () => {
    const result = spawnSync(process.execPath, [checker, "--hosted"], {
      encoding: "utf8",
    });
    expect(result.status).toBe(2);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "unknown argument: --hosted",
    );
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
    await writeFile(
      join(directory, "notion-spec.json"),
      JSON.stringify(specification),
    );
    expect(run(directory, ["notion"], ["--record"]).status).toBe(0);

    const recorded: Manifest = JSON.parse(
      await readFile(join(directory, "notion-endpoints.json"), "utf8"),
    );
    const digestFor = (endpoint: Endpoint) =>
      recorded.endpoints.find(
        (row) => row.method === endpoint.method && row.path === endpoint.path,
      )!.contract;
    expect(digestFor(alpha)).not.toBe(digestFor(beta));

    // A change inside the referenced schema is a change to the contract.
    specification["components"].schemas.alpha.properties.id = { type: "number" };
    await writeFile(
      join(directory, "notion-spec.json"),
      JSON.stringify(specification),
    );
    const result = run(directory, ["notion"], ["--json"]);
    expect(result.status).toBe(1);
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
    const operationOf = () =>
      specification["paths"][target.path][target.method.toLowerCase()];

    operationOf().deprecated = true;
    await writeFile(
      join(directory, "notion-spec.json"),
      JSON.stringify(specification),
    );
    // The first run reports it — nothing has reviewed it yet — and records it.
    const first = run(directory, ["notion"], ["--record", "--json"]);
    expect(first.status).toBe(1);
    expect(findings(first.output, "notion")).toEqual([
      expect.objectContaining({
        kind: "deprecated",
        method: target.method,
        path: target.path,
      }),
    ]);

    const recorded: Manifest = JSON.parse(
      await readFile(join(directory, "notion-endpoints.json"), "utf8"),
    );
    expect(
      recorded.endpoints.find(
        (row) => row.method === target.method && row.path === target.path,
      )!.deprecated,
    ).toBe(true);

    // A deprecation a maintainer has read and recorded is not news again.
    const quiet = run(directory, ["notion"], ["--json"]);
    expect(quiet.status).toBe(0);
    expect(findings(quiet.output, "notion")).toEqual([]);

    delete operationOf().deprecated;
    await writeFile(
      join(directory, "notion-spec.json"),
      JSON.stringify(specification),
    );
    const reversed = run(directory, ["notion"], ["--json"]);
    expect(reversed.status).toBe(1);
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
  ])(
    "refuses %s narrowed to %s, which %s checks",
    async (half, provider, other) => {
      const result = spawnSync(
        process.execPath,
        [checker, half, "--provider", provider],
        { encoding: "utf8" },
      );
      // Silently checking nothing and exiting 0 is the wrong failure mode for a
      // command whose whole value is its exit code.
      expect(result.status).toBe(2);
      const output = `${result.stdout}${result.stderr}`;
      expect(output).toContain(`${provider} is `);
      expect(output).toContain(other);
      expect(output).toContain("which this run did not select");
    },
  );

  it("checks Vercel's public MCP inventory while naming live schema ownership", async () => {
    const { toolReference, setupReference } =
      await documentedVercelWorkspace();
    const clean = runDocumented("vercel", toolReference, setupReference);
    expect(clean.status).toBe(0);
    const cleanReport = JSON.parse(clean.output).docs[0];
    expect(cleanReport).toMatchObject({
      provider: "vercel",
      documentedTools: 32,
      added: [],
      removed: [],
      findings: [],
      schemaAuthority: "live-tools-list",
      schemasVendored: false,
    });

    await writeFile(
      toolReference,
      `${await readFile(toolReference, "utf8")}\n### new\\_vercel\\_tool\n`,
    );
    const drifted = runDocumented("vercel", toolReference, setupReference);
    expect(drifted.status).toBe(1);
    expect(JSON.parse(drifted.output).docs[0].added).toEqual([
      "new_vercel_tool",
    ]);
  });

  it("reads table inventories and treats documented additions as findings", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connecta-drift-table-"));
    temporary.push(directory);
    const reference = join(directory, "stripe.md");
    const rows = [...STRIPE_VETTED_CATALOG.tools.keys()]
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

    await writeFile(
      reference,
      `${await readFile(reference, "utf8")}\n| Other | \`new_stripe_tool\` | New |\n`,
    );
    // The row landed after the configured section boundary, so move the
    // boundary too. This proves the parser checks the named section only.
    expect(runDocumented("stripe", reference, reference).status).toBe(0);
    const content = await readFile(reference, "utf8");
    await writeFile(
      reference,
      content.replace(
        "### Supported API methods",
        "| Other | `new_stripe_tool` | New |\n\n### Supported API methods",
      ),
    );
    const drifted = runDocumented("stripe", reference, reference);
    expect(drifted.status).toBe(1);
    expect(JSON.parse(drifted.output).docs[0].added).toContain(
      "new_stripe_tool",
    );
  });

  it("reads inline names from Cloudflare and Notion's official doc shapes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connecta-drift-inline-"));
    temporary.push(directory);

    const cloudflare = join(directory, "cloudflare.md");
    await writeFile(
      cloudflare,
      `# Cloudflare MCP\n\nOAuth\n\n## Cloudflare API MCP server\n\nTwo tools: \`search()\` and \`execute()\`.\n\n### Connect to the Cloudflare API MCP server\n\n${CLOUDFLARE_MCP_ENDPOINT}\n`,
    );
    const cloudflareResult = runDocumented(
      "cloudflare",
      cloudflare,
      cloudflare,
    );
    expect(cloudflareResult.status).toBe(0);
    expect(JSON.parse(cloudflareResult.output).docs[0]).toMatchObject({
      documentedTools: CLOUDFLARE_MCP_VETTED_CATALOG.tools.size,
      added: [],
      findings: [],
    });

    const notionTools = join(directory, "notion-tools.md");
    const notionSetup = join(directory, "notion-setup.md");
    await writeFile(
      notionTools,
      [...NOTION_MCP_VETTED_CATALOG.tools.keys()]
        .sort()
        .map((name) => `\`${name}\``)
        .join("\n\n"),
    );
    await writeFile(
      notionSetup,
      `# Notion MCP\n\n${NOTION_MCP_ENDPOINT}\n\nOAuth setup.\n`,
    );
    const notionResult = runDocumented("notion", notionTools, notionSetup);
    expect(notionResult.status).toBe(0);
    expect(JSON.parse(notionResult.output).docs[0]).toMatchObject({
      documentedTools: NOTION_MCP_VETTED_CATALOG.tools.size,
      added: [],
      findings: [],
    });
  });

  it("checks endpoint and OAuth docs when a provider publishes no tool inventory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connecta-drift-setup-"));
    temporary.push(directory);
    const setup = join(directory, "linear.md");
    await writeFile(
      setup,
      `# Linear MCP\n\n${LINEAR_MCP_ENDPOINTS["read-write"]}\n\nOAuth setup.\n`,
    );
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
            [tsx, checker, "--docs", "--provider", "basecamp", "--setup-reference", `basecamp=${setup}`, "--json"],
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
      expect(drifted.status).toBe(1);
      expect(
        JSON.parse(drifted.output).docs[0].findings.map(
          (finding: { kind: string }) => finding.kind,
        ),
      ).toEqual(["mcp-endpoint", "mcp-auth"]);
    } finally {
      await new Promise((resolve) => http.close(resolve));
    }
  });

  it("commits one well-formed row per touched endpoint", async () => {
    for (const provider of ["cloudflare", "notion", "ccb"]) {
      const manifest = await committed(provider);
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
    const rows = (await committed("cloudflare")).endpoints.map(
      (endpoint) => `${endpoint.method} ${endpoint.path}`,
    );
    expect(rows).not.toContain("GET /zones/{zone_id}/settings");
    expect(rows).toContain("GET /zones/{zone_id}/settings/{setting_id}");
    expect(rows).toContain("PATCH /zones/{zone_id}/settings/{setting_id}");
  });
});

interface VersionedManifest {
  provider: string;
  specifications: Record<
    string,
    { version: string; url: string; documentation: string; latestPublished?: string }
  >;
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
    await readFile(join(manifestDirectory, "planning-center-endpoints.json"), "utf8"),
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
  await writeFile(
    join(directory, "planning-center-endpoints.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
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

describe("Planning Center's per-product drift check", () => {
  it("records every product, then reports a contract change and a new version as transitions", async () => {
    const { directory, manifest, specification, documentation } = await planningCenterWorkspace();
    const recorded = runPlanningCenter(directory, ["--record"]);
    expect(recorded.status, recorded.output).toBe(0);
    const after = JSON.parse(
      await readFile(join(directory, "planning-center-endpoints.json"), "utf8"),
    ) as VersionedManifest;
    for (const endpoint of after.endpoints) {
      expect(endpoint.contract).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
    // A beta is not a publication a pin can move to.
    expect(after.specifications["people"]!.latestPublished).toBe(
      manifest.specifications["people"]!.version,
    );
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
    expect(drifted.status).toBe(1);
    expect(findings(drifted.output, "planning-center")).toEqual([
      expect.objectContaining({ app: "groups", kind: "version-published" }),
      expect.objectContaining({ kind: "contract-changed", method: touched.method, path: touched.path }),
    ]);

    // Reviewed and recorded, neither is news again.
    expect(runPlanningCenter(directory, ["--record"]).status).toBe(1);
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
    expect(result.status).toBe(1);
    const kinds = findings(result.output, "planning-center").map(
      (finding: any) => `${finding.app} ${finding.kind}`,
    );
    expect(kinds).toEqual(
      expect.arrayContaining([
        "webhooks version-gone",
        "webhooks version-published",
        "giving version-mismatch",
      ]),
    );
  });

  it("takes a per-product specification override and refuses a provider-wide one", async () => {
    const { directory, specification } = await planningCenterWorkspace();
    expect(runPlanningCenter(directory, ["--record"]).status).toBe(0);
    const calendar = JSON.parse(await readFile(specification("calendar"), "utf8"));
    delete calendar.paths["/event_instances"];
    const override = join(directory, "calendar-override.json");
    await writeFile(override, JSON.stringify(calendar));
    const overridden = runPlanningCenter(directory, [
      "--spec",
      `planning-center/calendar=${override}`,
    ]);
    expect(overridden.status).toBe(1);
    expect(findings(overridden.output, "planning-center")).toEqual([
      expect.objectContaining({ kind: "path-gone", path: "/calendar/v2/event_instances" }),
    ]);
    const refused = runPlanningCenter(directory, ["--spec", `planning-center=${override}`]);
    expect(refused.status).toBe(2);
    expect(refused.output).toContain("one specification per product");
  });

  it("pins the manifest to the provider's versions and covers exactly what the named tools call", async () => {
    const { PLANNING_CENTER_API_VERSIONS, planningCenter } = await import(
      "../src/providers/planning-center.js"
    );
    const { memoryStorage } = await import("../src/storage/memory.js");
    const { silentLogger } = await import("./helpers.js");
    const manifest = JSON.parse(
      await readFile(join(manifestDirectory, "planning-center-endpoints.json"), "utf8"),
    ) as VersionedManifest;
    expect(
      Object.fromEntries(
        Object.entries(manifest.specifications).map(([app, entry]) => [app, entry.version]),
      ),
    ).toEqual(PLANNING_CENTER_API_VERSIONS);
    for (const [app, entry] of Object.entries(manifest.specifications)) {
      expect(entry.url).toBe(
        `https://api.planningcenteronline.com/${app}/v2/open_api/${entry.version}`,
      );
      expect(entry.documentation).toBe(
        `https://api.planningcenteronline.com/${app}/v2/documentation`,
      );
    }

    // Call every named tool with its smallest valid arguments and require
    // each request to be a reviewed row: a tool that starts calling a new
    // endpoint fails here, not in a release that never checked it.
    const sent = new Set<string>();
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
      sent.add(`${init.method ?? "GET"} ${new URL(String(input)).pathname}`);
      return new Response(
        JSON.stringify({ data: { type: "Thing", id: "1", attributes: {} } }),
        { status: 200 },
      );
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
    expect(
      [...sent].filter((request) => !manifest.endpoints.some((endpoint) => matches(request, endpoint))),
    ).toEqual([]);
    expect(
      manifest.endpoints
        .filter((endpoint) => ![...sent].some((request) => matches(request, endpoint)))
        .map((endpoint) => `${endpoint.method} ${endpoint.path}`),
    ).toEqual([]);
  });
});
