import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// There are two deployment shapes: the Node template `connecta init` copies —
// Docker-ready, not Docker-only — and the Cloudflare Worker example. Three
// near-identical Node scaffolds were the shape #344 deleted, and a new one
// arrives as a copy of an existing one, so the guard is a layout assertion.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = join(ROOT, "templates", "node");

const read = (...segments: string[]) =>
  readFileSync(join(TEMPLATE, ...segments), "utf8");

describe("deployment shapes", () => {
  it("keeps the Worker as the only example", () => {
    expect(readdirSync(join(ROOT, "examples")).sort()).toEqual(["worker"]);
  });

  it("ships one Node deployment that is also its own container", () => {
    expect(readdirSync(TEMPLATE).sort()).toEqual([
      ".dockerignore",
      ".env.example",
      ".gitignore",
      "AGENTS.md",
      "CLAUDE.md",
      "Dockerfile",
      "README.md",
      "docker-compose.yml",
      "package.json",
      "src",
      "tsconfig.json",
    ]);
    // The container builds this deployment, never the Connecta repository:
    // its build context is the generated project itself.
    expect(read("docker-compose.yml")).toContain("build: .");
    expect(read("Dockerfile")).not.toContain("npm run build");
  });

  it("runs the same source locally and in the container", () => {
    const dockerfile = read("Dockerfile");
    expect(dockerfile).toContain("src/index.ts");
    expect(JSON.parse(read("package.json")).scripts.start).toBe(
      "tsx src/index.ts",
    );
    // No lockfile ships with the template — init rewrites the version pin, so
    // a committed lockfile would disagree with it on the first build.
    expect(readdirSync(TEMPLATE)).not.toContain("package-lock.json");
    expect(dockerfile).toContain("npm ci");
    expect(dockerfile).toContain("npm install");
  });

  it("configures the container's origin, state, and health from the source", () => {
    const source = read("src", "index.ts");
    expect(source).toContain("process.env.PUBLIC_URL");
    expect(source).toContain("process.env.CONNECTA_STATE_FILE");
    expect(read("Dockerfile")).toContain("HEALTHCHECK");
    // State belongs on the mounted volume, owned by the non-root user.
    expect(read("Dockerfile")).toContain("chown -R node:node /data");
    expect(read("docker-compose.yml")).toContain("connecta-state:/data");
  });

  it("packs the container files with the template", () => {
    const manifest = JSON.parse(
      readFileSync(join(ROOT, "package.json"), "utf8"),
    ) as { files: string[] };
    const files = manifest.files;
    expect(files).toContain("templates");
    expect(files).not.toContain("examples/node");
    expect(files).not.toContain("examples/docker");
  });
});
