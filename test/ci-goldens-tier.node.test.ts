// Node-only: exercises the CI selector's filesystem/import graph and subprocess stdin contract.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalGolden } from "./goldens/tier.js";

const selector = new URL("../scripts/ci-goldens-tier.mjs", import.meta.url);
const { selectGoldensTier, selectGoldensFastTier } = (await import(selector.href)) as {
  selectGoldensFastTier(paths: string[], options?: { repository?: string }): string;
  selectGoldensTier(
    paths: string[],
    options?: { repository?: string; dependencies?: () => Promise<Set<string>> },
  ): Promise<string>;
};
const cli = (input: string) => spawnSync(process.execPath, [fileURLToPath(selector)], { input, encoding: "utf8" });

// These scan real TypeScript graphs and spawn Node processes; the budget is a
// hang guard, not a performance assertion, including on a loaded shared host.
describe("CI goldens tier", { timeout: 30_000 }, () => {
  it.each([
    "src/providers/notion/index.ts",
    "src/providers/_shared/rest/tools.ts",
    "src/providers/new-kit/migration.ts",
    "src/connectors/api.ts",
    "src/http/new.ts",
    "src/invocation.ts",
    "src/registry.ts",
    "src/credentials.ts",
    "src/sent-secrets.ts",
    "src/storage/keys.ts",
    "src/tool-safety.ts",
    "src/runtime/call.ts",
    "test/goldens/notion/spec.ts",
    "test/goldens/notion/calls.json",
    "test/goldens-harness.test.ts",
    "test/goldens.test.ts",
    "test/fixtures/provider.json",
    "test/providers/provider.ts",
    "src/providers/notion/fixtures/calls.json",
    "vitest.config.ts",
    "vitest.config.node.ts",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "scripts/ci-goldens-tier.mjs",
    "scripts/golden-source-boundary.mjs",
    ".github/workflows/ci.yml",
  ])("runs full for relevant path %s", async (path) => {
    expect(await selectGoldensTier([path])).toBe("full");
  });

  it("classifies without dependencies and defers only existing source/test modules to the graph", async () => {
    const repository = mkdtempSync(join(tmpdir(), "connecta-goldens-fast-"));
    try {
      mkdirSync(join(repository, "src"));
      mkdirSync(join(repository, "scripts"));
      writeFileSync(join(repository, "src/server.ts"), "export {};");
      copyFileSync(fileURLToPath(selector), join(repository, "scripts/selector.mjs"));
      for (const [input, expected] of [
        ["README.md\0", "always"],
        ["decisions/new.md\0.changes/new.md\0", "always"],
        ["src/providers/probe/index.ts\0src/server.ts\0", "full"],
        ["unknown/config\0src/server.ts\0", "full"],
        ["src/missing.ts\0", "full"],
        ["src/server.ts\0", "graph"],
        ["README.md", "full"],
        ["", "full"],
      ]) {
        const result = spawnSync(process.execPath, ["scripts/selector.mjs", "--fast"], {
          cwd: repository,
          input,
          encoding: "utf8",
        });
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout.trim()).toBe(expected);
      }
      expect(selectGoldensFastTier(["src/server.ts"], { repository })).toBe("graph");
      for (const member of [true, false]) {
        let calls = 0;
        expect(
          await selectGoldensTier(["src/server.ts"], {
            repository,
            dependencies: async () => {
              calls++;
              return new Set(member ? ["src/server.ts"] : []);
            },
          }),
        ).toBe(member ? "full" : "always");
        expect(calls).toBe(1);
      }
      expect(
        await selectGoldensTier(["README.md"], {
          dependencies: async () => {
            throw new Error("fast path must not read the graph");
          },
        }),
      ).toBe("always");
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it("runs the workflow first pass for docs, providers, main, graph candidates, deletions and renames", () => {
    const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
    const body = workflow
      .match(
        /- name: Decide which test, browser and dependency checks are needed[\s\S]*?        run: \|\n((?:          .*\n)+)/,
      )![1]!
      .replace(/^          /gm, "");
    const repository = mkdtempSync(join(tmpdir(), "connecta-goldens-workflow-paths-"));
    const git = (...args: string[]) => {
      const result = spawnSync("git", args, {
        cwd: repository,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "CI test",
          GIT_AUTHOR_EMAIL: "ci@example.com",
          GIT_COMMITTER_NAME: "CI test",
          GIT_COMMITTER_EMAIL: "ci@example.com",
        },
      });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    try {
      mkdirSync(join(repository, "scripts"));
      mkdirSync(join(repository, "src/providers/probe"), { recursive: true });
      for (const name of ["ci-goldens-tier.mjs", "ci-planning-paths.sh", "ci-browser-paths.sh", "ci-security-paths.sh"])
        copyFileSync(new URL(`../scripts/${name}`, import.meta.url), join(repository, "scripts", name));
      writeFileSync(join(repository, "README.md"), "base");
      writeFileSync(join(repository, "src/server.ts"), "export {};");
      git("init", "--quiet");
      git("add", ".");
      git("commit", "--quiet", "-m", "base");
      const base = git("rev-parse", "HEAD");
      for (const [kind, expected] of [
        ["docs", "always"],
        ["provider", "full"],
        ["main", "full"],
        ["graph", "graph"],
        ["delete", "full"],
        ["rename", "full"],
      ]) {
        git("reset", "--hard", base);
        if (kind === "delete" || kind === "rename") rmSync(join(repository, "README.md"));
        if (kind === "rename") writeFileSync(join(repository, "RENAMED.md"), "base");
        if (kind === "docs" || kind === "main") writeFileSync(join(repository, "README.md"), "changed");
        if (kind === "provider") writeFileSync(join(repository, "src/providers/probe/index.ts"), "export {};");
        if (kind === "graph") writeFileSync(join(repository, "src/server.ts"), "export const changed = true;");
        git("add", "-A");
        git("commit", "--quiet", "-m", kind!);
        const output = join(repository, "output");
        const result = spawnSync("bash", ["-e", "-c", body], {
          cwd: repository,
          encoding: "utf8",
          env: {
            ...process.env,
            EVENT_NAME: kind === "main" ? "push" : "pull_request",
            BASE_SHA: base,
            HEAD_SHA: git("rev-parse", "HEAD"),
            RUNNER_TEMP: join(repository, ".git"),
            GITHUB_OUTPUT: output,
          },
        });
        expect(result.status, result.stderr).toBe(0);
        expect(readFileSync(output, "utf8"), kind).toContain(`goldens=${expected}\n`);
        rmSync(output);
      }
      const changes = workflow.split("\n  changes:\n")[1]!.split("\n  static:\n")[0]!;
      expect(changes.match(/if: steps.paths.outputs.goldens == 'graph'/g)).toHaveLength(3);
      expect(changes.indexOf("id: paths")).toBeLessThan(changes.indexOf("uses: pnpm/action-setup"));
      expect(changes).toContain("goldens: ${{ steps.goldens.outputs.goldens }}");
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it("publishes only full/always after graph fallback, including invalid or failed graph output", () => {
    const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
    const body = workflow
      .match(/- name: Resolve provider goldens tier[\s\S]*?        run: \|\n((?:          .*\n)+)/)![1]!
      .replace(/^          /gm, "");
    const temporary = mkdtempSync(join(tmpdir(), "connecta-goldens-resolve-"));
    try {
      writeFileSync(join(temporary, "paths"), "src/server.ts\0");
      for (const [first, answer, status, expected] of [
        ["always", "invalid", "1", "always"],
        ["full", "always", "0", "full"],
        ["unexpected", "always", "0", "full"],
        ["graph", "always", "0", "always"],
        ["graph", "full", "0", "full"],
        ["graph", "graph", "0", "full"],
        ["graph", "always", "1", "full"],
      ]) {
        const output = join(temporary, "output");
        const result = spawnSync("bash", ["-e", "-c", 'node() { echo "$ANSWER"; return "$STATUS"; };\n' + body], {
          encoding: "utf8",
          env: {
            ...process.env,
            FIRST_PASS: first,
            ANSWER: answer,
            STATUS: status,
            RUNNER_TEMP: temporary,
            GITHUB_OUTPUT: output,
          },
        });
        expect(result.status, result.stderr).toBe(0);
        expect(readFileSync(output, "utf8")).toBe(`goldens=${expected}\n`);
        rmSync(output);
      }
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("derives transitive core dependencies instead of a fixed core filename list", async () => {
    expect(await selectGoldensTier(["src/types.ts"])).toBe("full");
    expect(await selectGoldensTier(["src/server.ts"], { dependencies: async () => new Set(["src/server.ts"]) })).toBe(
      "full",
    );
    expect(await selectGoldensTier(["src/server.ts"])).toBe("always");
  });

  it.each([
    ["README.md"],
    ["documentation/architecture.md", ".changes/change.md"],
    ["AGENTS.md"],
    ["decisions/0011.md"],
  ])("uses always for docs-only %j", async (...paths) => expect(await selectGoldensTier(paths)).toBe("always"));

  it.each([[], ["unknown/input"], ["src/future.ts"], ["../README.md"], ["/README.md"], ["src//server.ts"], [""]])(
    "fails toward full for unknown/invalid paths %j",
    async (...paths) => expect(await selectGoldensTier(paths)).toBe("full"),
  );

  it("fails toward full when graph discovery or dependency classification fails", async () => {
    expect(await selectGoldensTier(["src/server.ts"], { repository: "/nonexistent/connecta-selector" })).toBe("full");
    expect(
      await selectGoldensTier(["src/server.ts"], {
        dependencies: async () => {
          throw new Error("unknown dependency");
        },
      }),
    ).toBe("full");
  });

  it("selects full on unresolved, computed, unknown external or malformed graph imports", async () => {
    const repository = mkdtempSync(join(tmpdir(), "connecta-goldens-selector-"));
    try {
      for (const directory of ["src/providers/probe", "test/goldens"])
        mkdirSync(join(repository, directory), { recursive: true });
      writeFileSync(join(repository, "package.json"), "{}");
      writeFileSync(join(repository, "test/goldens/harness.ts"), "export {};");
      writeFileSync(join(repository, "test/goldens/setup.ts"), "export {};");
      writeFileSync(join(repository, "src/server.ts"), "export {};");
      for (const source of [
        'import "./missing.js";',
        "export const lazy = (name: string) => import(name);",
        'import "unknown-package";',
        "export const broken = {;",
        'const specs = import.meta.glob("./unknown/*.ts");',
      ]) {
        writeFileSync(join(repository, "src/providers/probe/index.ts"), source);
        expect(await selectGoldensTier(["src/server.ts"], { repository }), source).toBe("full");
      }
      // The same otherwise-unrelated file is safe once its graph is known.
      writeFileSync(join(repository, "src/providers/probe/index.ts"), "export {};");
      expect(await selectGoldensTier(["src/server.ts"], { repository })).toBe("always");
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it("reads NUL-delimited paths, handles both sides of renames and fails full on malformed input", () => {
    for (const [input, expected] of [
      ["README.md\0", "always"],
      ["README.md\0src/invocation.ts\0", "full"],
      ["src/invocation.ts\0README.md\0", "full"],
      ["", "full"],
      ["README.md", "full"],
    ]) {
      const result = cli(input!);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe(expected);
    }
  });

  it.each(["push", "pull_request"])("runs full when the workflow sees %s with no usable diff", (event) => {
    const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
    const body = workflow.match(
      /- name: Decide which test, browser and dependency checks are needed[\s\S]*?        run: \|\n((?:          .*\n)+)/,
    )?.[1];
    expect(body).toBeDefined();
    const temporary = mkdtempSync(join(tmpdir(), "connecta-goldens-workflow-"));
    try {
      const output = join(temporary, "output");
      const result = spawnSync("bash", ["-e", "-c", body!.replace(/^          /gm, "")], {
        env: {
          ...process.env,
          EVENT_NAME: event,
          BASE_SHA: "invalid-base",
          HEAD_SHA: "invalid-head",
          RUNNER_TEMP: temporary,
          GITHUB_OUTPUT: output,
        },
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(output, "utf8")).toBe("planning=false\nbrowser=true\nsecurity=true\ngoldens=full\n");
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("wires full on main and the selector output into both runtime jobs, including planning PR oracles", () => {
    const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
    expect(workflow).toContain("goldens=full");
    expect(workflow).toContain("goldens=$(node scripts/ci-goldens-tier.mjs");
    expect(workflow.match(/CONNECTA_GOLDENS_TIER: \$\{\{ needs.changes.outputs.goldens \}\}/g)).toHaveLength(2);
    for (const job of ["node", "workers"]) {
      const section = workflow.split(`\n  ${job}:\n`)[1]!.split(/\n  [a-z]+:\n/)[0]!;
      expect(section).not.toMatch(/^    if:/m);
      expect(section).toContain("test/goldens.test.ts test/goldens-harness.test.ts");
    }
  });
});

it("canonical projection removes only harness variants and preserves vendor steps/variants/key order", () => {
  const vendor = { variants: ["vendor"], steps: [{ after: 42 }], z: 1, a: 2 };
  const row = {
    label: "probe",
    steps: [[{ url: "test", after: 0 }]],
    result: vendor,
    variants: [{ order: "reverse", result: {} }],
  };
  const canonical = { label: row.label, steps: row.steps, result: vendor };
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  expect(canonicalGolden(json([row]))).toBe(json([canonical]));
  const failures = { read: { cases: { "400": row } }, write: { cases: { "400": row } } };
  expect(canonicalGolden(json(failures), "failures")).toBe(
    json({ read: { cases: { "400": canonical } }, write: { cases: { "400": canonical } } }),
  );
  expect(canonicalGolden(json(vendor), "catalog")).toBe(json(vendor));
  const exact = JSON.stringify([canonical]) + "\n";
  expect(canonicalGolden(exact)).toBe(exact); // No variants: retain exact stored bytes, including formatting.
  expect(canonicalGolden(json({ steps: [vendor], variants: [{ order: "reverse", steps: [] }] }), "setup")).toBe(
    json([vendor]),
  );
});
