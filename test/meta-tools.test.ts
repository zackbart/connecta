import { describe, expect, it } from "vitest";
import { connectorWith } from "./fixtures/connectors.js";
import { api } from "../src/connectors/api.js";
import { CatalogService } from "../src/catalog-service.js";
import {
  CredentialVault,
  STORED_CREDENTIAL_SHAPE_MISMATCH_ERROR,
} from "../src/credentials.js";
import { ConnectorCallError } from "../src/errors.js";
import {
  createMetaTools,
} from "../src/meta-tools.js";
import {
  connectorGuideSummary,
  GUIDE_SUMMARY_LENGTH,
  USAGE_SKILL,
} from "../src/skills.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { Connector } from "../src/types.js";
import type { ToolCallActivityEvent } from "../src/activity.js";
import { required,
  activitySink,
  authConnector,
  brokenConnector,
  calcConnector,
  makeRegistry,
  remoteConnector,
} from "./helpers.js";

const BASE = "https://connecta.test";
const CREDENTIAL_KEY = Buffer.alloc(32, 11).toString("base64");

function textOf(result: { content: { text: string }[] }): unknown {
  return JSON.parse(required(result.content[0]).text);
}

function registry() {
  return makeRegistry([
    calcConnector,
    remoteConnector,
    brokenConnector,
    authConnector,
  ]);
}

interface SearchGroup {
  id: string;
  description?: string;
  tools: {
    name: string;
    address: string;
    description?: string;
  }[];
}
interface SearchResult {
  connectors: SearchGroup[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  nextOffset?: number;
  matchMode?: "partial";
  queryAnalysis?: {
    representedTerms: string[];
    otherResultTerms: string[];
    unmatchedTerms: string[];
    truncated?: true;
    connectorScope?: string;
    unknownConnector?: true;
    unavailableConnectorCount?: number;
    catalogError?: {
      code: string;
      message: string;
      retryable: boolean;
      retryAfterMs?: number;
    };
    guide?: string;
    guideSummary?: string;
    guideRequired?: true;
    guideRequiredReasons?: string[];
    guidance?: string;
  };
}

describe("skills", () => {
  const NOTION_GUIDE = `# Notion usage

Prefer \`notion.search\` over listing databases.

- Page results with \`start_cursor\`; never fetch more than 100 at a time.
`;

  function guided(id: string, guide?: Connector["usageGuide"]): Connector {
    return api(id, {
      description: `${id} connector`,
      ...(guide === undefined ? {} : { usageGuide: guide }),
      tools: [
        {
          name: "search",
          description: "Search records",
          inputSchema: { type: "object" },
          annotations: { readOnlyHint: true },
          handler: () => ({ results: [] }),
        },
      ],
    });
  }

  /**
   * A guided read-only tool whose compact discovery schema is too wide to
   * render whole — `schema_truncated` is the one required-review reason an
   * exact schema resolves, so it needs a connector both halves can share.
   */
  function wideGuided(): Connector {
    return api("wide", {
      usageGuide: {
        content: "# Wide API\n\nArguments are documented here.\n",
        summary: "Argument meanings for wide operations.",
      },
      tools: [
        {
          name: "read",
          description: "Read a value",
          inputSchema: {
            type: "object",
            properties: Object.fromEntries(
              Array.from({ length: 100 }, (_, index) => [
                `argument_${index}_${"x".repeat(20)}`,
                { type: "string" },
              ]),
            ),
          },
          annotations: { readOnlyHint: true },
          handler: () => ({}),
        },
      ],
    });
  }

  function textFrom(result: { content: { text: string }[] }): string {
    return required(result.content[0]).text;
  }

  it("lists the built-in usage guide plus one entry per guided connector", async () => {
    const mt = createMetaTools(
      makeRegistry([guided("notion", NOTION_GUIDE), guided("plain")]),
      BASE,
    );
    const listed = textFrom(await mt.skills({}));
    expect(listed).toContain(
      "`usage` — How to route work between one execute_code program",
    );
    expect(listed).toContain(
      "`connector:notion` — Prefer `notion.search` over listing databases.",
    );
    expect(listed).not.toContain("connector:plain");
  });

  it("summarizes a guide with no heading from its first meaningful paragraph", async () => {
    const mt = createMetaTools(
      makeRegistry([guided("linear", "- Use `linear.search_issues` first.\n")]),
      BASE,
    );
    expect(textFrom(await mt.skills({}))).toContain(
      "`connector:linear` — Use `linear.search_issues` first.",
    );
  });

  it("joins hard-wrapped opening paragraphs into complete thoughts", async () => {
    const cases: Array<[string, string, string]> = [
      [
        "vercel",
        "Use this connector for Vercel infrastructure and deployment state, not\n" +
          "application data or source-code changes.\n\nLater details.",
        "Use this connector for Vercel infrastructure and deployment state, not " +
          "application data or source-code changes.",
      ],
      [
        "supabase",
        "Use this connector for Supabase account and project administration, not routine\n" +
          "application queries or migrations.\n\nLater details.",
        "Use this connector for Supabase account and project administration, not routine " +
          "application queries or migrations.",
      ],
    ];
    for (const [id, guide, expected] of cases) {
      const summary = connectorGuideSummary(guided(id, guide));
      expect(summary, id).toBe(expected);
      expect(summary?.length, id).toBeLessThanOrEqual(GUIDE_SUMMARY_LENGTH);
    }
  });

  it("skips opening markup when picking the summary line", async () => {
    const cases: Array<[string, string, string]> = [
      ["fence", "```json\n{ \"a\": 1 }\n```\n\nUse `x.search`.\n", "Use `x.search`."],
      [
        "comment-inside-fence",
        "```html\n<!-- example\n```\n\nUse `x.search`.\n",
        "Use `x.search`.",
      ],
      ["frontmatter", "---\ntitle: ignored\n---\n\n# Real heading\n", "Real heading"],
      ["bare-hash", "#\n\nUse the search tool.\n", "Use the search tool."],
      ["bare-hashes", "###\n\nUse the search tool.\n", "Use the search tool."],
      ["unspaced-heading", "#Heading text\n", "Heading text"],
      [
        "html-comment",
        "<!-- generated\nmetadata -->\n\n# Real heading\n",
        "Real heading",
      ],
      [
        "leading-pipe-table",
        "| Column | Meaning |\n| --- | --- |\n| id | Project id |\n\n# Real heading\n",
        "Real heading",
      ],
      [
        "standard-table",
        "Column | Meaning\n--- | ---\nid | Project id\n\nUse the project id from search.\n",
        "Use the project id from search.",
      ],
      [
        "ordinary-pipe-prose",
        "Use `left | right` as the literal query value.\n",
        "Use `left | right` as the literal query value.",
      ],
      ["rule", "---\n\n", "svc connector"],
    ];
    for (const [label, guide, expected] of cases) {
      const mt = createMetaTools(makeRegistry([guided("svc", guide)]), BASE);
      expect(textFrom(await mt.skills({})), label).toContain(
        `\`connector:svc\` — ${expected}`,
      );
    }
  });

  it("falls back to the connector description when a guide is all markup", async () => {
    const mt = createMetaTools(makeRegistry([guided("svc", "# \n")]), BASE);
    expect(textFrom(await mt.skills({}))).toContain(
      "`connector:svc` — svc connector",
    );
  });

  it("shortens long summaries at sentence, clause, word, then hard boundaries", async () => {
    const exact = "a".repeat(GUIDE_SUMMARY_LENGTH);
    const over = "b".repeat(121);
    const completeSentence =
      "Resolve the project identifier before any deployment lookup. " +
      "This second sentence is deliberately long enough to exceed the discovery budget by a wide margin.";
    const longClause =
      "Use the reporting endpoint for deployment history and release state across every project in the account, " +
      "then reduce each result to its identifier.";
    const longWords = Array.from(
      { length: 30 },
      (_, index) => `complete${index}`,
    ).join(" ");

    expect(connectorGuideSummary(guided("exact", exact))).toBe(exact);
    expect(connectorGuideSummary(guided("over", over))).toBe(
      `${"b".repeat(119)}…`,
    );
    expect(connectorGuideSummary(guided("sentence", completeSentence))).toBe(
      "Resolve the project identifier before any deployment lookup.",
    );
    expect(connectorGuideSummary(guided("clause", longClause))).toBe(
      "Use the reporting endpoint for deployment history and release state across every project in the account…",
    );
    const wordSummary = connectorGuideSummary(guided("words", longWords));
    expect(wordSummary?.endsWith("…")).toBe(true);
    expect(longWords).toContain(`${wordSummary?.slice(0, -1)} `);
    for (const summary of [
      exact,
      connectorGuideSummary(guided("over", over)),
      connectorGuideSummary(guided("sentence", completeSentence)),
      connectorGuideSummary(guided("clause", longClause)),
      wordSummary,
    ]) {
      expect(summary?.length).toBeLessThanOrEqual(GUIDE_SUMMARY_LENGTH);
    }
  });

  it.each([
    ["e.g.", "Use exact identifiers, e.g. the project id from search, before making any deployment lookup across the account and its teams."],
    ["i.e.", "Use exact identifiers, i.e. project ids rather than names, before making any deployment lookup across the account and its teams."],
    ["U.S.", "Use the U.S. project region with the exact project id before making any deployment lookup across the account and its teams."],
    ["Dr.", "Ask Dr. Smith for the exact project id before making any deployment lookup across the account and its teams or archived workspaces."],
  ] as const)("does not treat %s as a sentence ending", (name, guide) => {
    const summary = connectorGuideSummary(guided(`abbr-${name}`, guide));
    expect(summary, guide).not.toMatch(/(?:e\.g|i\.e|U\.S|Dr)\.$/u);
    expect(summary, guide).toMatch(/…$/u);
    expect(summary?.length, guide).toBeLessThanOrEqual(GUIDE_SUMMARY_LENGTH);
  });

  it("allows a dotted abbreviation to finish a sentence", () => {
    const guide =
      "This connector serves projects in the U.S. " +
      "Use the exact project identifier before making any deployment lookup " +
      "across the account and all its teams.";
    expect(connectorGuideSummary(guided("terminal", guide))).toBe(
      "This connector serves projects in the U.S.",
    );
  });

  it.each([
    ["region", "Use projects from the U.S. East region with the exact project id before making any deployment lookup across the account and its archived teams."],
    ["organization", "Coordinate with U.S. Army contacts for the exact project id before making any deployment lookup across the account and its teams."],
  ] as const)("keeps a dotted initialism attached to its %s", (_name, guide) => {
    const summary = connectorGuideSummary(guided("region", guide));
    expect(summary, guide).not.toMatch(/U\.S\.$/u);
    expect(summary, guide).toMatch(/…$/u);
    expect(summary?.length, guide).toBeLessThanOrEqual(GUIDE_SUMMARY_LENGTH);
  });

  it("uses an ellipsis when an initialism boundary lacks clause evidence", () => {
    const guide =
      "This connector serves projects in the U.S. Use exact project " +
      "identifiers before making any deployment lookup across the account " +
      "and all its teams.";
    const summary = connectorGuideSummary(guided("ambiguous", guide));
    expect(summary).not.toMatch(/U\.S\.$/u);
    expect(summary).toMatch(/…$/u);
  });

  it("keeps a title abbreviation attached to the proper name", () => {
    const guide =
      "Ask Dr. Smith for the exact project identifier before making any " +
      "deployment lookup across the account and all its teams or archived workspaces.";
    const summary = connectorGuideSummary(guided("title", guide));
    expect(summary).not.toBe("Ask Dr.");
    expect(summary).toMatch(/…$/u);
  });

  it("treats a whitespace-only guide as no guide at all", async () => {
    const mt = createMetaTools(makeRegistry([guided("blank", "  \n\t\n")]), BASE);
    expect(textFrom(await mt.skills({}))).not.toContain("connector:blank");
    const fetched = await mt.skills({ name: "connector:blank" });
    expect(fetched.isError).toBe(true);
    expect(textFrom(fetched)).toContain('Connector "blank" has no usage guide');
  });

  it("returns a connector guide verbatim", async () => {
    const mt = createMetaTools(
      makeRegistry([guided("notion", NOTION_GUIDE)]),
      BASE,
    );
    const fetched = await mt.skills({ name: "connector:notion" });
    expect(fetched.isError).toBeFalsy();
    expect(textFrom(fetched)).toBe(NOTION_GUIDE);
  });

  it("uses a normalized explicit summary while returning guide content verbatim", async () => {
    const content = "# Cloud API\n\nResolve operation aliases before calling.\n";
    const mt = createMetaTools(
      makeRegistry([
        guided("cloud", {
          content,
          summary: "  Generic API aliases, argument units, and pagination.  ",
        }),
      ]),
      BASE,
    );
    const listed = textFrom(await mt.skills({}));
    expect(listed).toContain(
      "`connector:cloud` — Generic API aliases, argument units, and pagination.",
    );
    expect(textFrom(await mt.skills({ name: "connector:cloud" }))).toBe(
      content,
    );
  });

  it("rejects an explicit summary over budget at registry construction", () => {
    expect(() =>
      makeRegistry([
        guided("cloud", {
          content: "# Cloud API\n",
          summary: "x".repeat(GUIDE_SUMMARY_LENGTH + 1),
        }),
      ]),
    ).toThrow(
      'Connector "cloud" usageGuide.summary is 121 characters after whitespace normalization; the discovery bound is 120.',
    );
  });

  it("accepts exact and whitespace-normalized explicit summaries at budget", async () => {
    const exact = "x".repeat(GUIDE_SUMMARY_LENGTH);
    const normalized = `${" y".repeat(59)}  yy`;
    const mt = createMetaTools(
      makeRegistry([
        guided("exact", { content: "Body.", summary: exact }),
        guided("normalized", { content: "Body.", summary: normalized }),
        guided("blank", { content: "Derived body.", summary: " \n " }),
      ]),
      BASE,
    );
    const listed = textFrom(await mt.skills({}));
    expect(listed).toContain(`\`connector:exact\` — ${exact}`);
    expect(listed).toContain(
      `\`connector:normalized\` — ${normalized.replace(/\s+/g, " ").trim()}`,
    );
    expect(listed).toContain("`connector:blank` — Derived body.");
  });

  it("keeps duplicate guide content and deployment-specific summaries isolated", async () => {
    const content = "# Shared service\n\nUse the deployment's configured alias.\n";
    const first = createMetaTools(
      makeRegistry([
        guided("service", {
          content,
          summary: "First deployment aliases.",
        }),
      ]),
      BASE,
    );
    const second = createMetaTools(
      makeRegistry([
        guided("service", {
          content,
          summary: "Second deployment aliases.",
        }),
      ]),
      BASE,
    );

    expect(textFrom(await first.skills({}))).toContain(
      "`connector:service` — First deployment aliases.",
    );
    expect(textFrom(await second.skills({}))).toContain(
      "`connector:service` — Second deployment aliases.",
    );
    expect(textFrom(await first.skills({ name: "connector:service" }))).toBe(
      content,
    );
    expect(textFrom(await second.skills({ name: "connector:service" }))).toBe(
      content,
    );
  });

  it("returns a guide with surrounding whitespace verbatim, padding included", async () => {
    const padded = "\n\n  # Padded\n\nBody.\n   ";
    const mt = createMetaTools(makeRegistry([guided("pad", padded)]), BASE);
    expect(textFrom(await mt.skills({ name: "connector:pad" }))).toBe(padded);
    expect(textFrom(await mt.skills({}))).toContain("`connector:pad` — Body.");
  });

  it("keeps the built-in usage guide unchanged as the default experience", async () => {
    const mt = createMetaTools(
      makeRegistry([guided("notion", NOTION_GUIDE)]),
      BASE,
    );
    const fetched = await mt.skills({ name: "usage" });
    expect(fetched.isError).toBeFalsy();
    expect(textFrom(fetched)).toBe(USAGE_SKILL);
    expect(textFrom(fetched)).toContain("# Connecta usage");
    expect(textFrom(fetched)).toContain(
      "never infer one from a connector id",
    );
    // #418 moves detailed examples out of always-loaded definitions. The
    // usage skill is now their one model-facing home.
    expect(textFrom(fetched)).toContain("## Examples");
    expect(textFrom(fetched)).toContain("crm.get_account");
    expect(textFrom(fetched)).toContain("## Errors and repair");
    expect(textFrom(fetched)).toContain("## Runtime portability");
    // The guarded-render recipe, whose whole point is the branch that does not
    // render: a program that finds the data is not what it expected hands the
    // model the record instead of a confident, empty view (#282).
    expect(textFrom(fetched)).toContain("## Rendering a view");
    expect(textFrom(fetched)).toContain(
      "return a trimmed first record instead of rendering",
    );
    expect(textFrom(fetched)).toContain(
      "the model reads the return value, not the view",
    );
  });

  it("serves byte-identical shared usage guidance across deployments", async () => {
    const plain = createMetaTools(
      makeRegistry([guided("plain"), guided("other")]),
      BASE,
    );
    const guidedDeployment = createMetaTools(
      makeRegistry([guided("notion", NOTION_GUIDE)]),
      BASE,
    );
    const expected = USAGE_SKILL;
    expect(textFrom(await plain.skills({ name: "usage" }))).toBe(expected);
    expect(textFrom(await guidedDeployment.skills({ name: "usage" }))).toBe(
      expected,
    );
    const listed = textFrom(await plain.skills({}));
    expect(listed).toContain(
      "`usage` — How to route work between one execute_code program",
    );
    expect(listed).not.toContain("connector:");
    // #418 moves program selection, direct-call repair, paging, UI bindings,
    // runtime detail, and examples out of the always-loaded definitions. This
    // deliberate 9 KB on-demand budget preserves every normative rule instead
    // of truncating guidance to retain the former 7 KB ceiling.
    expect(new TextEncoder().encode(expected).length).toBeLessThan(9_000);
  });

  it("errors — never falls back to the generic guide — for a connector with no guide", async () => {
    const mt = createMetaTools(makeRegistry([guided("plain")]), BASE);
    const fetched = await mt.skills({ name: "connector:plain" });
    expect(fetched.isError).toBe(true);
    expect(textFrom(fetched)).toContain(
      'Connector "plain" has no usage guide',
    );
    expect(textFrom(fetched)).not.toContain("# Connecta usage");
  });

  it("errors for an unknown connector guide and an unknown skill name", async () => {
    const mt = createMetaTools(
      makeRegistry([guided("notion", NOTION_GUIDE)]),
      BASE,
    );
    const unknownConnector = await mt.skills({ name: "connector:ghost" });
    expect(unknownConnector.isError).toBe(true);
    expect(textFrom(unknownConnector)).toContain('Unknown connector "ghost"');
    expect(textFrom(unknownConnector)).toContain("connector:notion");

    const unknownSkill = await mt.skills({ name: "missing" });
    expect(unknownSkill.isError).toBe(true);
    expect(textFrom(unknownSkill)).toContain('Unknown skill "missing"');
    expect(textFrom(unknownSkill)).not.toContain("# Connecta usage");
  });

  it("labels the available-skills list identically on every error branch", async () => {
    const mt = createMetaTools(
      makeRegistry([guided("notion", NOTION_GUIDE), guided("plain")]),
      BASE,
    );
    // One enumeration, one label — which branch an agent hits must not change
    // what the list is called. `Available skills:` is the label; a bare
    // `Available:` is the drift this pins against, and "Available skills:"
    // does not contain it.
    for (const name of [
      "connector:ghost", // unknown connector
      "connector:plain", // known connector, no usage guide
      "notion", // bare id whose guide is reachable under the prefix
      "plain", // bare id with no guide at all
      "missing", // unknown skill name
    ]) {
      const failed = await mt.skills({ name });
      expect(failed.isError, name).toBe(true);
      expect(textFrom(failed), name).toContain("Available skills:");
      expect(textFrom(failed), name).not.toContain("Available:");
    }
  });

  it("points a bare connector id at its prefixed skill name", async () => {
    const mt = createMetaTools(
      makeRegistry([guided("notion", NOTION_GUIDE)]),
      BASE,
    );
    const fetched = await mt.skills({ name: "notion" });
    expect(fetched.isError).toBe(true);
    expect(textFrom(fetched)).toContain(
      'Connector guides are fetched as "connector:notion"',
    );
  });

  it('a connector whose id is "usage" neither shadows nor is shadowed', async () => {
    const guide = "# Usage-service quirks\n\nRate limit: 10 rpm.\n";
    const mt = createMetaTools(makeRegistry([guided("usage", guide)]), BASE);

    const listed = textFrom(await mt.skills({}));
    expect(listed).toContain(
      "`usage` — How to route work between one execute_code program",
    );
    expect(listed).toContain("`connector:usage` — Rate limit: 10 rpm.");

    expect(textFrom(await mt.skills({ name: "usage" }))).toBe(
      USAGE_SKILL,
    );
    expect(textFrom(await mt.skills({ name: "connector:usage" }))).toBe(guide);
  });

  it("names the guide in search_tools output", async () => {
    const mt = createMetaTools(
      makeRegistry([guided("notion", NOTION_GUIDE), guided("plain")]),
      BASE,
    );
    const searched = textOf(await mt.searchTools({ query: "search" })) as {
      connectors: Array<{
        id: string;
        guide?: string;
        guideSummary?: string;
        tools: Array<{ guideRequired?: true; guideRequiredReasons?: string[] }>;
      }>;
    };
    const byId = Object.fromEntries(searched.connectors.map((c) => [c.id, c]));
    expect(required(byId.notion).guide).toBe("connector:notion");
    expect(required(byId.notion).guideSummary).toBe(
      "Prefer `notion.search` over listing databases.",
    );
    expect(required(byId.notion).tools[0]).not.toHaveProperty(
      "guideRequiredReasons",
    );
    expect(required(byId.notion).tools[0]).not.toHaveProperty(
      "guideRequired",
    );
    expect(byId.plain).not.toHaveProperty("guide");
    expect(
      textFrom(
        await mt.skills({ name: required(required(byId.notion).guide) }),
      ),
    ).toBe(NOTION_GUIDE);
  });

  it("requires guide review for approval-bound tools and connector-required conventions", async () => {
    const connector = api("generic", {
      usageGuide: {
        content: "# Generic API\n\nRead the operation documentation first.\n",
        summary: "Generic operation aliases and argument shapes.",
        required: true,
      },
      tools: [
        {
          name: "invoke",
          description: "Invoke a generic operation",
          inputSchema: { type: "object" },
          annotations: { readOnlyHint: false },
          handler: () => ({}),
        },
      ],
    });
    const mt = createMetaTools(makeRegistry([connector]), BASE);
    const searched = textOf(
      await mt.searchTools({ query: "invoke", includeSchemas: "compact" }),
    ) as {
      connectors: Array<{
        guideSummary?: string;
        tools: Array<{ guideRequired?: true; guideRequiredReasons?: string[] }>;
      }>;
    };
    expect(required(searched.connectors[0]).guideSummary).toBe(
      "Generic operation aliases and argument shapes.",
    );
    expect(required(required(searched.connectors[0]).tools[0]).guideRequired).toBe(
      true,
    );
    expect(required(required(searched.connectors[0]).tools[0]).guideRequiredReasons).toEqual(
      ["connector_required", "approval_required"],
    );

    const missed = textOf(
      await mt.searchTools({
        connector: "generic",
        query: "list open invoices",
        includeSchemas: "compact",
      }),
    ) as {
      connectors: unknown[];
      queryAnalysis?: {
        guide?: string;
        guideSummary?: string;
        guideRequired?: true;
        guideRequiredReasons?: string[];
        guidance?: string;
      };
    };
    expect(missed.connectors).toEqual([]);
    expect(missed.queryAnalysis).toMatchObject({
      guide: "connector:generic",
      guideSummary: "Generic operation aliases and argument shapes.",
      guideRequired: true,
      guideRequiredReasons: ["connector_required"],
      guidance: expect.stringContaining("Fetch queryAnalysis.guide"),
    });
  });

  it("requires guide review when a compact schema is truncated", async () => {
    const mt = createMetaTools(makeRegistry([wideGuided()]), BASE);
    const searched = textOf(
      await mt.searchTools({ query: "read", includeSchemas: "compact" }),
    ) as {
      connectors: Array<{
        tools: Array<{
          inputSchemaTruncated?: true;
          guideRequired?: true;
          guideRequiredReasons?: string[];
        }>;
      }>;
    };
    const tool = required(required(searched.connectors[0]).tools[0]);
    expect(tool.inputSchemaTruncated).toBe(true);
    expect(tool.guideRequired).toBe(true);
    expect(tool.guideRequiredReasons).toEqual(["schema_truncated"]);
  });

  it("clears schema_truncated once describe returns the exact schema", async () => {
    // The reason exists because the agent could not read the whole shape.
    // describe renders it whole, so the reason is spent — and the tool
    // descriptions promise exactly this one waiver and no other.
    const described = await new CatalogService(
      makeRegistry([wideGuided()]),
      BASE,
    ).describe({ addresses: ["wide.read"] });
    const entry = required(described[0]);
    expect(entry.guide).toBe("connector:wide");
    expect(entry.guideSummary).toBe("Argument meanings for wide operations.");
    expect(entry).not.toHaveProperty("guideRequired");
    expect(entry).not.toHaveProperty("guideRequiredReasons");
  });

  it("carries connector_required and approval_required into describe", async () => {
    // The other direction: reasons about the connector's conventions and the
    // call's consequences are not facts about a rendered schema, so expanding
    // one settles nothing.
    const connector = api("generic", {
      usageGuide: {
        content: "# Generic API\n\nRead the operation documentation first.\n",
        summary: "Generic operation aliases and argument shapes.",
        required: true,
      },
      tools: [
        {
          name: "invoke",
          description: "Invoke a generic operation",
          inputSchema: { type: "object" },
          annotations: { readOnlyHint: false },
          handler: () => ({}),
        },
      ],
    });
    const described = await new CatalogService(
      makeRegistry([connector]),
      BASE,
    ).describe({ addresses: ["generic.invoke"] });
    const entry = required(described[0]);
    expect(entry.guide).toBe("connector:generic");
    expect(entry.guideRequired).toBe(true);
    expect(entry.guideRequiredReasons).toEqual([
      "connector_required",
      "approval_required",
    ]);
  });

  it("omits guideRequired from a search that asked for no schemas", async () => {
    // schema_truncated is a fact about a rendered schema; with none rendered
    // there is nothing to cap and nothing to report.
    const mt = createMetaTools(makeRegistry([wideGuided()]), BASE);
    const searched = textOf(await mt.searchTools({ query: "read" })) as {
      connectors: Array<{
        guide?: string;
        tools: Array<Record<string, unknown>>;
      }>;
    };
    const connector = required(searched.connectors[0]);
    expect(connector.guide).toBe("connector:wide");
    const tool = required(connector.tools[0]);
    expect(tool).not.toHaveProperty("inputSchemaTruncated");
    expect(tool).not.toHaveProperty("guideRequired");
    expect(tool).not.toHaveProperty("guideRequiredReasons");
  });
});

describe("stored credential drift", () => {
  it("refuses drifted credential reads", async () => {
    let tests = 0;
    const connector: Connector = connectorWith({
      id: "drift",
      kind: "api",
      description: "Drifted credential",
      credential: {
        label: "Service credential",
        fields: [
          { name: "apiKey", label: "API key" },
          { name: "accountId", label: "Account id" },
        ],
      },
      async testCredentials() {
        tests++;
        return { ok: true };
      },
      tools: [
          {
            name: "read",
            annotations: { readOnlyHint: true },
            inputSchema: { type: "object" },
          },
        ],
      call: async (_name, _args, ctx) => ctx.credential!.getAll(),
    });
    const storage = memoryStorage();
    const vault = new CredentialVault(storage, CREDENTIAL_KEY);
    await vault.setAll("drift", { apiKey: "old-key" }, "user_1");
    const registry = makeRegistry([connector], {
      storage,
      credentialVault: vault,
    });
    const mt = createMetaTools(registry, BASE);

    // The drift is observed without touching the connector: no test hook runs.
    expect(await registry.credentialDriftFor("drift")).toBe(
      STORED_CREDENTIAL_SHAPE_MISMATCH_ERROR,
    );
    expect(tests).toBe(0);

    const called = textOf(
      await mt.callTool({
        address: "drift.read",
        resultMode: "value",
      }),
    ) as { ok: boolean; error: { code: string; message: string } };
    expect(called).toMatchObject({
      ok: false,
      error: {
        code: "auth_required",
        message: STORED_CREDENTIAL_SHAPE_MISMATCH_ERROR,
      },
    });
  });
});

interface ObservedConnector {
  status: string;
  message?: string;
  lastSuccessAt?: string;
  consecutiveFailures: number;
}

/**
 * The health a connector's real calls left behind. Read straight off the
 * registry: the log has no meta-tool reader since #273 removed list_connectors,
 * but it is still what `InvocationService` writes on every attempt, and the
 * derived state below is the one every consumer of it has to compute.
 */
function observe(
  events: ToolCallActivityEvent[],
  id: string,
): ObservedConnector {
  const observed = events.filter((event) => event.connectorId === id);
  const last = observed.at(-1);
  const failures = [...observed].reverse().findIndex((event) => event.outcome === "success");
  const consecutiveFailures = last?.outcome === "success"
    ? 0
    : failures < 0
      ? observed.length
      : failures;
  return {
    status: !last ? "unknown" : last.outcome === "success" ? "ok" : "error",
    ...(last?.errorCode ? { message: last.errorCode } : {}),
    ...(last?.outcome === "success" ? { lastSuccessAt: last.occurredAt } : {}),
    consecutiveFailures,
  };
}

describe("catalog-lookup health accounting", () => {
  /** listTools fails while `state.failing`; callTool always succeeds. */
  function catalogFlaky(state: {
    failing: boolean;
    listCalls: number;
  }): Connector {
    return connectorWith({
      id: "catalog",
      kind: "mcp",
      tools: async () => {
        state.listCalls++;
        if (state.failing) throw new Error("catalog unavailable");
        return [{ name: "read", annotations: { readOnlyHint: true } }];
      },
      call: async () => ({ content: [{ type: "text", text: "read" }] }),
    });
  }

  it("counts a failing catalog like a failing execution, call for call", async () => {
    const state = { failing: true, listCalls: 0 };
    const executionBroken: Connector = connectorWith({
      id: "execution",
      kind: "mcp",
      tools: [{ name: "read", annotations: { readOnlyHint: true } }],
      call: async () => {
        throw new Error("downstream exploded");
      },
    });
    const registry = makeRegistry([catalogFlaky(state), executionBroken]);
    const activity = activitySink();
    const mt = createMetaTools(registry, BASE, { activity: activity.activity });
    for (let i = 0; i < 2; i++) {
      await mt.callTool({ address: "catalog.read", resultMode: "value" });
      await mt.callTool({ address: "execution.read", resultMode: "value" });
    }
    const catalog = observe(activity.events, "catalog");
    expect(catalog.consecutiveFailures).toBe(
      observe(activity.events, "execution").consecutiveFailures,
    );
    expect(catalog.consecutiveFailures).toBe(2);
    expect(catalog.status).toBe("error");
    expect(catalog.message).toBe("catalog_lookup_failed");
  });

  it("records a typed auth_required from the catalog without changing its code", async () => {
    const expired: Connector = connectorWith({
      id: "expired",
      kind: "mcp",
      tools: async () => {
        throw new ConnectorCallError(
          "auth_required",
          'Connector "expired" requires authorization — call authorize_connector({ connector: "expired" }).',
        );
      },
      call: async () => null,
    });
    const registry = makeRegistry([expired]);
    const activity = activitySink();
    const parsed = textOf(
      await createMetaTools(registry, BASE, { activity: activity.activity }).callTool({
        address: "expired.read",
        resultMode: "value",
      }),
    ) as { ok: boolean; error: { code: string; message: string } };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("auth_required");
    expect(parsed.error.message).toContain("authorize_connector");
    expect(observe(activity.events, "expired")).toMatchObject({
      status: "error",
      consecutiveFailures: 1,
    });
  });

  it("returns to healthy once the catalog answers again", async () => {
    const state = { failing: true, listCalls: 0 };
    const registry = makeRegistry([catalogFlaky(state)]);
    const activity = activitySink();
    const mt = createMetaTools(registry, BASE, { activity: activity.activity });
    await mt.callTool({ address: "catalog.read", resultMode: "value" });
    expect(observe(activity.events, "catalog").status).toBe("error");

    state.failing = false;
    const parsed = textOf(
      await mt.callTool({ address: "catalog.read", resultMode: "value" }),
    ) as { ok: boolean };
    expect(parsed.ok).toBe(true);
    const recovered = observe(activity.events, "catalog");
    expect(recovered.status).toBe("ok");
    expect(recovered.consecutiveFailures).toBe(0);
    expect(recovered.lastSuccessAt).toBeTruthy();
  });

  it("leaves health alone for static catalogs and warm-cache hits", async () => {
    const state = { failing: false, listCalls: 0 };
    const registry = makeRegistry([catalogFlaky(state), calcConnector]);
    const activity = activitySink();
    const mt = createMetaTools(registry, BASE, { activity: activity.activity });
    await mt.callTool({ address: "catalog.read", resultMode: "value" });
    // The cache is warm now, so a catalog that starts failing is never asked
    // again — and a cache hit is neither a failure nor evidence of health.
    state.failing = true;
    const parsed = textOf(
      await mt.callTool({ address: "catalog.read", resultMode: "value" }),
    ) as { ok: boolean };
    expect(parsed.ok).toBe(true);
    expect(state.listCalls).toBe(1);

    await mt.callTool({ address: "calc.add", args: { a: 1, b: 2 } });
    expect(observe(activity.events, "catalog")).toMatchObject({
      status: "ok",
      consecutiveFailures: 0,
    });
    expect(observe(activity.events, "calc")).toMatchObject({
      status: "ok",
      consecutiveFailures: 0,
    });
  });

  it("reports health observed from real generic tool calls", async () => {
    const registry = makeRegistry([calcConnector]);
    const activity = activitySink();
    await createMetaTools(registry, BASE, { activity: activity.activity }).callTool({
      address: "calc.add",
      args: { a: 1, b: 2 },
    });
    const observed = observe(activity.events, "calc");
    expect(observed.status).toBe("ok");
    expect(observed.lastSuccessAt).toBeTruthy();
    expect(observed.consecutiveFailures).toBe(0);
  });
});

describe("authorize_connector", () => {
  it("starts the flow and returns the authorization URL with instructions", async () => {
    authConnector.startAuthCalls.length = 0;
    const mt = createMetaTools(registry(), BASE);
    const parsed = textOf(
      await mt.authorizeConnector({ connector: "needsauth" }),
    ) as {
      connector: string;
      recovery: string;
      status: string;
      authorizationUrl?: string;
      instructions?: string;
    };
    expect(parsed.connector).toBe("needsauth");
    expect(parsed.recovery).toBe("oauth");
    expect(parsed.status).toBe("auth_required");
    expect(parsed.authorizationUrl).toContain("auth.example");
    expect(parsed.instructions).toContain("/oauth/callback/");
    expect(parsed.instructions).toContain("Then retry the original call");
    expect(parsed.instructions).toContain(
      'connecta.search({ connector: "needsauth" }) inside execute_code',
    );
    expect(authConnector.startAuthCalls).toEqual([{ force: undefined }]);
  });

  it("passes force through to the connector", async () => {
    authConnector.startAuthCalls.length = 0;
    const mt = createMetaTools(registry(), BASE);
    await mt.authorizeConnector({ connector: "needsauth", force: true });
    expect(authConnector.startAuthCalls).toEqual([{ force: true }]);
  });

  it("reports unavailable when a connector declares no recovery path", async () => {
    const mt = createMetaTools(registry(), BASE);
    const result = await mt.authorizeConnector({ connector: "calc" });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toMatchObject({
      connector: "calc",
      recovery: "unavailable",
    });
    expect(required(result.content[0]).text).toContain(
      "neither downstream OAuth nor an operator-managed credential slot",
    );
  });

  it("returns a secret-free operator handoff for a configured credential vault", async () => {
    const connector = api("static", {
      credential: {
        label: "Service credentials",
        description: "Credentials provisioned by the service operator.",
        fields: [
          {
            name: "email",
            label: "Account email",
            description: "The service account email.",
          },
          {
            name: "apiKey",
            label: "API key",
          },
        ],
      },
      tools: [],
    });
    const storage = memoryStorage();
    const vault = new CredentialVault(storage, CREDENTIAL_KEY);
    await vault.setAll(
      "static",
      {
        email: "operator@example.com",
        apiKey: "do-not-return-this-secret",
      },
      "user_1",
    );
    const result = await createMetaTools(
      makeRegistry([connector], { storage, credentialVault: vault }),
      BASE,
    ).authorizeConnector({ connector: "static", force: true });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toEqual({
      connector: "static",
      recovery: "operator_config",
      credential: {
        label: "Service credentials",
        fields: [
          { name: "email", guidance: "The service account email." },
          { name: "apiKey", guidance: "API key" },
        ],
      },
      operatorUrl: `${BASE}/credentials`,
      instructions:
        "Have the operator open operatorUrl, set and test the credential, " +
        "then retry the original call. No redeploy is needed. Credential " +
        "mutation requires a Clerk-authenticated operator.",
    });
    expect(required(result.content[0]).text).not.toContain(
      "do-not-return-this-secret",
    );
    expect(required(result.content[0]).text).not.toContain(
      "operator@example.com",
    );
  });

  it("reports unavailable when a declared credential has no vault", async () => {
    const connector = api("static", {
      credential: { label: "API key" },
      tools: [
        {
          name: "read",
          description: "Read a value",
          annotations: { readOnlyHint: true },
          handler: () => {
            throw new Error("the connector must not run without its vault");
          },
        },
      ],
    });
    const mt = createMetaTools(makeRegistry([connector]), BASE);
    const result = await mt.authorizeConnector({ connector: "static" });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toMatchObject({
      connector: "static",
      recovery: "unavailable",
    });
    expect(required(result.content[0]).text).toContain(
      "credentials.encryptionKey",
    );
    expect(
      textOf(
        await mt.callTool({
          address: "static.read",
          resultMode: "value",
        }),
      ),
    ).toMatchObject({
      ok: false,
      error: {
        code: "auth_required",
        connector: "static",
        operation: "static.read",
        recovery: "unavailable",
      },
    });
  });

  it("errors for an unknown connector", async () => {
    const mt = createMetaTools(registry(), BASE);
    const result = await mt.authorizeConnector({ connector: "ghost" });
    expect(result.isError).toBe(true);
    expect(required(result.content[0]).text).toContain("Unknown connector");
  });

  it("errors when startAuth reports auth_required without a URL", async () => {
    const noUrl: Connector = connectorWith({
      id: "nourl",
      kind: "mcp",
      tools: async () => {
        throw new Error("unauthorized");
      },
      call: async () => {
        throw new Error("unauthorized");
      },
      async startAuth() {
        return { state: "auth_required" };
      },
    });
    const mt = createMetaTools(makeRegistry([noUrl]), BASE);
    const result = await mt.authorizeConnector({ connector: "nourl" });
    expect(result.isError).toBe(true);
    expect(required(result.content[0]).text).toContain("no URL is available");
  });

  it("surfaces a startAuth error state as a structured error status (not isError)", async () => {
    const errConn: Connector = connectorWith({
      id: "erroauth",
      kind: "mcp",
      tools: async () => {
        throw new Error("x");
      },
      call: async () => {
        throw new Error("x");
      },
      async startAuth() {
        return { state: "error", message: "connect ECONNREFUSED" };
      },
    });
    const mt = createMetaTools(makeRegistry([errConn]), BASE);
    const result = await mt.authorizeConnector({ connector: "erroauth" });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(required(result.content[0]).text) as {
      status: string;
      message?: string;
    };
    expect(parsed.status).toBe("error");
    expect(parsed.message).toContain("ECONNREFUSED");
  });

  it("invalidates the tool cache even when startAuth throws", async () => {
    const throwConn: Connector = connectorWith({
      id: "throws",
      kind: "mcp",
      tools: async () => {
        throw new Error("x");
      },
      call: async () => {
        throw new Error("x");
      },
      async startAuth() {
        throw new Error("boom during force");
      },
    });
    const reg = makeRegistry([throwConn]);
    let invalidated = 0;
    const origInvalidateStored = reg.invalidateStored.bind(reg);
    reg.invalidateStored = async (id: string) => {
      invalidated++;
      await origInvalidateStored(id);
    };
    const mt = createMetaTools(reg, BASE);
    const result = await mt.authorizeConnector({ connector: "throws" });
    expect(result.isError).toBe(true);
    expect(invalidated).toBe(1);
  });

  // #261: the surface sweeps in test/code-first-surface.test.ts read tool
  // DESCRIPTIONS and instructions. A meta-tool RESULT is always-followed text
  // too — an agent handed "then call list_connectors" does exactly that, gets an
  // unknown-tool error, and has no route left. The OAuth handoff named a removed
  // tool once already, so every recovery string these handlers return is swept
  // here, at the one place results are produced.
  it("names no removed tool in any recovery payload it returns", async () => {
    const removed = ["list_connectors", "describe_tools", "batch_call"];
    const vaultStorage = memoryStorage();
    const configured = createMetaTools(
      makeRegistry([
        connectorWith({
          id: "vaulted",
          kind: "api",
          description: "Operator credential",
          credential: { label: "API key" },
          tools: [],
          call: async () => null,
        }),
      ], {
        storage: vaultStorage,
        credentialVault: new CredentialVault(vaultStorage, CREDENTIAL_KEY),
      }),
      BASE,
    );
    const mt = createMetaTools(registry(), BASE);
    const payloads = [
      // The OAuth handoff, which is where the regression happened.
      await mt.authorizeConnector({ connector: "needsauth" }),
      // The operator-credential handoff, and the two dead ends beside it.
      await configured.authorizeConnector({ connector: "vaulted" }),
      await mt.authorizeConnector({ connector: "calc" }),
      await mt.authorizeConnector({ connector: "ghost" }),
      // Recovery records an agent follows after a failed call.
      await mt.callTool({ address: "ghost.read_items" }),
      await mt.callTool({ address: "calc.missing_sum" }),
      await mt.searchTools({ query: "nothing matches this at all" }),
      await mt.skills({}),
      await mt.skills({ name: "usage" }),
      await mt.getResult({ id: "expired" }),
    ];

    for (const payload of payloads) {
      const serialized = JSON.stringify(payload);
      for (const tool of removed) {
        expect(serialized).not.toContain(tool);
      }
    }
  });
});

describe("probe timeout", () => {
  /** A connector whose downstream tool listing never resolves. */
  const hangingConnector: Connector = connectorWith({
    id: "hang",
    kind: "mcp",
    description: "Never resolves",
    tools: async () => new Promise<never>(() => {}),
    call: async () => {
      throw new Error("n/a");
    },
  });

  it("search_tools degrades a hung connector to unavailable within the timeout", async () => {
    const mt = createMetaTools(makeRegistry([hangingConnector, calcConnector]), BASE, {
      probeTimeoutMs: 50,
    });
    const started = Date.now();
    const parsed = textOf(
      await mt.searchTools({ query: "add impossible" }),
    ) as SearchResult;
    // Returns rather than hanging: the healthy connector still resolves, the
    // hung one is simply absent (its rejected catalog is dropped).
    expect(Date.now() - started).toBeLessThan(2_000);
    const ids = parsed.connectors.map((c) => c.id);
    expect(ids).toContain("calc");
    expect(ids).not.toContain("hang");
    expect(parsed.queryAnalysis).toMatchObject({
      unavailableConnectorCount: 1,
      unmatchedTerms: ["impossible"],
      guidance: expect.stringContaining("catalogs that answered"),
    });

    const scoped = textOf(
      await mt.searchTools({
        connector: "hang",
        query: "impossible",
      }),
    ) as SearchResult;
    expect(scoped.queryAnalysis).toMatchObject({
      connectorScope: "hang",
      unavailableConnectorCount: 1,
      catalogError: {
        code: "timeout",
        retryable: true,
      },
      guidance: expect.stringContaining(
        'Connector "hang" could not be searched',
      ),
    });
    expect(required(scoped.queryAnalysis).guidance).not.toContain(
      "No matching capability",
    );
  });

  it("returns a bounded typed catalog failure only for an explicit connector scope", async () => {
    const typed: Connector = connectorWith({
      id: "billing",
      kind: "api",
      tools: async () => {
        throw new ConnectorCallError(
          "unavailable",
          `Upstream returned 503. Operator must restore access. ${"x".repeat(1_000)}`,
          { retryAfterMs: 30_000 },
        );
      },
      call: async () => null,
    });
    const mt = createMetaTools(makeRegistry([typed, calcConnector]), BASE);
    const scoped = textOf(
      await mt.searchTools({
        connector: "billing",
        query: "list invoices",
      }),
    ) as SearchResult;
    expect(scoped.queryAnalysis).toMatchObject({
      unavailableConnectorCount: 1,
      catalogError: {
        code: "unavailable",
        retryable: true,
        retryAfterMs: 30_000,
      },
    });
    const catalogError = required(required(scoped.queryAnalysis).catalogError);
    expect(catalogError.message).toContain(
      "Upstream returned 503. Operator must restore access.",
    );
    expect(catalogError.message).toMatch(/…$/);
    expect(Buffer.byteLength(catalogError.message)).toBeLessThanOrEqual(515);
    // Pinned, not spread: the call-path classifier may grow connector,
    // operation, recovery, or nextAction fields, and none of them belong on a
    // discovery read.
    expect(Object.keys(catalogError).sort()).toEqual([
      "code",
      "message",
      "retryAfterMs",
      "retryable",
    ]);

    const unscoped = textOf(
      await mt.searchTools({ query: "add impossible" }),
    ) as SearchResult;
    expect(required(unscoped.queryAnalysis).unavailableConnectorCount).toBe(1);
    expect(required(unscoped.queryAnalysis).catalogError).toBeUndefined();
  });
});

describe("empty-query browse of an unavailable catalog", () => {
  /** A connector with a guide whose catalog never resolves. */
  const unavailable = (): Connector => (connectorWith({
    id: "billing",
    kind: "api",
    usageGuide: {
      content: "# Billing\n\nInvoice ids are prefixed.\n",
      summary: "Invoice ids are prefixed.",
      required: true,
    },
    tools: async () => {
      throw new ConnectorCallError(
        "unavailable",
        "Upstream returned 503. Operator must restore access.",
        { retryAfterMs: 30_000 },
      );
    },
    call: async () => null,
  }));

  /** A connector that answers, correctly, with nothing. */
  const barren: Connector = connectorWith({
    id: "barren",
    kind: "api",
    tools: [],
    call: async () => null,
  });

  it("reports the failure and its recovery detail for a scoped browse", async () => {
    const mt = createMetaTools(
      makeRegistry([unavailable(), calcConnector]),
      BASE,
    );
    const browsed = textOf(
      await mt.searchTools({ connector: "billing", query: "" }),
    ) as SearchResult;
    expect(browsed.connectors).toEqual([]);
    const analysis = required(browsed.queryAnalysis);
    // No terms were supplied, so the term partitions say nothing — the failure
    // fields carry the whole message.
    expect(analysis.representedTerms).toEqual([]);
    expect(analysis.otherResultTerms).toEqual([]);
    expect(analysis.unmatchedTerms).toEqual([]);
    expect(analysis).toMatchObject({
      connectorScope: "billing",
      unavailableConnectorCount: 1,
      catalogError: {
        code: "unavailable",
        retryable: true,
        retryAfterMs: 30_000,
      },
      guidance: expect.stringContaining(
        'Connector "billing" could not be browsed',
      ),
    });
    expect(required(analysis.catalogError).message).toContain(
      "Upstream returned 503. Operator must restore access.",
    );
    // Same bounded shape the term-bearing scoped path returns.
    expect(Object.keys(required(analysis.catalogError)).sort()).toEqual([
      "code",
      "message",
      "retryAfterMs",
      "retryable",
    ]);
    // The recovery owner stays reachable: a browse that failed still names the
    // connector's guide, as a scoped miss with terms does.
    expect(analysis).toMatchObject({
      guide: "connector:billing",
      guideSummary: "Invoice ids are prefixed.",
      guideRequired: true,
      guideRequiredReasons: ["connector_required"],
    });
  });

  it("keeps an unscoped browse to the count alone", async () => {
    const mt = createMetaTools(
      makeRegistry([unavailable(), calcConnector]),
      BASE,
    );
    const browsed = textOf(await mt.searchTools({ query: "" })) as SearchResult;
    // The healthy connector still browses.
    expect(browsed.connectors.map((group) => group.id)).toEqual(["calc"]);
    const analysis = required(browsed.queryAnalysis);
    expect(analysis.unavailableConnectorCount).toBe(1);
    expect(analysis.catalogError).toBeUndefined();
    expect(analysis.guide).toBeUndefined();
    expect(required(analysis.guidance)).toContain("browse is incomplete");
    expect(JSON.stringify(browsed)).not.toContain("503");
  });

  it("distinguishes an unavailable catalog from a genuinely empty one", async () => {
    const mt = createMetaTools(makeRegistry([unavailable(), barren]), BASE);
    const empty = textOf(
      await mt.searchTools({ connector: "barren", query: "" }),
    ) as SearchResult;
    const broken = textOf(
      await mt.searchTools({ connector: "billing", query: "" }),
    ) as SearchResult;
    // Both return no entries, and that is where the resemblance ends.
    expect(empty.connectors).toEqual([]);
    expect(broken.connectors).toEqual([]);
    expect(empty.queryAnalysis).toBeUndefined();
    expect(required(broken.queryAnalysis).catalogError).toBeDefined();
    expect(JSON.stringify(empty)).not.toEqual(JSON.stringify(broken));
  });

  it("leaves an available scoped browse unchanged", async () => {
    const mt = createMetaTools(makeRegistry([calcConnector]), BASE);
    const browsed = textOf(
      await mt.searchTools({ connector: "calc", query: "" }),
    ) as SearchResult;
    expect(browsed.connectors.map((group) => group.id)).toEqual(["calc"]);
    expect(browsed.total).toBeGreaterThan(0);
    expect(browsed.queryAnalysis).toBeUndefined();
  });
});

describe("empty-query browse of an unconfigured connector", () => {
  /** A configured connector that answers, correctly, with nothing. */
  const barren: Connector = connectorWith({
    id: "barren",
    kind: "api",
    tools: [],
    call: async () => null,
  });

  it("names the unknown id and the way out on a scoped browse", async () => {
    const mt = createMetaTools(makeRegistry([calcConnector]), BASE);
    const browsed = textOf(
      await mt.searchTools({ connector: "ghost", query: "" }),
    ) as SearchResult;
    expect(browsed.connectors).toEqual([]);
    expect(browsed.total).toBe(0);
    const analysis = required(browsed.queryAnalysis);
    // No terms were supplied, so the term partitions say nothing — the scope
    // fields carry the whole message, exactly as on the unavailable path.
    expect(analysis.representedTerms).toEqual([]);
    expect(analysis.otherResultTerms).toEqual([]);
    expect(analysis.unmatchedTerms).toEqual([]);
    expect(analysis).toMatchObject({
      connectorScope: "ghost",
      unknownConnector: true,
      guidance:
        'Connector "ghost" is not configured in this deployment. Omit connector to search all configured tools.',
    });
    // Nothing failed, because nothing was attempted.
    expect(analysis.unavailableConnectorCount).toBeUndefined();
    expect(analysis.catalogError).toBeUndefined();
    expect(analysis.guide).toBeUndefined();
  });

  it("gives the browse the same recovery advice the term-bearing path gives", async () => {
    const mt = createMetaTools(makeRegistry([calcConnector]), BASE);
    const browsed = textOf(
      await mt.searchTools({ connector: "ghost", query: "" }),
    ) as SearchResult;
    const searched = textOf(
      await mt.searchTools({ connector: "ghost", query: "add numbers" }),
    ) as SearchResult;
    expect(required(browsed.queryAnalysis).guidance).toEqual(
      required(searched.queryAnalysis).guidance,
    );
    expect(required(searched.queryAnalysis)).toMatchObject({
      connectorScope: "ghost",
      unknownConnector: true,
    });
    // The term-bearing path still analyses its terms; the browse still does not.
    expect(required(searched.queryAnalysis).unmatchedTerms).toEqual([
      "add",
      "numbers",
    ]);
    expect(required(browsed.queryAnalysis).unmatchedTerms).toEqual([]);
  });

  it("does not name the connectors the caller did not ask about", async () => {
    const mt = createMetaTools(makeRegistry([calcConnector, barren]), BASE);
    const browsed = textOf(
      await mt.searchTools({ connector: "ghost", query: "" }),
    ) as SearchResult;
    const serialized = JSON.stringify(browsed);
    expect(serialized).not.toContain("calc");
    expect(serialized).not.toContain("barren");
  });

  it("distinguishes an unknown id from a configured connector with no tools", async () => {
    const mt = createMetaTools(makeRegistry([barren]), BASE);
    const empty = textOf(
      await mt.searchTools({ connector: "barren", query: "" }),
    ) as SearchResult;
    const unknown = textOf(
      await mt.searchTools({ connector: "ghost", query: "" }),
    ) as SearchResult;
    // Both return no entries, and that is where the resemblance ends.
    expect(empty.connectors).toEqual([]);
    expect(unknown.connectors).toEqual([]);
    // A connector that correctly exposes nothing invents no analysis.
    expect(empty.queryAnalysis).toBeUndefined();
    expect(required(unknown.queryAnalysis).unknownConnector).toBe(true);
    expect(JSON.stringify(empty)).not.toEqual(JSON.stringify(unknown));
  });

  it("treats a case variant of a configured id as unknown, as the resolver does", async () => {
    const mt = createMetaTools(makeRegistry([calcConnector]), BASE);
    const browsed = textOf(
      await mt.searchTools({ connector: "CALC", query: "" }),
    ) as SearchResult;
    expect(required(browsed.queryAnalysis)).toMatchObject({
      connectorScope: "CALC",
      unknownConnector: true,
      guidance: expect.stringContaining(
        'Connector "CALC" is not configured in this deployment',
      ),
    });
  });

  it("leaves a configured scoped browse and every unscoped browse unchanged", async () => {
    const mt = createMetaTools(makeRegistry([calcConnector]), BASE);
    const scoped = textOf(
      await mt.searchTools({ connector: "calc", query: "" }),
    ) as SearchResult;
    expect(scoped.connectors.map((group) => group.id)).toEqual(["calc"]);
    expect(scoped.total).toBeGreaterThan(0);
    expect(scoped.queryAnalysis).toBeUndefined();
    const unscoped = textOf(await mt.searchTools({ query: "" })) as SearchResult;
    expect(unscoped.connectors.map((group) => group.id)).toEqual(["calc"]);
    expect(unscoped.queryAnalysis).toBeUndefined();
  });
});
