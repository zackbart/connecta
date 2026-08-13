import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const checker = fileURLToPath(
  new URL("../scripts/drift-check.mjs", import.meta.url),
);
const manifestDirectory = fileURLToPath(new URL("../scripts/drift", import.meta.url));
const temporary: string[] = [];

interface Endpoint {
  method: string;
  path: string;
  specRevision: string;
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
  environment: Record<string, string | undefined> = {},
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
    {
      encoding: "utf8",
      env: {
        ...process.env,
        CONNECTA_DRIFT_LINEAR_KEY: undefined,
        CONNECTA_DRIFT_STRIPE_KEY: undefined,
        CONNECTA_DRIFT_MIXPANEL_KEY: undefined,
        ...environment,
      } as NodeJS.ProcessEnv,
    },
  );
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

function findings(output: string, provider: string): Finding[] {
  const report = JSON.parse(output);
  return report.specs.find((entry: any) => entry.provider === provider).findings;
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

  it.each(["cloudflare", "notion"])(
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

  it("fails clearly when no local hosted credential is exported", async () => {
    const result = spawnSync(process.execPath, [checker, "--hosted"], {
      encoding: "utf8",
      env: {
        ...process.env,
        CONNECTA_DRIFT_LINEAR_KEY: undefined,
        CONNECTA_DRIFT_STRIPE_KEY: undefined,
        CONNECTA_DRIFT_MIXPANEL_KEY: undefined,
      } as NodeJS.ProcessEnv,
    });
    expect(result.status).toBe(2);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "no hosted credentials are set",
    );
  });

  it("commits one well-formed row per touched endpoint", async () => {
    for (const provider of ["cloudflare", "notion"]) {
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
});
