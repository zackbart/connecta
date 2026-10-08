// Node-only: spawns the Bash CI path filters and aggregate gate.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function pathFilter(script: string) {
  const filter = fileURLToPath(new URL(`../scripts/${script}`, import.meta.url));
  return (paths: string[]): string => {
    const result = spawnSync("bash", [filter], {
      input: paths.map((path) => `${path}\0`).join(""),
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
}
const browserRequired = pathFilter("ci-browser-paths.sh");
const securityRequired = pathFilter("ci-security-paths.sh");

describe("CI browser paths", () => {
  it.each([
    "src/branding.ts",
    "src/favicon.ts",
    "src/routes/operator.ts",
    "src/routes/shared.ts",
    "src/server.ts",
    "src/routes/credentials.ts",
    "src/routes/oauth-management.ts",
    "src/access-tokens.ts",
    "test/helpers.ts",
    "test/fixtures/http.ts",
    "src/operator-ui/app/index.tsx",
    "test/browser/operator-ui.spec.ts",
    ".github/workflows/ci.yml",
    ".github/workflows/publish.yml",
    "package.json",
    "package-lock.json",
    "playwright.config.ts",
    "vitest.config.ts",
    "tsconfig.json",
    "scripts/new-script.mjs",
    "test/new-suite.test.ts",
    "src/new-module.ts",
    "templates/node/src/server.ts",
    "documentation-extra/code.ts",
    "src/providers-extra/code.ts",
    "src/odd\nfile.ts",
  ])("runs browsers for %s", (path) => {
    expect(browserRequired([path])).toBe("true");
  });

  it.each([
    "src/providers/notion/index.ts",
    "src/providers/_shared/google/workspace.ts",
    "test/providers/new-provider.test.ts",
    "test/notion-provider.test.ts",
    "test/notion-provider.node.test.ts",
    "test/provider-conventions.test.ts",
    "test/provider-conventions.node.test.ts",
    "test/provider-registry.test.ts",
    "test/provider-registry.node.test.ts",
    "test/google-workspace-delegation.test.ts",
    "test/google-workspace-delegation.node.test.ts",
    "scripts/drift/docs-endpoints.json",
    "scripts/drift-check.mjs",
    "documentation/architecture.md",
    "decisions/record.json",
    "spec/nested/contract.json",
    "README.md",
    "CHANGELOG.md",
    "src/nested/README.md",
    ".changes/release.json",
    "eval/run-agent.ts",
  ])("skips browsers for %s", (path) => {
    expect(browserRequired([path])).toBe("false");
  });

  it("requires every path to be safe, regardless of order", () => {
    expect(browserRequired(["README.md", "src/providers/notion/index.ts"])).toBe("false");
    expect(browserRequired(["README.md", "src/server.ts"])).toBe("true");
    expect(browserRequired(["src/server.ts", "README.md"])).toBe("true");
  });

  it("runs browsers for either side of a rename crossing the safe set", () => {
    // --no-renames reports both the deleted path and the added path.
    expect(browserRequired(["src/server.ts", "documentation/server.md"])).toBe("true");
    expect(browserRequired(["documentation/server.md", "src/server.ts"])).toBe("true");
  });
});

describe("CI security paths", () => {
  const inputs = ["package.json", "package-lock.json", "npm-shrinkwrap.json", ".npmrc"];
  const directories = ["", "templates/node/", "examples/worker/", "packages/workspace/", "packages/nested/workspace/"];
  it.each(directories.flatMap((directory) => inputs.map((input) => `${directory}${input}`)))("audits dependencies when %s changes", (path) => {
    expect(securityRequired([path])).toBe("true");
    expect(securityRequired(["src/server.ts", path])).toBe("true");
  });

  it.each([
    "src/server.ts",
    ".github/workflows/security.yml",
    "package.json.md",
    "nested/package.json.md",
    "nested/.npmrc.md",
  ])("leaves %s to the nightly audit", (path) => {
    expect(securityRequired([path])).toBe("false");
  });
});

describe("CI aggregate check", () => {
  // Exercise the actual workflow step, so its condition cannot drift from the test.
  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const step = workflow.match(/- name: Require all checks to pass\n[\s\S]*?        run: \|\n((?:          .*\n)+)/)?.[1];
  if (!step) throw new Error("CI aggregate check step is missing");
  const script = step.replace(/^          /gm, "");

  // Browser cases run with security skipped as unneeded, the common pull request.
  it.each([
    ["success", "success", "success", "true", "skipped", "false", 0],
    ["success", "success", "skipped", "false", "skipped", "false", 0],
    ["failure", "success", "success", "true", "skipped", "false", 1],
    ["cancelled", "success", "success", "true", "skipped", "false", 1],
    ["skipped", "success", "success", "true", "skipped", "false", 1],
    ["success", "failure", "skipped", "", "skipped", "", 1],
    ["success", "cancelled", "skipped", "", "skipped", "", 1],
    ["success", "skipped", "skipped", "", "skipped", "", 1],
    ["success", "success", "failure", "true", "skipped", "false", 1],
    ["success", "success", "cancelled", "true", "skipped", "false", 1],
    ["success", "success", "skipped", "true", "skipped", "false", 1],
    ["success", "success", "skipped", "", "skipped", "false", 1],
    ["success", "success", "success", "true", "success", "true", 0],
    ["success", "success", "success", "true", "failure", "true", 1],
    ["success", "success", "success", "true", "cancelled", "true", 1],
    ["success", "success", "success", "true", "skipped", "true", 1],
    ["success", "success", "success", "true", "skipped", "", 1],
    ["success", "success", "success", "true", "failure", "false", 1],
  ])("handles core=%s changes=%s browser=%s required=%s security=%s required=%s", (core, changes, browser, required, security, securityNeeded, status) => {
    const result = spawnSync("bash", ["-e", "-c", script], {
      env: {
        ...process.env,
        CORE_RESULT: core,
        CHANGES_RESULT: changes,
        BROWSER_RESULT: browser,
        BROWSER_REQUIRED: required,
        SECURITY_RESULT: security,
        SECURITY_REQUIRED: securityNeeded,
      },
      encoding: "utf8",
    });
    expect(result.status, result.stdout + result.stderr).toBe(status);
  });
});
