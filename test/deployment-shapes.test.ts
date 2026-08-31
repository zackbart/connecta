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

  it("keeps the Worker sandbox loader-only", () => {
    const source = readFileSync(
      join(ROOT, "examples", "worker", "src", "index.ts"),
      "utf8",
    );
    const options = [...source.matchAll(
      /new DynamicWorkerExecutor\(\{([^}]*)\}\)/g,
    )].map((match) => match[1]?.trim());
    expect(options).toEqual(["loader: env.LOADER"]);
  });

  it("pins hosted MCP callbacks in the Worker deployment instructions", () => {
    const worker = join(ROOT, "examples", "worker");
    const agents = readFileSync(join(worker, "AGENTS.md"), "utf8");
    const readme = readFileSync(join(worker, "README.md"), "utf8");
    const source = readFileSync(join(worker, "src", "index.ts"), "utf8");
    const callbacks = [
      "https://claude.ai/api/mcp/auth_callback",
      "https://chatgpt.com/connector_platform_oauth_redirect",
      "https://chatgpt.com/connector/oauth/*",
    ];
    for (const callback of callbacks) {
      expect(agents).toContain(callback);
      expect(readme).toContain(callback);
      expect(source).toContain(callback);
    }
    expect(agents).toContain(
      "oauth_configuration.dynamic_client_registration.allowed_uris",
    );
    expect(readme).toContain(
      '"dynamic_client_registration": {',
    );
    expect(readme).toContain('"allowed_uris": [');
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
    const manifest = JSON.parse(read("package.json"));
    expect(dockerfile).toContain("src/index.ts");
    expect(manifest.scripts.start).toBe("tsx src/index.ts");
    expect(manifest.allowScripts).toEqual({ "esbuild@0.28.2": true });
    expect(read("README.md")).toContain(
      "do not replace the pinned entry with a broad\npackage-name approval",
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

  // Both shapes carry the whole operator feature set — sign-in, vault, access
  // tokens, activity — either wired or one uncommented block away (#345). A
  // shape that quietly drops one is a deployment whose operator pages exist
  // for things it cannot do.
  it("offers the full operator surface in the Node template", () => {
    const source = read("src", "index.ts");
    for (const fragment of [
      '// import { clerkAuth } from "@zackbart/connecta/auth/clerk";',
      '// import { fileActivityStore } from "./file-activity.js";',
      "// clerkAuth({",
      "// credentials: { encryptionKey: process.env.CONNECTA_CREDENTIAL_KEY },",
      "// accessTokens: {},",
      "// activity: {",
    ]) {
      expect(source).toContain(fragment);
    }
    // The activity store itself is compiled, not commented: check:examples
    // typechecks it, so the only thing an operator uncomments is the wiring.
    expect(read("src", "file-activity.ts")).toContain(
      "export function fileActivityStore(",
    );
    const env = read(".env.example");
    for (const variable of [
      "CLERK_PUBLISHABLE_KEY",
      "CLERK_SECRET_KEY",
      "CONNECTA_CREDENTIAL_KEY",
      "CONNECTA_ACTIVITY_FILE",
    ]) {
      expect(env).toContain(variable);
      // Compose passes every one through, or uncommenting a block would work
      // from source and silently do nothing in the container.
      expect(read("docker-compose.yml")).toContain(variable);
    }
    // Activity history belongs on the volume beside the state file.
    expect(read("Dockerfile")).toContain(
      "ENV CONNECTA_ACTIVITY_FILE=/data/connecta-activity.jsonl",
    );
    expect(read(".gitignore")).toContain(".connecta-activity.jsonl");
    expect(read("README.md")).toContain("## Turn on the operator surface");
    // A vault is not a page: /credentials lists connector slots, and neither
    // shape's shipped connectors need one. Both carry the slot's shape in
    // place so nobody follows the vault step and finds a hidden page (#345).
    expect(source).toContain('//   credential: { label: "API token" },');
    expect(read("README.md")).toContain(
      "The shipped `time`\nconnector declares none",
    );
  });

  it("offers the full operator surface in the Worker example", () => {
    const worker = readFileSync(
      join(ROOT, "examples", "worker", "src", "index.ts"),
      "utf8",
    );
    expect(worker).toContain("cloudflareAccessAuth()");
    expect(worker).not.toContain("clerkAuth");
    expect(worker).toContain("// identity: {");
    expect(worker).toContain('// Use `authScope: "personal"`');
    expect(worker).toContain(
      "credentials: { encryptionKey: env.CREDENTIAL_ENCRYPTION_KEY },",
    );
    expect(worker).toContain("accessTokens: {},");
    expect(worker).toContain("// activity: {");
    expect(worker).toContain('// import { d1ActivityStore } from "./d1-activity.js";');
    // The commented binding is what makes the commented wiring resolvable.
    expect(
      readFileSync(join(ROOT, "examples", "worker", "wrangler.jsonc"), "utf8"),
    ).toContain('//     "binding": "ACTIVITY_DB",');
    expect(worker).toContain('//   credential: { label: "API token" },');
    const workerReadme = readFileSync(
      join(ROOT, "examples", "worker", "README.md"),
      "utf8",
    );
    expect(workerReadme).toContain("## The operator surface");
    // The walkthrough may not end on a check that fails as deployed: this
    // example has no credential slot and its activity store waits on D1.
    expect(workerReadme).toContain(
      "The vault is ready here, and the Credentials page is still hidden",
    );
    expect(workerReadme).not.toContain(
      "checking that Credentials, Tokens, and Activity are live",
    );
  });

  // Compose's `:?` guard fires on unset-or-empty, so any placeholder value
  // shipped in .env.example is a bearer token published in this repository
  // that `docker compose up` will happily accept (#367).
  it("ships a Node template that cannot start on its own .env.example", () => {
    const env = read(".env.example");
    expect(env).toMatch(/^CONNECTA_TOKEN=\s*$/m);
    expect(read("docker-compose.yml")).toContain(
      "CONNECTA_TOKEN: ${CONNECTA_TOKEN:?",
    );
    // Local `npm start` reads the same file and refuses for the same reason.
    expect(read("src", "index.ts")).toContain(
      "Refusing to start without inbound auth",
    );
  });

  // A copied deployment installs its own dependencies, and an optional peer
  // that never installs with connecta breaks the build if the README that
  // calls this example a starting template does not name it (#367).
  it("names every optional peer the Worker example imports", () => {
    const worker = join(ROOT, "examples", "worker");
    const source = readFileSync(join(worker, "src", "index.ts"), "utf8");
    const readme = readFileSync(join(worker, "README.md"), "utf8");
    const peers: Record<string, string> = {
      "@zackbart/connecta/auth/clerk": "@clerk/backend",
      "@cloudflare/codemode": "@cloudflare/codemode",
    };
    for (const [specifier, packageName] of Object.entries(peers)) {
      if (!source.includes(`from "${specifier}"`)) continue;
      expect(readme).toMatch(
        new RegExp(`npm install[^\\n]*${packageName.replace("/", "\\/")}`),
      );
    }
  });

  it("keeps the initializer's .gitignore in step with the template's", () => {
    // `connecta init` writes this file itself, because npm strips .gitignore
    // from a packed dependency. Two copies drift; this is the seam.
    const written = readFileSync(join(ROOT, "bin", "connecta.mjs"), "utf8");
    for (const entry of read(".gitignore").split("\n").filter(Boolean)) {
      expect(written).toContain(entry);
    }
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
