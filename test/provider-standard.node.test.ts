// Node-only: reads provider folders and documentation/providers.md from disk.
//
// Applies decision 0011's provider standard to every provider folder. A
// provider listed in `PENDING` (test/provider-standard.ts) is exempt from the
// step it has not landed, and must still fail that step, so the list only
// shrinks. Every other folder, including any created after the list, meets
// the whole standard.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import baseline from "./provider-pending-baseline.json";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { authoredFixtures } from "./providers.generated.js";
import {
  PENDING,
  pendingAdditions,
  authoredTools,
  driftViolations,
  evidenceViolations,
  guideViolations,
  layoutViolations,
  surfaceViolations,
  type ProviderFacts,
  type PendingBaseline,
} from "./provider-standard.js";
import { memoryStorage } from "../src/storage/memory.js";
import { silentLogger } from "./helpers.js";
import type { ConnectorContext } from "../src/types.js";

const root = fileURLToPath(new URL("../src/providers/", import.meta.url));
const documentationPath = fileURLToPath(new URL("../documentation/providers.md", import.meta.url));
const documentation = existsSync(documentationPath) ? readFileSync(documentationPath, "utf8") : "";
const today = new Date().toISOString().slice(0, 10);

const CONTEXT: ConnectorContext = {
  storage: memoryStorage(),
  logger: silentLogger,
  baseUrl: "https://connecta.example",
  credential: {
    get: async () => "token",
    getAll: async () => ({ value: "token", email: "operator@example.com" }),
  },
};

function walk(directory: string, prefix = ""): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(directory, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`],
  );
}

const names = readdirSync(root)
  .filter((name) => name !== "_shared" && statSync(join(root, name)).isDirectory())
  .sort();

const folders = await Promise.all(
  names.map(async (name) => {
    const directory = join(root, name);
    const module = (await import(pathToFileURL(join(directory, "index.ts")).href)) as Record<string, unknown>;
    const factory = Object.values(module).find(
      (
        value,
      ): value is {
        definition: { kind: string; title: string; readme?: string; blocks?: { keys: readonly string[] } };
      } => typeof value === "function" && "definition" in value,
    );
    const files = walk(directory).sort();
    const facts: ProviderFacts = {
      name,
      kind: factory?.definition.kind ?? "",
      display: factory?.definition.readme ?? factory?.definition.title ?? name,
      files,
      read: (path) => (files.includes(path) ? readFileSync(join(directory, path), "utf8") : undefined),
      ...(factory?.definition.blocks ? { blockKeys: factory.definition.blocks.keys } : {}),
    };
    // Hosted tools are the vendor's (P1); the S rules read surfaces connecta authors.
    const createAuthored = authoredFixtures[name];
    const tools = await authoredTools(facts.kind, { name, ...(createAuthored ? { createAuthored } : {}) }, CONTEXT);
    return { facts, tools };
  }),
);

const stepOne = ({ facts }: (typeof folders)[number]) =>
  [...layoutViolations(facts), ...evidenceViolations(facts, today), ...driftViolations(facts, today)].map(
    (finding) => `${facts.name} ${finding}`,
  );
const stepTwo = ({ facts, tools }: (typeof folders)[number]) =>
  [...guideViolations(facts, documentation), ...(tools ? surfaceViolations(tools) : [])].map(
    (finding) => `${facts.name} ${finding}`,
  );

const baselinePath = "test/provider-pending-baseline.json";
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function pendingHistoryViolations(cwd: string, current: PendingBaseline, configuredBase?: string): string[] {
  if (configuredBase !== undefined && (!configuredBase.trim() || /^0+$/.test(configuredBase))) {
    throw new Error(
      "CONNECTA_STANDARD_BASE must name a real pre-push/base commit; first pushes with an all-zero before SHA fail closed.",
    );
  }
  let base: string;
  try {
    const head = git(cwd, "rev-parse", "--verify", "HEAD^{commit}");
    base =
      configuredBase === undefined
        ? git(cwd, "merge-base", "origin/main", "HEAD")
        : git(cwd, "rev-parse", "--verify", `${configuredBase}^{commit}`);
    // origin/main advances to HEAD on main pushes. Never compare a commit
    // with itself, including when a caller explicitly configures HEAD.
    if (base === head) base = git(cwd, "rev-parse", "--verify", "HEAD^1^{commit}");
    if (git(cwd, "ls-tree", "--name-only", base, "--", baselinePath)) {
      return pendingAdditions(current, JSON.parse(git(cwd, "show", `${base}:${baselinePath}`)));
    }
  } catch (cause) {
    throw new Error(
      `Provider exemption baseline history is unavailable (${configuredBase ?? "origin/main merge base or HEAD first parent"}). Fetch the base SHA and sufficient history in CI (increase fetch-depth); refusing to skip the ratchet.`,
      { cause },
    );
  }
  // Initial PR only: its base predates the baseline. Freeze names AND count
  // through a digest, so adding a name to both files still fails this PR.
  return createHash("sha256").update(JSON.stringify(current)).digest("hex") ===
    "4dda1a450b4cefae1a2da67ee3a83ce13976a243907d2e246a6b5920ab45d9e7"
    ? []
    : ["Initial provider exemptions differ from the frozen baseline"];
}

describe("the provider standard (decision 0011)", () => {
  it("rejects additions and reinsertions even when PENDING and its baseline change together", () => {
    const cwd = fileURLToPath(new URL("../", import.meta.url));
    expect(pendingHistoryViolations(cwd, baseline, process.env["CONNECTA_STANDARD_BASE"])).toEqual([]);
    expect(baseline).toEqual({ step1: [...PENDING.step1].sort(), step2: [...PENDING.step2].sort() });
  });
  it("keeps one shrinking list of providers that have not landed a step", () => {
    for (const name of PENDING.step1) expect(PENDING.step2.has(name), `${name} pending step 1`).toBe(true);
    for (const name of PENDING.step2) expect(names, `${name} is listed but has no folder`).toContain(name);
  });

  it("holds every provider past step 1 to the layout, evidence, and drift rules (L, E, D)", () => {
    const found = folders.filter((folder) => !PENDING.step1.has(folder.facts.name)).flatMap(stepOne);
    expect(found).toEqual([]);
  });

  it("holds every provider past step 2 to the guide and surface rules (G, S)", () => {
    const found = folders.filter((folder) => !PENDING.step2.has(folder.facts.name)).flatMap(stepTwo);
    expect(found).toEqual([]);
  });

  it("fails while a listed provider already meets the step it is excused from", () => {
    const stale: string[] = [];
    for (const folder of folders) {
      const { name } = folder.facts;
      if (PENDING.step1.has(name) && stepOne(folder).length === 0) stale.push(`${name}: remove from PENDING.step1`);
      if (PENDING.step2.has(name) && !PENDING.step1.has(name) && stepTwo(folder).length === 0) {
        stale.push(`${name}: remove from PENDING.step2`);
      }
    }
    expect(stale).toEqual([]);
  });
});

/** Real Git histories exercise the same guard as the repository assertion. */
function withHistory(run: (cwd: string, commit: (pending: PendingBaseline) => string) => void): void {
  const cwd = mkdtempSync(join(tmpdir(), "connecta-standard-"));
  try {
    git(cwd, "init", "--initial-branch=main");
    git(cwd, "config", "user.name", "Test");
    git(cwd, "config", "user.email", "test@example.com");
    mkdirSync(join(cwd, "test"));
    const commit = (pending: PendingBaseline) => {
      writeFileSync(join(cwd, baselinePath), JSON.stringify(pending));
      git(cwd, "add", baselinePath);
      git(
        cwd,
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=/dev/null",
        "commit",
        "--allow-empty",
        "-m",
        "Record exemptions",
      );
      return git(cwd, "rev-parse", "HEAD");
    };
    run(cwd, commit);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

const withoutGithub = {
  step1: baseline.step1.filter((name) => name !== "github"),
  step2: baseline.step2.filter((name) => name !== "github"),
};

describe("provider exemption comparison history", () => {
  it("rejects main-push additions and reinsertions after origin/main advances to HEAD", () => {
    withHistory((cwd, commit) => {
      commit(baseline);
      const before = commit(withoutGithub);
      const added = { step1: [...baseline.step1, "new-provider"], step2: [...baseline.step2, "new-provider"] };
      const head = commit(added);
      git(cwd, "update-ref", "refs/remotes/origin/main", head);
      const expected = [
        "step1: added or reinserted github",
        "step1: added or reinserted new-provider",
        "step2: added or reinserted github",
        "step2: added or reinserted new-provider",
      ];
      expect(pendingHistoryViolations(cwd, added, before)).toEqual(expected);
      expect(pendingHistoryViolations(cwd, added, head)).toEqual(expected);
      expect(pendingHistoryViolations(cwd, added)).toEqual(expected);
      // A multi-commit push must compare before the whole push, not HEAD^1.
      commit(added);
      git(cwd, "update-ref", "refs/remotes/origin/main", "HEAD");
      expect(pendingHistoryViolations(cwd, added, before)).toEqual(expected);
    });
  });

  it("accepts removals on main pushes", () => {
    withHistory((cwd, commit) => {
      const before = commit(baseline);
      const head = commit(withoutGithub);
      git(cwd, "update-ref", "refs/remotes/origin/main", head);
      expect(pendingHistoryViolations(cwd, withoutGithub, before)).toEqual([]);
      expect(pendingHistoryViolations(cwd, withoutGithub)).toEqual([]);
    });
  });

  it("keeps PR comparisons against the base, with the local merge-base default", () => {
    withHistory((cwd, commit) => {
      const base = commit(baseline);
      git(cwd, "checkout", "-b", "pr");
      commit(withoutGithub);
      git(cwd, "checkout", "main");
      writeFileSync(join(cwd, "unrelated"), "main change");
      git(cwd, "add", "unrelated");
      const main = commit(baseline);
      git(cwd, "update-ref", "refs/remotes/origin/main", main);
      git(cwd, "checkout", "pr");
      expect(git(cwd, "merge-base", "origin/main", "HEAD")).toBe(base);
      expect(pendingHistoryViolations(cwd, withoutGithub)).toEqual([]);
      git(
        cwd,
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=/dev/null",
        "merge",
        "--no-ff",
        "main",
        "-m",
        "PR merge",
      );
      expect(pendingHistoryViolations(cwd, withoutGithub, main)).toEqual([]);
      const added = { step1: [...baseline.step1, "new-provider"], step2: baseline.step2 };
      expect(pendingHistoryViolations(cwd, added, main)).toEqual(["step1: added or reinserted new-provider"]);
    });
  });

  it("fails closed on missing refs, unavailable shallow history, and missing first parents", () => {
    withHistory((cwd, commit) => {
      const before = commit(baseline);
      const head = commit(withoutGithub);
      expect(() => pendingHistoryViolations(cwd, withoutGithub)).toThrow(/Fetch the base SHA.*fetch-depth/);
      expect(() => pendingHistoryViolations(cwd, withoutGithub, "missing-ref")).toThrow(/Fetch the base SHA/);
      const shallow = join(cwd, "shallow");
      git(cwd, "clone", "--depth=1", pathToFileURL(cwd).href, shallow);
      expect(() => pendingHistoryViolations(shallow, withoutGithub, before)).toThrow(/Fetch the base SHA/);
      expect(() => pendingHistoryViolations(shallow, withoutGithub, head)).toThrow(/Fetch the base SHA/);
      expect(() => pendingHistoryViolations(shallow, withoutGithub)).toThrow(/Fetch the base SHA/);
    });
  });

  it("fails closed on first-push all-zero or empty configured bases", () => {
    for (const base of ["0".repeat(40), ""]) {
      expect(() => pendingHistoryViolations("unused", baseline, base)).toThrow(/first pushes.*fail closed/);
    }
  });

  it("retains the frozen initial digest when the base predates the baseline", () => {
    withHistory((cwd, commit) => {
      git(
        cwd,
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=/dev/null",
        "commit",
        "--allow-empty",
        "-m",
        "Before baseline",
      );
      const before = git(cwd, "rev-parse", "HEAD");
      commit(baseline);
      expect(pendingHistoryViolations(cwd, baseline, before)).toEqual([]);
      expect(pendingHistoryViolations(cwd, withoutGithub, before)).toEqual([
        "Initial provider exemptions differ from the frozen baseline",
      ]);
    });
  });
});

/** A provider folder written to today's legacy shapes, as a new provider might copy them. */
function legacy(): ProviderFacts {
  const files: Record<string, string> = {
    "index.ts": 'export const acme = asProviderFactory({ kind: "composed", create: () => api({ inputSchema }) });',
    "SKILL.md":
      '---\n{ "name": "acme", "instructionsHeading": "Acme instructions", "content": "guide" }\n---\n' +
      "<!-- fragment: guide -->\n# Acme usage\n\nImport `acme` from `@zackbart/connecta/providers/acme`.\n<!-- endfragment -->\n",
    "drift.json": JSON.stringify({
      version: 1,
      provider: "acme",
      checks: [{ type: "manual", source: "https://acme.example/api", rationale: "Hand-written HTML." }],
    }),
    "fixtures.ts": "",
    "skill.generated.ts": "",
    "provider.test.ts": "",
    "catalog.fixture.json": "[]",
    "value-safety.candidates.json": "{}",
  };
  return {
    name: "acme",
    kind: "composed",
    display: "Acme",
    files: Object.keys(files).sort(),
    read: (path) => files[path],
  };
}

const DIGEST = `sha256:${"0".repeat(64)}`;

/** A dual provider folder that meets every rule. */
function standard(): ProviderFacts {
  const files: Record<string, string> = {
    "index.ts": 'export const acme = defineProvider({ kind: "dual", create: byAuth({ oauth: hosted, apiKey: kit }) });',
    "api.ts": "",
    "tools.ts": "",
    "hosted.ts": "",
    "safety.ts": "",
    "SKILL.md":
      '---\n{ "name": "acme", "instructionsHeading": "Acme instructions" }\n---\n\n## Identity first\n\n' +
      "Resolve a customer id before any write.\n\n<!-- when: hosted -->\nSelect the account first.\n<!-- end -->\n",
    "drift.json": JSON.stringify({
      version: 2,
      provider: "acme",
      generated: {
        operations: ["GET /customers", "POST /customers"],
        hosted: ["get_customer", "list_customers"],
        evidence: { "catalog.json": DIGEST, "openapi.json": DIGEST, "value-safety.json": DIGEST },
      },
      checks: [
        { type: "openapi-index", source: "evidence/openapi.json" },
        {
          type: "manual",
          source: "https://acme.example/mcp",
          reason: "The catalog needs a login.",
          lastVerified: "2026-10-20",
        },
      ],
    }),
    "fixtures.ts": "",
    "skill.generated.ts": "",
    "openapi.generated.ts": "",
    "provider.test.ts": "",
    "provider.safety.node.test.ts": "// Node-only: reads evidence files.",
    "lib/graphql.ts": "",
    "evidence/catalog.json": JSON.stringify({
      capturedAt: "2026-10-19",
      method: "tools/list",
      source: "https://acme.example/mcp",
      tools: [{ name: "get_customer" }, { name: "list_customers" }],
    }),
    "evidence/openapi.json": JSON.stringify({
      url: "https://acme.example/openapi.json",
      revision: "v1",
      digest: DIGEST,
    }),
    "evidence/value-safety.json": JSON.stringify({ format: 5, digest: DIGEST, candidates: {} }),
    "evidence/review.md": "Reviewed against the published reference.\n",
  };
  return {
    name: "acme",
    kind: "dual",
    display: "Acme",
    files: Object.keys(files).sort(),
    read: (path) => files[path],
    blockKeys: ["api", "hosted"],
  };
}

describe("the provider standard's rules", () => {
  it("excuses no provider created after the list", () => {
    expect(PENDING.step1.has("acme")).toBe(false);
    expect(PENDING.step2.has("acme")).toBe(false);
  });

  it("rejects a new provider written to legacy shapes, in every rule family", () => {
    const folder = legacy();
    const found = [
      ...layoutViolations(folder),
      ...evidenceViolations(folder, today),
      ...driftViolations(folder, today),
      ...guideViolations(folder, ""),
    ];
    for (const rule of ["L1", "L2", "L3", "D1", "G1", "G2", "G3", "G4", "G7"]) {
      expect(
        found.some((finding) => finding.startsWith(`${rule}:`)),
        rule,
      ).toBe(true);
    }
  });

  it("names evidence kept under legacy names or formats", () => {
    const folder = standard();
    const files = folder.files
      .filter((file) => file !== "evidence/catalog.json")
      .concat("evidence/catalog.fixture.json");
    const found = evidenceViolations(
      {
        ...folder,
        files,
        read: (path) => (path === "evidence/openapi.json" ? '{ "url": "http://acme.example" }' : folder.read(path)),
      },
      today,
    );
    expect(found).toEqual([
      "E1: evidence/catalog.fixture.json is not a standard evidence name",
      "E2: a hosted implementation needs evidence/catalog.json",
      "E3: evidence/openapi.json needs an https url, a revision, and a sha256 digest",
    ]);
  });

  it("accepts a provider that meets the standard", () => {
    const folder = standard();
    expect([
      ...layoutViolations(folder),
      ...evidenceViolations(folder, today),
      ...driftViolations(folder, today),
      ...guideViolations(folder, "# Providers\n\n## Acme\n"),
    ]).toEqual([]);
  });

  it("retains observation-only Google hosted names and four annotations independently of api classification", () => {
    const folder = standard();
    const drift = JSON.parse(folder.read("drift.json")!);
    const catalog = JSON.parse(folder.read("evidence/catalog.json")!);
    const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
    catalog.tools = [
      { name: "read_doc", annotations },
      { name: "update_doc", annotations: { ...annotations, readOnlyHint: false } },
    ];
    drift.generated.hosted = [];
    drift.checks.push({
      type: "mcp-catalog",
      endpoint: "https://docsmcp.googleapis.com/mcp/v1",
      catalog: "evidence/catalog.json",
    });
    const observation: ProviderFacts = {
      ...folder,
      kind: "api",
      read: (path) =>
        path === "drift.json"
          ? JSON.stringify(drift)
          : path === "evidence/catalog.json"
            ? JSON.stringify(catalog)
            : folder.read(path),
    };
    expect(evidenceViolations(observation, today)).toEqual([]);
    expect(driftViolations(observation, today)).toEqual([]);
    drift.generated.hosted = ["read_doc", "update_doc"];
    expect(driftViolations(observation, today)).toContain(
      "D2: generated.hosted lists served hosted names, sorted; api observations stay in evidence/catalog.json",
    );
    drift.generated.hosted = [];
    delete drift.checks.at(-1).catalog;
    expect(driftViolations(observation, today)).toContain(
      "D4: checks[2] compares hosted names and annotations against evidence/catalog.json (tools/list)",
    );
    catalog.tools[0].annotations.readOnlyHint = "true";
    expect(evidenceViolations(observation, today)).toContain(
      "E3: evidence/catalog.json read_doc behavioral hints must be booleans when present",
    );
  });

  it("holds when-blocks to declared keys on their own lines, and dual guides to hosted and api", () => {
    const folder = standard();
    const guide = (body: string, facts: Partial<ProviderFacts> = {}) =>
      guideViolations(
        {
          ...folder,
          ...facts,
          read: (path) =>
            path === "SKILL.md" ? `---\n{ "name": "acme", "instructionsHeading": "Acme" }\n---\n${body}` : undefined,
        },
        "## Acme\n",
      );
    expect(guide("\n## Ids\n\n<!-- when: hosted -->\nSelect the account.\n<!-- end -->\n")).toEqual([]);
    expect(guide("\n<!-- when: region -->\nUS only.\n<!-- end -->\n")).toEqual([
      "G2: SKILL.md uses the undeclared when-block key region",
    ]);
    expect(guide("\nText <!-- when: hosted -->inline<!-- end -->\n")).toContain(
      "G2: a when-block marker stands alone on its line",
    );
    expect(guide("\n<!-- when: hosted -->\n<!-- when: api -->\n<!-- end -->\n")).toContain(
      "G2: SKILL.md when-blocks must open and close in turn, unnested",
    );
    expect(guide("\n## Ids\n", { blockKeys: ["hosted"] })).toEqual([
      "G2: a dual provider declares the hosted and api block keys",
    ]);
    expect(guide("\n## Ids\n", { kind: "api", blockKeys: [] })).toEqual([]);
  });

  it("names the drift record's renamed and hand-kept fields", () => {
    const folder = standard();
    const drift = JSON.parse(folder.read("drift.json")!);
    drift.checks = [
      { type: "manual", source: "https://acme.example", rationale: "Prose.", evidence: { reviewedAt: "2026-10-01" } },
      { type: "mcp-docs", setup: "https://acme.example/mcp", reviewed: ["get_customer"] },
      { type: "endpoints", endpoints: [{ method: "GET", path: "/customers" }] },
    ];
    const found = driftViolations(
      { ...folder, read: (path) => (path === "drift.json" ? JSON.stringify(drift) : undefined) },
      today,
    );
    expect(found).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^D3: checks\[0\] uses rationale or reviewedAt/),
        expect.stringMatching(/^D3: checks\[0\] manual check needs a reason/),
        expect.stringMatching(/^D3: checks\[0\] manual check needs lastVerified/),
        expect.stringMatching(/^D4: checks\[1\] hand-keeps a reviewed list/),
        expect.stringMatching(/^D4: checks\[2\] entries are keyed by an operation/),
      ]),
    );
  });

  it("refuses a drift record providers:check cannot read, by the validator providers:check uses", () => {
    const folder = standard();
    const drift = JSON.parse(folder.read("drift.json")!);
    const violations = (checks: unknown[], options?: { recording?: boolean }) =>
      driftViolations(
        {
          ...folder,
          read: (path) => (path === "drift.json" ? JSON.stringify({ ...drift, checks }) : folder.read(path)),
        },
        today,
        options,
      );
    const contract = `sha256:${"0".repeat(64)}`;
    const readme = (row: object) => ({
      type: "endpoints",
      specification: { url: "https://docs.acme.example/reference/", format: "readme-operation-pages" },
      endpoints: [{ operation: "GET /customers", specRevision: "1", ...row }],
    });
    const docs = (reviewedAccess: object) => ({
      type: "mcp-docs",
      setup: "https://acme.example/mcp",
      endpoints: ["https://mcp.acme.example/mcp"],
      reviewedAccess,
    });
    expect(violations([readme({ page: "list-customers", contract }), docs({ get_customer: "read" })])).toEqual([]);
    expect(violations([readme({ contract })])).toEqual([
      "D3: providers:check rejects checks[0]: GET /customers names its reference page",
    ]);
    expect(violations([docs({ ghost: "read" })])).toEqual([
      "D3: providers:check rejects checks[0]: reviewed access must name generated hosted tools",
    ]);
    // A row awaiting its contract is generated (recording) but never committed.
    expect(violations([readme({ page: "list-customers" })])).toEqual([
      "D3: providers:check rejects checks[0]: invalid contract digest: GET /customers",
    ]);
    expect(violations([readme({ page: "list-customers" })], { recording: true })).toEqual([]);
  });
});
