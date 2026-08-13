import { describe, expect, it } from "vitest";
import { specTypeSchemas } from "@modelcontextprotocol/client";
import { api } from "../src/connectors/api.js";
import {
  compactDiscoverySchema,
  compactSchema,
  MAX_COMPACT_DISCOVERY_SCHEMA_BYTES,
} from "../src/catalog.js";
import { CatalogService } from "../src/catalog-service.js";
import {
  CredentialVault,
  STORED_CREDENTIAL_SHAPE_MISMATCH_ERROR,
} from "../src/credentials.js";
import { ConnectorCallError } from "../src/errors.js";
import {
  alignEndToCharBoundary,
  alignStartToCharBoundary,
  createMetaTools,
  jsonResult,
  MAX_DISCOVERY_RESULT_BYTES,
  MAX_RETRY_BACKOFF_MS,
  MAX_SEARCH_LIMIT,
  retryBackoffMs,
} from "../src/meta-tools.js";
import { Registry } from "../src/registry.js";
import { USAGE_SKILL } from "../src/skills.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { Connector } from "../src/types.js";
import { required,
  authConnector,
  brokenConnector,
  calcConnector,
  makeRegistry,
  remoteConnector,
  silentLogger,
} from "./helpers.js";

const BASE = "https://connecta.test";
const CREDENTIAL_KEY = Buffer.alloc(32, 11).toString("base64");

function textOf(result: { content: { text: string }[] }): unknown {
  return JSON.parse(required(result.content[0]).text);
}

function expectStructurallyCompleteTypeShape(text: string): void {
  const pairs = new Map([
    ["}", "{"],
    ["]", "["],
    [")", "("],
  ]);
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const char of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{" || char === "[" || char === "(") {
      stack.push(char);
    } else {
      const opener = pairs.get(char);
      if (opener) expect(stack.pop()).toBe(opener);
    }
  }
  expect(inString).toBe(false);
  expect(stack).toEqual([]);
  expect(text).not.toContain("\uFFFD");
}

function registry() {
  return makeRegistry([
    calcConnector,
    remoteConnector,
    brokenConnector,
    authConnector,
  ]);
}

describe("structured result compatibility", () => {
  it("keeps structuredContent canonical and content complete but compact", () => {
    const value = {
      connectors: [
        { id: "calc", tools: [{ address: "calc.add", score: 1 }] },
      ],
      total: 1,
    };
    const result = jsonResult(value);

    // A content-only client keeps the complete result.
    const contentOnly = JSON.parse(required(result.content[0]).text);
    expect(contentOnly).toEqual(value);
    // A structured-aware client receives the original full-fidelity object.
    expect(result.structuredContent).toBe(value);
    // A mixed consumer sees equivalent representations without indentation.
    expect(contentOnly).toEqual(result.structuredContent);
    expect(required(result.content[0]).text).toBe(JSON.stringify(value));
    expect(required(result.content[0]).text).not.toContain("\n");
  });

  it("uses the same compact policy for discovery results", async () => {
    const result = await createMetaTools(
      makeRegistry([calcConnector]),
      BASE,
    ).searchTools({ query: "add", includeSchemas: "compact" });
    expect(required(result.content[0]).text).toBe(
      JSON.stringify(result.structuredContent),
    );
  });
});

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

  it("summarizes a guide with no heading from its first meaningful line", async () => {
    const mt = createMetaTools(
      makeRegistry([guided("linear", "- Use `linear.search_issues` first.\n")]),
      BASE,
    );
    expect(textFrom(await mt.skills({}))).toContain(
      "`connector:linear` — Use `linear.search_issues` first.",
    );
  });

  it("skips opening markup when picking the summary line", async () => {
    const cases: Array<[string, string, string]> = [
      ["fence", "```json\n{ \"a\": 1 }\n```\n\nUse `x.search`.\n", "Use `x.search`."],
      ["frontmatter", "---\ntitle: ignored\n---\n\n# Real heading\n", "Real heading"],
      ["bare-hash", "#\n\nUse the search tool.\n", "Use the search tool."],
      ["bare-hashes", "###\n\nUse the search tool.\n", "Use the search tool."],
      ["unspaced-heading", "#Heading text\n", "Heading text"],
      ["html-comment", "<!-- generated -->\n\n# Real heading\n", "Real heading"],
      ["table", "| a | b |\n| - | - |\n\n# Real heading\n", "Real heading"],
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

  it("truncates a summary line only past 120 characters", async () => {
    const exact = "a".repeat(120);
    const over = "b".repeat(121);
    const mt = createMetaTools(
      makeRegistry([guided("exact", exact), guided("over", over)]),
      BASE,
    );
    const listed = textFrom(await mt.skills({}));
    expect(listed).toContain(`\`connector:exact\` — ${exact}`);
    expect(listed).toContain(`\`connector:over\` — ${"b".repeat(119)}…`);
    expect(listed).not.toContain("b".repeat(120));
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

  it("uses an explicit bounded summary while returning structured guide content verbatim", async () => {
    const content = "# Cloud API\n\nResolve operation aliases before calling.\n";
    const mt = createMetaTools(
      makeRegistry([
        guided("cloud", {
          content,
          summary:
            "  Generic API aliases, argument units, and pagination.   " +
            "x".repeat(120),
        }),
      ]),
      BASE,
    );
    const listed = textFrom(await mt.skills({}));
    expect(listed).toContain(
      "`connector:cloud` — Generic API aliases, argument units, and pagination.",
    );
    expect(listed).toContain("…");
    expect(textFrom(await mt.skills({ name: "connector:cloud" }))).toBe(
      content,
    );
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
    expect(textFrom(fetched)).not.toContain("## Examples");
    expect(textFrom(fetched)).not.toContain("crm.get_account");
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
    expect(new TextEncoder().encode(expected).length).toBeLessThan(3_500);
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
    const connector: Connector = {
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
      async listTools() {
        return [
          {
            name: "read",
            annotations: { readOnlyHint: true },
            inputSchema: { type: "object" },
          },
        ];
      },
      async callTool(_name, _args, ctx) {
        return ctx.credential!.getAll();
      },
    };
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
  registry: ReturnType<typeof makeRegistry>,
  id: string,
): ObservedConnector {
  const health = registry.healthFor(id);
  return {
    status:
      health?.consecutiveFailures && health.consecutiveFailures > 0
        ? "error"
        : registry.hasObservedSuccess(id)
          ? "ok"
          : "unknown",
    ...(health?.lastError ? { message: health.lastError } : {}),
    ...(health?.lastSuccessAt ? { lastSuccessAt: health.lastSuccessAt } : {}),
    consecutiveFailures: health?.consecutiveFailures ?? 0,
  };
}

describe("catalog-lookup health accounting", () => {
  /** listTools fails while `state.failing`; callTool always succeeds. */
  function catalogFlaky(state: {
    failing: boolean;
    listCalls: number;
  }): Connector {
    return {
      id: "catalog",
      kind: "mcp",
      async listTools() {
        state.listCalls++;
        if (state.failing) throw new Error("catalog unavailable");
        return [{ name: "read", annotations: { readOnlyHint: true } }];
      },
      async callTool() {
        return { content: [{ type: "text", text: "read" }] };
      },
    };
  }

  it("counts a failing catalog like a failing execution, call for call", async () => {
    const state = { failing: true, listCalls: 0 };
    const executionBroken: Connector = {
      id: "execution",
      kind: "mcp",
      async listTools() {
        return [{ name: "read", annotations: { readOnlyHint: true } }];
      },
      async callTool() {
        throw new Error("downstream exploded");
      },
    };
    const registry = makeRegistry([catalogFlaky(state), executionBroken]);
    const mt = createMetaTools(registry, BASE);
    for (let i = 0; i < 2; i++) {
      await mt.callTool({ address: "catalog.read", resultMode: "value" });
      await mt.callTool({ address: "execution.read", resultMode: "value" });
    }
    const catalog = observe(registry, "catalog");
    expect(catalog.consecutiveFailures).toBe(
      observe(registry, "execution").consecutiveFailures,
    );
    expect(catalog.consecutiveFailures).toBe(2);
    expect(catalog.status).toBe("error");
    expect(catalog.message).toContain("catalog unavailable");
  });

  it("records a typed auth_required from the catalog without changing its code", async () => {
    const expired: Connector = {
      id: "expired",
      kind: "mcp",
      async listTools() {
        throw new ConnectorCallError(
          "auth_required",
          'Connector "expired" requires authorization — call authorize_connector({ connector: "expired" }).',
        );
      },
      async callTool() {
        return null;
      },
    };
    const registry = makeRegistry([expired]);
    const parsed = textOf(
      await createMetaTools(registry, BASE).callTool({
        address: "expired.read",
        resultMode: "value",
      }),
    ) as { ok: boolean; error: { code: string; message: string } };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("auth_required");
    expect(parsed.error.message).toContain("authorize_connector");
    expect(observe(registry, "expired")).toMatchObject({
      status: "error",
      consecutiveFailures: 1,
    });
  });

  it("returns to healthy once the catalog answers again", async () => {
    const state = { failing: true, listCalls: 0 };
    const registry = makeRegistry([catalogFlaky(state)]);
    const mt = createMetaTools(registry, BASE);
    await mt.callTool({ address: "catalog.read", resultMode: "value" });
    expect(observe(registry, "catalog").status).toBe("error");

    state.failing = false;
    const parsed = textOf(
      await mt.callTool({ address: "catalog.read", resultMode: "value" }),
    ) as { ok: boolean };
    expect(parsed.ok).toBe(true);
    const recovered = observe(registry, "catalog");
    expect(recovered.status).toBe("ok");
    expect(recovered.consecutiveFailures).toBe(0);
    expect(recovered.lastSuccessAt).toBeTruthy();
  });

  it("leaves health alone for static catalogs and warm-cache hits", async () => {
    const state = { failing: false, listCalls: 0 };
    const registry = makeRegistry([catalogFlaky(state), calcConnector]);
    const mt = createMetaTools(registry, BASE);
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
    expect(observe(registry, "catalog")).toMatchObject({
      status: "ok",
      consecutiveFailures: 0,
    });
    expect(observe(registry, "calc")).toMatchObject({
      status: "ok",
      consecutiveFailures: 0,
    });
  });

  it("reports health observed from real generic tool calls", async () => {
    const registry = makeRegistry([calcConnector]);
    await createMetaTools(registry, BASE).callTool({
      address: "calc.add",
      args: { a: 1, b: 2 },
    });
    const observed = observe(registry, "calc");
    expect(observed.status).toBe("ok");
    expect(observed.lastSuccessAt).toBeTruthy();
    expect(observed.consecutiveFailures).toBe(0);
  });
});

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

describe("search_tools", () => {
  it("uses the default bound for catalog fan-out and preserves all results", async () => {
    let active = 0;
    let maxActive = 0;
    const connectors = Array.from(
      { length: 9 },
      (_, index): Connector => ({
        id: `search_${index}`,
        kind: "mcp",
        description: `Search ${index}`,
        async listTools() {
          active++;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active--;
          return [
            {
              name: `read_${index}`,
              description: "Read matching data",
            },
          ];
        },
        async callTool() {
          return null;
        },
      }),
    );
    const result = textOf(
      await createMetaTools(makeRegistry(connectors), BASE).searchTools({
        query: "matching",
        limit: 20,
      }),
    ) as { total: number };
    expect(result.total).toBe(9);
    expect(maxActive).toBe(4);
  });

  it("substring-matches over name + description, grouped by connector", async () => {
    const mt = createMetaTools(registry(), BASE);
    const parsed = textOf(
      await mt.searchTools({ query: "echo" }),
    ) as SearchResult;
    // A single matching tool → a single connector group.
    expect(parsed.connectors).toHaveLength(1);
    expect(required(parsed.connectors[0]).id).toBe("remote");
    expect(required(parsed.connectors[0]).tools.map((t) => t.address)).toEqual([
      "remote.echo",
    ]);
    expect(parsed.total).toBe(1);
  });

  it("empty query browses all healthy tools grouped per connector (broken skipped)", async () => {
    const mt = createMetaTools(registry(), BASE);
    const parsed = textOf(await mt.searchTools({})) as SearchResult;
    const whitespace = textOf(
      await mt.searchTools({ query: " \n\t " }),
    ) as SearchResult;
    // Two healthy connectors with matches → two groups; broken is skipped.
    expect(parsed.connectors.map((c) => c.id).sort()).toEqual([
      "calc",
      "remote",
    ]);
    const byId = Object.fromEntries(parsed.connectors.map((c) => [c.id, c]));
    expect(required(byId.calc).tools.map((t) => t.address)).toEqual(["calc.add"]);
    expect(required(byId.remote).tools.map((t) => t.address)).toEqual(["remote.echo"]);
    expect(parsed.total).toBe(2);
    expect(whitespace).toEqual(parsed);
  });

  it("does not turn a non-empty Unicode-only query into a browse", async () => {
    const query = "界".repeat(80);
    const parsed = textOf(
      await createMetaTools(
        makeRegistry([calcConnector, remoteConnector]),
        BASE,
      ).searchTools({ query }),
    ) as SearchResult;

    expect(parsed).toMatchObject({
      connectors: [],
      total: 0,
      hasMore: false,
      queryAnalysis: {
        representedTerms: [],
        otherResultTerms: [],
        unmatchedTerms: [`${"界".repeat(63)}…`],
        truncated: true,
        guidance: expect.stringContaining("no searchable lexical terms"),
      },
    });
    expect(parsed.matchMode).toBeUndefined();
    expect(
      new TextEncoder().encode(JSON.stringify(parsed.queryAnalysis)).length,
    ).toBeLessThan(1_600);
  });

  it("clips non-BMP no-match analysis by Unicode code point", async () => {
    const parsed = textOf(
      await createMetaTools(
        makeRegistry([calcConnector, remoteConnector]),
        BASE,
      ).searchTools({ query: "😀".repeat(80) }),
    ) as SearchResult;
    const unmatched = required(
      required(parsed.queryAnalysis).unmatchedTerms[0],
    );

    expect(parsed.connectors).toEqual([]);
    expect(unmatched).toBe(`${"😀".repeat(63)}…`);
    expect([...unmatched]).toHaveLength(64);
    expect(required(parsed.queryAnalysis).truncated).toBe(true);
  });

  it("uses searchable ASCII terms from a mixed Unicode query", async () => {
    const parsed = textOf(
      await createMetaTools(
        makeRegistry([calcConnector, remoteConnector]),
        BASE,
      ).searchTools({ query: `${"界".repeat(80)} add` }),
    ) as SearchResult;
    const tools = parsed.connectors.flatMap((group) => group.tools);

    expect(tools).toHaveLength(1);
    expect(required(tools[0])).toMatchObject({
      address: "calc.add",
    });
    expect(required(tools[0])).not.toHaveProperty("queryCoverage");
    expect(required(tools[0])).not.toHaveProperty("score");
    expect(parsed.queryAnalysis).toBeUndefined();
  });

  it("filters discovery with the same fail-closed safety classification as invocation", async () => {
    const classified: Connector = {
      id: "classified",
      kind: "api",
      staticTools: [
        {
          name: "explicit_read",
          annotations: { readOnlyHint: true },
        },
        {
          name: "explicit_read_non_destructive",
          annotations: { readOnlyHint: true, destructiveHint: false },
        },
        {
          name: "explicit_write",
          annotations: { readOnlyHint: false, destructiveHint: false },
        },
        { name: "missing" },
        {
          name: "contradictory",
          annotations: { readOnlyHint: true, destructiveHint: true },
        },
      ],
      async listTools() {
        return [];
      },
      async callTool(name) {
        return name;
      },
    };
    const mt = createMetaTools(makeRegistry([classified]), BASE);
    const addresses = async (
      safety?: "readOnly" | "approvalRequired" | "all",
    ) => {
      const page = textOf(
        await mt.searchTools({ ...(safety ? { safety } : {}), limit: 10 }),
      ) as SearchResult;
      return page.connectors.flatMap((group) =>
        group.tools.map((tool) => tool.address),
      );
    };

    expect(await addresses("readOnly")).toEqual([
      "classified.explicit_read",
      "classified.explicit_read_non_destructive",
    ]);
    expect(await addresses("approvalRequired")).toEqual([
      "classified.explicit_write",
      "classified.missing",
      "classified.contradictory",
    ]);
    expect(await addresses()).toEqual(await addresses("all"));
    expect(await addresses()).toHaveLength(5);

    for (const address of await addresses("readOnly")) {
      expect((await mt.callTool({ address })).isError).toBeFalsy();
    }
    for (const address of await addresses("approvalRequired")) {
      const result = await mt.callTool({ address });
      expect(result.isError).toBe(true);
      expect(required(result.content[0]).text).toContain(
        "not explicitly read-only",
      );
    }
  });

  it("explains an empty safety-filtered result without hiding the complete catalog", async () => {
    const writeOnly: Connector = {
      id: "write_only",
      staticTools: [{ name: "create", annotations: { readOnlyHint: false } }],
      async listTools() {
        return [];
      },
      async callTool() {
        return {};
      },
    };
    const mt = createMetaTools(makeRegistry([writeOnly]), BASE);
    const filtered = textOf(
      await mt.searchTools({
        query: "create",
        safety: "readOnly",
      }),
    ) as SearchResult;
    expect(filtered.total).toBe(0);
    expect(filtered.queryAnalysis?.guidance).toContain(
      "No matching read-only capability",
    );
    expect(filtered.queryAnalysis?.guidance).toContain(
      "Change safety to inspect the other tools.",
    );

    const complete = textOf(
      await mt.searchTools({ query: "create" }),
    ) as SearchResult;
    expect(complete.connectors.flatMap((group) => group.tools)).toHaveLength(1);
  });

  it("respects the connector filter → a single group", async () => {
    const mt = createMetaTools(registry(), BASE);
    const parsed = textOf(
      await mt.searchTools({ connector: "calc" }),
    ) as SearchResult;
    expect(parsed.connectors).toHaveLength(1);
    expect(required(parsed.connectors[0]).id).toBe("calc");
    expect(required(parsed.connectors[0]).tools.map((t) => t.address)).toEqual([
      "calc.add",
    ]);
    expect(parsed.total).toBe(1);
  });

  it("does not load unrelated catalogs for a connector-scoped search", async () => {
    const loads = { wanted: 0, unrelated: 0 };
    const dynamic = (id: keyof typeof loads): Connector => ({
      id,
      kind: "mcp",
      async listTools() {
        loads[id]++;
        return [{ name: "read", description: `Read ${id} data` }];
      },
      async callTool() {
        return null;
      },
    });
    const mt = createMetaTools(
      makeRegistry([dynamic("wanted"), dynamic("unrelated")]),
      BASE,
    );

    const parsed = textOf(
      await mt.searchTools({ query: "read", connector: "wanted" }),
    ) as SearchResult;

    expect(parsed.connectors.map((group) => group.id)).toEqual(["wanted"]);
    expect(loads).toEqual({ wanted: 1, unrelated: 0 });
  });

  it("paginates results while reporting the full match count", async () => {
    const mt = createMetaTools(registry(), BASE);
    const parsed = textOf(await mt.searchTools({ limit: 1 })) as SearchResult;
    expect(parsed.total).toBe(2);
    expect(parsed.hasMore).toBe(true);
    expect(parsed.nextOffset).toBe(1);
    const shown = parsed.connectors.flatMap((c) => c.tools);
    expect(shown).toHaveLength(1);

    const next = textOf(
      await mt.searchTools({
        limit: 1,
        offset: required(parsed.nextOffset),
      }),
    ) as SearchResult;
    expect(next.total).toBe(2);
    expect(next.offset).toBe(1);
    expect(next.hasMore).toBe(false);
    expect(next.connectors.flatMap((c) => c.tools)).toHaveLength(1);
  });

  it("defaults to eight results and preserves the remaining page", async () => {
    const connector: Connector = {
      id: "default_page",
      staticTools: Array.from({ length: 12 }, (_, index) => ({
        name: `read_${String(index).padStart(2, "0")}`,
        description: "Read a deterministic item",
      })),
      async listTools() {
        return [];
      },
      async callTool() {
        return null;
      },
    };
    const mt = createMetaTools(makeRegistry([connector]), BASE);
    const first = textOf(await mt.searchTools({})) as SearchResult;

    expect(first.limit).toBe(8);
    expect(first.total).toBe(12);
    expect(first.connectors.flatMap((group) => group.tools)).toHaveLength(8);
    expect(
      first.connectors.flatMap((group) => group.tools)[0],
    ).not.toHaveProperty("queryCoverage");
    expect(first.nextOffset).toBe(8);

    const second = textOf(
      await mt.searchTools({ offset: required(first.nextOffset) }),
    ) as SearchResult;
    expect(second.limit).toBe(8);
    expect(second.connectors.flatMap((group) => group.tools)).toHaveLength(4);
    expect(second.hasMore).toBe(false);
  });

  it("bounds page size before loading or ranking a catalog", async () => {
    let loads = 0;
    const tools = Array.from({ length: MAX_SEARCH_LIMIT }, (_, i) => ({
      name: `tool-${i}`,
    }));
    const connector: Connector = {
      id: "large",
      async listTools() {
        loads++;
        return tools;
      },
      async callTool() {
        return null;
      },
    };
    const mt = createMetaTools(makeRegistry([connector]), BASE);

    for (const limit of [MAX_SEARCH_LIMIT - 1, MAX_SEARCH_LIMIT]) {
      const result = await mt.searchTools({ limit });
      expect(result.isError).toBeFalsy();
      const parsed = textOf(result) as SearchResult;
      expect(parsed.connectors.flatMap((group) => group.tools)).toHaveLength(
        limit,
      );
    }
    expect(loads).toBe(1);

    for (const limit of [MAX_SEARCH_LIMIT + 1, Number.MAX_SAFE_INTEGER]) {
      const result = await createMetaTools(
        makeRegistry([connector]),
        BASE,
      ).searchTools({ limit });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatchObject({
        error: { code: "invalid_args", retryable: false },
      });
    }
    // The rejected calls never reached listTools.
    expect(loads).toBe(1);
  });

  it("keeps default and maximum result pages coverage-free", async () => {
    const terms = Array.from(
      { length: 8 },
      (_, index) => `${index}${"x".repeat(79)}`,
    );
    const connector: Connector = {
      id: "coverage_budget",
      staticTools: Array.from({ length: MAX_SEARCH_LIMIT }, (_, index) => ({
        name: `read_${String(index).padStart(3, "0")}`,
        description: terms.join(" "),
      })),
      async listTools() {
        return [];
      },
      async callTool() {
        return null;
      },
    };
    const mt = createMetaTools(makeRegistry([connector]), BASE);
    for (const limit of [undefined, MAX_SEARCH_LIMIT]) {
      const result = await mt.searchTools({
        query: terms.join(" "),
        ...(limit === undefined ? {} : { limit }),
      });
      const parsed = textOf(result) as SearchResult;
      const tools = parsed.connectors.flatMap((group) => group.tools);

      expect(tools).toHaveLength(limit ?? 8);
      expect(tools.every((tool) => !("queryCoverage" in tool))).toBe(true);
      expect(tools.every((tool) => !("score" in tool))).toBe(true);
      const responseBytes = new TextEncoder().encode(
        required(result.content[0]).text,
      ).length;
      expect(responseBytes).toBeLessThan(
        limit === undefined ? 10_000 : 100_000,
      );
      expect(responseBytes).toBeLessThan(MAX_DISCOVERY_RESULT_BYTES);
    }
  });

  it("keeps 100,000-tool pagination exact at the first, middle, and final page", async () => {
    const total = 100_000;
    const connector: Connector = {
      id: "huge",
      staticTools: Array.from({ length: total }, (_, i) => ({
        name: `tool-${String(i).padStart(6, "0")}`,
      })),
      async listTools() {
        throw new Error("static catalog should not load");
      },
      async callTool() {
        return null;
      },
    };
    const mt = createMetaTools(makeRegistry([connector]), BASE);
    const seen = new Set<string>();
    for (const offset of [0, 50_000, total - MAX_SEARCH_LIMIT]) {
      const page = textOf(
        await mt.searchTools({ offset, limit: MAX_SEARCH_LIMIT }),
      ) as SearchResult;
      expect(page.total).toBe(total);
      expect(page.offset).toBe(offset);
      expect(required(page.connectors[0]).tools).toHaveLength(MAX_SEARCH_LIMIT);
      for (const tool of required(page.connectors[0]).tools) {
        expect(seen.has(tool.address)).toBe(false);
        seen.add(tool.address);
      }
    }
    expect(seen.size).toBe(3 * MAX_SEARCH_LIMIT);
  });

  it("rejects an oversized multibyte search result with a paging hint", async () => {
    const connector: Connector = {
      id: "verbose",
      staticTools: [
        {
          name: "read",
          description: "界".repeat(MAX_DISCOVERY_RESULT_BYTES),
        },
      ],
      async listTools() {
        return [];
      },
      async callTool() {
        return null;
      },
    };
    const result = await createMetaTools(
      makeRegistry([connector]),
      BASE,
    ).searchTools({ fullDescriptions: true });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatchObject({
      error: {
        code: "result_too_large",
        message: expect.stringContaining(
          `${MAX_DISCOVERY_RESULT_BYTES}-byte ceiling`,
        ),
        retryable: false,
      },
    });
  });

  it("ranks tool-name matches above incidental description matches", async () => {
    const conn: Connector = {
      id: "knowledge",
      description: "Knowledge base",
      async listTools() {
        return [
          {
            name: "article-search",
            description:
              "Search articles, then fetch a matching document for details.",
          },
          {
            name: "article-fetch",
            description: "Fetch an article document by URL or ID.",
          },
        ];
      },
      async callTool() {
        return null;
      },
    };
    const mt = createMetaTools(makeRegistry([conn]), BASE);
    const parsed = textOf(
      await mt.searchTools({ query: "fetch article document" }),
    ) as SearchResult;

    expect(required(parsed.connectors[0]).tools.map((t) => t.name)).toEqual([
      "article-fetch",
      "article-search",
    ]);
    expect(parsed.matchMode).toBeUndefined();
  });

  it("removes conversational framing before the all-term decision", async () => {
    const connector: Connector = {
      id: "conversation",
      staticTools: [
        {
          name: "list_issues",
          description: "List open issues for a project",
        },
        {
          name: "expand_archive",
          description: "Expand a compressed archive",
        },
      ],
      async listTools() {
        return [];
      },
      async callTool() {
        return null;
      },
    };
    const parsed = textOf(
      await createMetaTools(
        makeRegistry([connector]),
        BASE,
      ).searchTools({
        query:
          "can you show me all of the current open issues in our project please",
      }),
    ) as SearchResult;

    expect(
      parsed.connectors.flatMap((group) =>
        group.tools.map((tool) => tool.name),
      ),
    ).toEqual(["list_issues"]);
    expect(parsed.matchMode).toBeUndefined();
  });

  it("keeps action terms and returns every relevant multi-intent match", async () => {
    const connector: Connector = {
      id: "files",
      staticTools: [
        {
          name: "search_files",
          description: "Find a drive file",
        },
        {
          name: "share_file",
          description: "Share a drive file",
        },
        {
          name: "list_folder",
          description: "List child folders",
        },
      ],
      async listTools() {
        return [];
      },
      async callTool() {
        return null;
      },
    };
    const parsed = textOf(
      await createMetaTools(
        makeRegistry([connector]),
        BASE,
      ).searchTools({
        query: "find a drive file and share it",
      }),
    ) as SearchResult;

    expect(
      new Set(
        parsed.connectors.flatMap((group) =>
          group.tools.map((tool) => tool.address),
        ),
      ),
    ).toEqual(new Set(["files.search_files", "files.share_file"]));
    expect(parsed.matchMode).toBe("partial");
  });

  it("explains supported, mixed, partial, and absent lexical intents", async () => {
    const connector: Connector = {
      id: "projects",
      staticTools: [
        {
          name: "list_projects",
          description: "List software projects",
        },
        {
          name: "list_deployments",
          description: "List software deployments",
        },
        {
          name: "get_project",
          description: "Get one software project by ID",
        },
      ],
      async listTools() {
        return [];
      },
      async callTool() {
        return null;
      },
    };
    const mt = createMetaTools(makeRegistry([connector]), BASE);

    const supported = textOf(
      await mt.searchTools({ query: "list projects deployments" }),
    ) as SearchResult;
    expect(supported.matchMode).toBe("partial");
    expect(supported.queryAnalysis).toMatchObject({
      representedTerms: ["list", "projects", "deployments"],
      otherResultTerms: [],
      unmatchedTerms: [],
      guidance: expect.stringContaining("Split distinct intents"),
    });

    const supportedFirstPage = textOf(
      await mt.searchTools({
        query: "list projects deployments",
        limit: 1,
      }),
    ) as SearchResult;
    expect(
      new Set([
        ...required(supportedFirstPage.queryAnalysis).representedTerms,
        ...required(supportedFirstPage.queryAnalysis).otherResultTerms,
      ]),
    ).toEqual(new Set(["list", "projects", "deployments"]));
    expect(
      required(supportedFirstPage.queryAnalysis).otherResultTerms,
    ).toHaveLength(1);

    const mixed = textOf(
      await mt.searchTools({ query: "list projects invoices" }),
    ) as SearchResult;
    expect(mixed.matchMode).toBe("partial");
    expect(mixed.queryAnalysis).toMatchObject({
      representedTerms: ["list", "projects"],
      otherResultTerms: [],
      unmatchedTerms: ["invoices"],
      guidance: expect.stringContaining("Split distinct intents"),
    });

    const weakPartial = textOf(
      await mt.searchTools({
        query: "get project owner billing metadata",
      }),
    ) as SearchResult;
    expect(weakPartial.matchMode).toBe("partial");
    expect(weakPartial.queryAnalysis).toMatchObject({
      representedTerms: ["get", "project"],
      unmatchedTerms: ["owner", "billing", "metadata"],
    });

    const absent = textOf(
      await mt.searchTools({ query: "calendar availability" }),
    ) as SearchResult;
    expect(absent).toMatchObject({
      connectors: [],
      total: 0,
      queryAnalysis: {
        representedTerms: [],
        otherResultTerms: [],
        unmatchedTerms: ["calendar", "availability"],
        guidance: expect.stringContaining(
          "No matching capability is configured in this deployment",
        ),
      },
    });

    const scopedAbsent = textOf(
      await mt.searchTools({
        connector: "projects",
        query: "calendar availability",
      }),
    ) as SearchResult;
    expect(scopedAbsent.queryAnalysis).toMatchObject({
      connectorScope: "projects",
      unmatchedTerms: ["calendar", "availability"],
      guidance: expect.stringContaining(
        'No matching capability was found on connector "projects"',
      ),
    });
    expect(required(scopedAbsent.queryAnalysis).guidance).not.toContain(
      "configured in this deployment",
    );

    const unknownConnector = textOf(
      await mt.searchTools({
        connector: "ghost",
        query: "calendar availability",
      }),
    ) as SearchResult;
    expect(unknownConnector.queryAnalysis).toMatchObject({
      connectorScope: "ghost",
      unknownConnector: true,
      representedTerms: [],
      otherResultTerms: [],
      unmatchedTerms: ["calendar", "availability"],
      guidance: expect.stringContaining(
        'Connector "ghost" is not configured in this deployment',
      ),
    });
  });

  it("names the connector a no-match query already identified", async () => {
    const inventory: Connector = {
      id: "inventory",
      title: "Warehouse stock",
      staticTools: [
        {
          name: "list_skus",
          description: "List every stock-keeping unit and its bin",
        },
        {
          name: "get_sku",
          description: "Get one stock-keeping unit by code",
        },
      ],
      async listTools() {
        return [];
      },
      async callTool() {
        return null;
      },
    };
    const mt = createMetaTools(makeRegistry([inventory]), BASE);

    const byId = textOf(
      await mt.searchTools({ query: "inventory" }),
    ) as SearchResult;
    expect(byId.total).toBe(0);
    const byIdGuidance = required(required(byId.queryAnalysis).guidance);
    expect(byIdGuidance).not.toContain("is configured in this deployment");
    expect(byIdGuidance).toContain('connector "inventory"');
    expect(byIdGuidance).toContain("browse with an empty query");

    // A title word is displayed, never indexed, so it must reach the same
    // correction rather than the false negative.
    const byTitle = textOf(
      await mt.searchTools({ query: "warehouse" }),
    ) as SearchResult;
    expect(byTitle.total).toBe(0);
    expect(
      required(required(byTitle.queryAnalysis).guidance),
    ).toContain('connector "inventory"');

    // A term the deployment really does not have keeps the stronger claim.
    const absent = textOf(
      await mt.searchTools({ query: "calendar" }),
    ) as SearchResult;
    expect(absent.total).toBe(0);
    expect(required(required(absent.queryAnalysis).guidance)).toContain(
      "No matching capability is configured in this deployment",
    );

    // The term cap on the serialized analysis fields is not a cap on the
    // search: ranking reads every term, so a connector named past the eighth
    // one must be named back rather than denied.
    const lateId = textOf(
      await mt.searchTools({
        query: "alpha beta gamma delta epsilon zeta eta theta inventory",
      }),
    ) as SearchResult;
    expect(lateId.total).toBe(0);
    expect(required(required(lateId.queryAnalysis).guidance)).toContain(
      'connector "inventory"',
    );

    const lateTitle = textOf(
      await mt.searchTools({
        query: "alpha beta gamma delta epsilon zeta eta theta warehouse",
      }),
    ) as SearchResult;
    expect(lateTitle.total).toBe(0);
    expect(required(required(lateTitle.queryAnalysis).guidance)).toContain(
      'connector "inventory"',
    );

    // Identity never enters ranking: a query that matches tools is answered
    // by the same tools, in the same order, with no identity advice.
    const matched = textOf(
      await mt.searchTools({ query: "inventory sku" }),
    ) as SearchResult;
    expect(
      matched.connectors.flatMap((group) =>
        group.tools.map((tool) => tool.address),
      ),
    ).toEqual(["inventory.get_sku", "inventory.list_skus"]);
    expect(
      required(required(matched.queryAnalysis).guidance),
    ).toContain("Split distinct intents");
  });

  it("bounds query analysis independently of long search input", async () => {
    const query = Array.from(
      { length: 20 },
      (_, index) => `${index}${"x".repeat(100)}`,
    ).join(" ");
    const parsed = textOf(
      await createMetaTools(makeRegistry([]), BASE).searchTools({ query }),
    ) as SearchResult;
    const analysis = required(parsed.queryAnalysis);

    expect(analysis.unmatchedTerms).toHaveLength(8);
    expect(
      analysis.unmatchedTerms.every((term) => term.length <= 64),
    ).toBe(true);
    expect(analysis.truncated).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(analysis)).length).toBeLessThan(
      1_600,
    );
  });

  it("does not let short function words force incidental partial matches", async () => {
    const connector: Connector = {
      id: "messages",
      staticTools: [
        {
          name: "send_message",
          description: "Send a message to a channel",
        },
        {
          name: "list_members",
          description: "List the people in a channel",
        },
      ],
      async listTools() {
        return [];
      },
      async callTool() {
        return null;
      },
    };
    const parsed = textOf(
      await createMetaTools(
        makeRegistry([connector]),
        BASE,
      ).searchTools({
        query: "send a message to a channel",
      }),
    ) as SearchResult;

    expect(
      parsed.connectors.flatMap((group) =>
        group.tools.map((tool) => tool.name),
      ),
    ).toEqual(["send_message"]);
    expect(parsed.matchMode).toBeUndefined();
  });

  it("falls back to the original query when cleanup removes every term", async () => {
    const connector: Connector = {
      id: "framing",
      staticTools: [
        {
          name: "phrase",
          description: "A and the",
        },
        {
          name: "decoy",
          description: "Unrelated record",
        },
      ],
      async listTools() {
        return [];
      },
      async callTool() {
        return null;
      },
    };
    const parsed = textOf(
      await createMetaTools(
        makeRegistry([connector]),
        BASE,
      ).searchTools({
        query: "a and the",
      }),
    ) as SearchResult;

    expect(
      parsed.connectors.flatMap((group) =>
        group.tools.map((tool) => tool.name),
      ),
    ).toEqual(["phrase"]);
    expect(parsed.matchMode).toBeUndefined();
  });

  it("returns no false positive when only a framing word overlaps", async () => {
    const connector: Connector = {
      id: "archives",
      staticTools: [
        {
          name: "expand_archive",
          description: "Expand a compressed archive",
        },
      ],
      async listTools() {
        return [];
      },
      async callTool() {
        return null;
      },
    };
    const parsed = textOf(
      await createMetaTools(
        makeRegistry([connector]),
        BASE,
      ).searchTools({
        query: "weather radar and rain forecast",
      }),
    ) as SearchResult;

    expect(parsed.connectors).toEqual([]);
    expect(parsed.total).toBe(0);
    expect(parsed.matchMode).toBeUndefined();
  });

  it("mixes an exact action/object near-match into an all-term decoy page", async () => {
    // Development-only reproduction of #326's live Mixpanel failure. The
    // sealed discovery holdout stays unchanged; these synthetic descriptions
    // model broad business-context tools that happen to repeat every query
    // term and used to hide the exact action/object tool entirely.
    const connector: Connector = {
      id: "analytics",
      staticTools: [
        {
          name: "List-Organizations",
          description: "List organizations available to the caller",
        },
        {
          // This partial candidate has the same strong term score as the
          // intended tool, but its extra name token makes it non-exact. It
          // must remain behind every complete match.
          name: "List-All-Organizations",
          description: "List organizations available to the caller",
        },
        ...Array.from({ length: 8 }, (_, index) => ({
          name: `business_context_${index}`,
          description:
            "List organizations and projects configured for business analysis",
        })),
        ...Array.from({ length: 2 }, (_, index) => ({
          name: `project_note_${index}`,
          description: "Inspect one project note",
        })),
      ],
      async listTools() {
        return [];
      },
      async callTool() {
        return null;
      },
    };
    const mt = createMetaTools(makeRegistry([connector]), BASE);
    const first = textOf(
      await mt.searchTools({
        query: "list organizations projects",
        limit: 8,
      }),
    ) as SearchResult;

    expect(
      required(first.connectors[0]).tools.map((tool) => tool.name),
    ).toEqual([
      "List-Organizations",
      ...Array.from({ length: 7 }, (_, index) => `business_context_${index}`),
    ]);
    expect(first).toMatchObject({
      total: 10,
      nextOffset: 8,
      hasMore: true,
    });
    expect(first.matchMode).toBeUndefined();
    expect(
      required(first.connectors[0]).tools.every(
        (tool) => !("queryCoverage" in tool) && !("score" in tool),
      ),
    ).toBe(true);

    const second = textOf(
      await mt.searchTools({
        query: "list organizations projects",
        limit: 8,
        offset: required(first.nextOffset),
      }),
    ) as SearchResult;
    expect(required(second.connectors[0]).tools.map((tool) => tool.name)).toEqual([
      "business_context_7",
      "List-All-Organizations",
    ]);
    expect(second).toMatchObject({ total: 10, hasMore: false });
    expect(
      second.connectors.flatMap((group) => group.tools).every(
        (tool) => !("queryCoverage" in tool) && !("score" in tool),
      ),
    ).toBe(true);

    const rawPhrase = textOf(
      await mt.searchTools({
        query: "list all organizations projects",
        limit: 8,
      }),
    ) as SearchResult;
    expect(
      required(rawPhrase.connectors[0]).tools.map((tool) => tool.name),
    ).toEqual([
      "List-All-Organizations",
      ...Array.from({ length: 7 }, (_, index) => `business_context_${index}`),
    ]);
    expect(rawPhrase).toMatchObject({
      total: 10,
      nextOffset: 8,
      hasMore: true,
    });
    expect(rawPhrase.matchMode).toBeUndefined();
    expect(
      rawPhrase.connectors.flatMap((group) => group.tools).every(
        (tool) => !("queryCoverage" in tool) && !("score" in tool),
      ),
    ).toBe(true);
  });

  it("uses deterministic partial-term ranking when no all-term match exists", async () => {
    const conn: Connector = {
      id: "experiments",
      description: "Experiment service",
      async listTools() {
        return [
          {
            name: "list_experiments",
            description: "List experiments and their configuration.",
          },
          {
            name: "get_experiment",
            description:
              "Get experiment details including metrics and variants.",
          },
          {
            name: "get_results",
            description: "Get experiment results.",
          },
        ];
      },
      async callTool() {
        return null;
      },
    };
    const mt = createMetaTools(makeRegistry([conn]), BASE);
    const query =
      "get experiment details metrics variants results configuration";
    const first = textOf(
      await mt.searchTools({ query, limit: 2 }),
    ) as SearchResult;

    expect(first.matchMode).toBe("partial");
    const firstTools = first.connectors.flatMap((group) => group.tools);
    expect(firstTools.map((t) => t.name))
      .toEqual(["get_experiment", "get_results"]);
    expect(
      firstTools.every(
        (tool) => !("queryCoverage" in tool) && !("score" in tool),
      ),
    ).toBe(true);
    expect(first.queryAnalysis).toMatchObject({
      representedTerms: [
        "get",
        "experiment",
        "details",
        "metrics",
        "variants",
        "results",
      ],
      otherResultTerms: ["configuration"],
      unmatchedTerms: [],
    });
    expect(first.total).toBe(3);
    expect(first.nextOffset).toBe(2);

    const second = textOf(
      await mt.searchTools({
        query,
        limit: 2,
        offset: required(first.nextOffset),
      }),
    ) as SearchResult;
    expect(second.matchMode).toBe("partial");
    expect(required(second.connectors[0]).tools.map((tool) => tool.name)).toEqual([
      "list_experiments",
    ]);
  });

  it("keeps partial fallback connector-scoped and returns no mode without overlap", async () => {
    const connector = (id: string, name: string): Connector => ({
      id,
      async listTools() {
        return [{ name, description: `${name} records` }];
      },
      async callTool() {
        return null;
      },
    });
    const mt = createMetaTools(
      makeRegistry([
        connector("wanted", "get_experiment"),
        connector("other", "get_results"),
      ]),
      BASE,
    );
    const partial = textOf(
      await mt.searchTools({
        connector: "wanted",
        query: "get experiment metrics variants results",
      }),
    ) as SearchResult;
    expect(partial.matchMode).toBe("partial");
    expect(partial.connectors.map((group) => group.id)).toEqual(["wanted"]);

    const none = textOf(
      await mt.searchTools({
        connector: "wanted",
        query: "calendar availability",
      }),
    ) as SearchResult;
    expect(none).toMatchObject({ connectors: [], total: 0, hasMore: false });
    expect(none.matchMode).toBeUndefined();
  });

  it("returns concise descriptions by default and full text on request", async () => {
    const longDescription = `A tool ${"with extensive documentation ".repeat(20)}`;
    const conn: Connector = {
      id: "docs",
      description: "Docs",
      async listTools() {
        return [{ name: "read", description: longDescription }];
      },
      async callTool() {
        return null;
      },
    };
    const mt = createMetaTools(makeRegistry([conn]), BASE);
    const concise = textOf(await mt.searchTools({})) as SearchResult;
    const full = textOf(
      await mt.searchTools({ fullDescriptions: true }),
    ) as SearchResult;

    expect(required(required(concise.connectors[0]).tools[0]).description!.length).toBeLessThan(
      longDescription.length,
    );
    expect(required(required(concise.connectors[0]).tools[0]).description).toMatch(/…$/);
    expect(required(required(full.connectors[0]).tools[0]).description).toBe(longDescription);
  });

  it("keeps a representative compact page within an agent-context budget", async () => {
    const propertyProse = `redundant-property-prose-${"detail ".repeat(16)}`;
    const inputSchema = {
      type: "object",
      properties: Object.fromEntries([
        ...Array.from({ length: 80 }, (_, index) => [
          `optionalField${index}`,
          { type: "string", description: propertyProse },
        ]),
        [
          "recordId",
          { type: "string", description: `${propertyProse} required` },
        ],
      ]),
      required: ["recordId"],
    };
    const connector: Connector = {
      id: "context_budget",
      description: `connector-prose-${"background ".repeat(100)}`,
      staticTools: Array.from({ length: 8 }, (_, index) => ({
        name: `read_record_${index}`,
        description: `Read one record ${index}. ${"Long operational detail. ".repeat(30)}`,
        inputSchema,
        annotations: { readOnlyHint: true },
      })),
      async listTools() {
        return [];
      },
      async callTool(name, args) {
        return {
          name,
          recordId: (args as Record<string, unknown>).recordId,
        };
      },
    };
    const mt = createMetaTools(makeRegistry([connector]), BASE);
    const compactResult = await mt.searchTools({
      includeSchemas: "compact",
    });
    const compactText = required(compactResult.content[0]).text;
    const compact = textOf(compactResult) as SearchResult;
    const tools = required(compact.connectors[0]).tools as Array<
      SearchResult["connectors"][number]["tools"][number] & {
        inputSchema: string;
        inputSchemaTruncated?: true;
      }
    >;

    expect(new TextEncoder().encode(compactText).length).toBeLessThan(14_000);
    expect(compactText).not.toContain("redundant-property-prose");
    expect(compactText).not.toContain("connector-prose");
    expect(tools).toHaveLength(8);
    expect(tools.every((tool) => tool.inputSchemaTruncated)).toBe(true);
    expect(tools.every((tool) => !("inputKeys" in tool))).toBe(true);
    expect(
      tools.every(
        (tool) =>
          new TextEncoder().encode(tool.inputSchema).length <=
          MAX_COMPACT_DISCOVERY_SCHEMA_BYTES,
      ),
    ).toBe(true);
    expect(required(tools[0]).inputSchema).toMatch(
      /^\{ "recordId": unknown, "optionalField0"\?: unknown/,
    );

    // The required-first routing shape is enough for the simple read; no
    // describe round trip is needed.
    expect(
      textOf(
        await mt.callTool({
          address: required(tools[0]).address,
          args: { recordId: "rec_123" },
        }),
      ),
    ).toEqual({ name: "read_record_0", recordId: "rec_123" });

    const exactResult = await mt.searchTools({
      limit: 8,
      fullDescriptions: true,
      includeSchemas: "json",
    });
    const exactText = required(exactResult.content[0]).text;
    expect(exactText).toContain("redundant-property-prose");
    expect(exactText).toContain("Long operational detail");
    expect(new TextEncoder().encode(compactText).length).toBeLessThan(
      new TextEncoder().encode(exactText).length * 0.15,
    );
  });

  it("optionally includes compact schemas and annotations for API and MCP tools", async () => {
    const apiConnector = api("weather", {
      description: "Weather API",
      tools: [
        {
          name: "forecast",
          description: "Read a forecast",
          inputSchema: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
          outputSchema: {
            type: "object",
            properties: { temperature: { type: "number" } },
          },
          annotations: { readOnlyHint: true },
          handler: () => ({ temperature: 20 }),
        },
        {
          name: "empty_output",
          description: "Read an object with no declared output properties",
          inputSchema: { type: "object", properties: {} },
          outputSchema: { type: "object", properties: {} },
          annotations: { readOnlyHint: true },
          handler: () => ({}),
        },
      ],
    });
    const mcpConnector: Connector = {
      id: "crm",
      kind: "mcp",
      async listTools() {
        return [
          {
            name: "lookup",
            inputSchema: {
              type: "object",
              properties: { id: { type: "string" } },
              required: ["id"],
            },
            annotations: { readOnlyHint: true, openWorldHint: false },
          },
        ];
      },
      async callTool() {
        return { content: [{ type: "text", text: "{}" }] };
      },
    };
    const parsed = textOf(
      await createMetaTools(
        makeRegistry([apiConnector, mcpConnector]),
        BASE,
      ).searchTools({ includeSchemas: "compact" }),
    ) as {
      connectors: Array<{
        id: string;
        tools: Array<{
          inputSchema: string;
          outputSchema?: string;
          inputKeys?: string[];
          requiredInputKeys?: string[];
          outputKeys?: string[];
          annotations?: Record<string, unknown>;
        }>;
      }>;
    };
    const byId = Object.fromEntries(parsed.connectors.map((c) => [c.id, c]));
    expect(required(required(byId.weather).tools[0]).inputSchema).toBe("{ city: string }");
    expect(required(required(byId.weather).tools[0])).toMatchObject({
      inputKeys: ["city"],
      requiredInputKeys: ["city"],
      outputKeys: ["temperature"],
    });
    expect(required(required(byId.weather).tools[0]).outputSchema).toContain("temperature");
    expect(required(required(byId.weather).tools[0]).annotations).toEqual({
      readOnlyHint: true,
    });
    const emptyOutput = required(required(byId.weather).tools[1]);
    expect(emptyOutput.inputKeys).toEqual([]);
    expect(emptyOutput.requiredInputKeys).toEqual([]);
    expect(emptyOutput.outputSchema).toBe("{}");
    expect(emptyOutput).not.toHaveProperty("outputKeys");
    expect(required(required(byId.crm).tools[0]).inputSchema).toBe("{ id: string }");
    expect(required(required(byId.crm).tools[0]).annotations).toMatchObject({
      readOnlyHint: true,
      openWorldHint: false,
    });
  });

  it("reports a connector's display title separately from its address id", async () => {
    const titled = api("billing", {
      title: "Acme Billing",
      description: "Acme billing management",
      tools: [
        {
          name: "list",
          description: "List billing records",
          annotations: { readOnlyHint: true },
          inputSchema: { type: "object" },
          handler: () => [],
        },
      ],
    });
    const parsed = textOf(
      await createMetaTools(makeRegistry([titled]), BASE).searchTools({}),
    ) as { connectors: Array<{ id: string; title?: string }> };

    expect(parsed.connectors[0]).toMatchObject({
      id: "billing",
      title: "Acme Billing",
    });
  });

  it("loads independent connector catalogs in parallel", async () => {
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const connector = (id: string): Connector => ({
      id,
      kind: "mcp",
      async listTools() {
        started++;
        if (started === 2) release();
        await gate;
        return [{ name: "read" }];
      },
      async callTool() {
        return null;
      },
    });
    const search = createMetaTools(
      makeRegistry([connector("first"), connector("second")]),
      BASE,
    ).searchTools({});
    await expect(
      Promise.race([
        search,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("catalogs loaded sequentially")),
            100,
          ),
        ),
      ]),
    ).resolves.toBeDefined();
    expect(started).toBe(2);
  });
});

describe("compact schema rendering", () => {
  async function shapeOf(schema: any): Promise<string> {
    const conn: Connector = {
      id: "shape",
      kind: "api",
      description: "Shapes",
      async listTools() {
        return [{ name: "t", description: "t", inputSchema: schema }];
      },
      async callTool() {
        return {};
      },
    };
    // The describe renderer, read at the layer that owns it: `connecta.describe`
    // inside execute_code is the only surface that reaches it now, and it
    // renders property descriptions where search's bounded compact schema
    // deliberately does not.
    const described = await new CatalogService(
      makeRegistry([conn]),
      BASE,
    ).describe({ addresses: ["shape.t"] });
    return required(described[0]).inputSchema as string;
  }

  it("renders optionals, enums, arrays and property descriptions", async () => {
    const shape = await shapeOf({
      type: "object",
      properties: {
        id: { type: "string", description: "the id" },
        mode: { enum: ["a", "b"] },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["id"],
    });
    expect(shape).toBe(
      '{ id: string // the id, mode?: "a" | "b", tags?: string[] }',
    );
  });

  it("renders numeric and string constraints in discovery and describe", async () => {
    const schema = {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          exclusiveMinimum: 0,
          maximum: 50,
          exclusiveMaximum: 51,
          multipleOf: 1,
        },
        name: {
          type: "string",
          minLength: 3,
          maxLength: 64,
          format: "hostname",
          pattern: "^[a-z]+$",
        },
      },
    };
    const expected =
      '{ limit?: integer /* >= 1; > 0; <= 50; < 51; multiple of 1 */, ' +
      'name?: string /* length >= 3; length <= 64; format "hostname"; pattern "^[a-z]+$" */ }';

    expect(compactDiscoverySchema(schema)).toEqual({
      text: expected,
      truncated: false,
    });
    expect(await shapeOf(schema)).toBe(expected);
    expect(
      compactDiscoverySchema({
        anyOf: [{ type: "string" }, { type: "null" }],
        minLength: 2,
      }).text,
    ).toBe("(string | null) /* length >= 2 */");
    expect(compactDiscoverySchema({ minimum: 0 }).text).toBe(
      "unknown /* >= 0 */",
    );
  });

  it("groups enum and resolved-union constraints around the whole type", () => {
    const constrainedEnum = { enum: ["a", "bbb"], minLength: 2 };
    expect(compactDiscoverySchema(constrainedEnum).text).toBe(
      '("a" | "bbb") /* length >= 2 */',
    );
    expect(compactSchema(constrainedEnum)).toBe(
      '("a" | "bbb") /* length >= 2 */',
    );

    const constrainedRef = {
      $ref: "#/$defs/Value",
      minLength: 2,
      $defs: {
        Value: {
          anyOf: [{ type: "string" }, { type: "null" }],
        },
      },
    };
    expect(compactDiscoverySchema(constrainedRef).text).toBe(
      "(string | null) /* length >= 2 */",
    );
    expect(compactSchema(constrainedRef)).toBe(
      "(string | null) /* length >= 2 */",
    );
  });

  it("does not group unconstrained array-valued type unions", () => {
    expect(compactDiscoverySchema({ type: ["string", "null"] }).text).toBe(
      "string | null",
    );
    expect(compactSchema({ type: ["string", "null"] })).toBe(
      "string | null",
    );
  });

  it("drops constraints that push discovery over budget and flags the shape", () => {
    const schema = {
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: 36 }, (_, index) => [
          `field${index}`,
          { type: "string", minLength: 1, maxLength: 64 },
        ]),
      ),
    };

    const compact = compactDiscoverySchema(schema);
    expect(compact.truncated).toBe(true);
    expect(compact.text).toContain("field0?: string");
    expect(compact.text).toContain("field35?: string");
    expect(compact.text).not.toContain("length >=");
    expect(new TextEncoder().encode(compact.text).length).toBeLessThanOrEqual(
      MAX_COMPACT_DISCOVERY_SCHEMA_BYTES,
    );
  });

  it('inlines $ref by name and falls back to "json" format on request', async () => {
    const schema = {
      type: "object",
      properties: { pt: { $ref: "#/$defs/Point" } },
      required: ["pt"],
      $defs: {
        Point: { type: "object", properties: { x: { type: "number" } } },
      },
    };
    const shape = await shapeOf(schema);
    expect(shape).toBe("{ pt: { x?: number } }");
  });

  it("preserves small enums in compact discovery", () => {
    expect(
      compactDiscoverySchema({
        type: "object",
        properties: { mode: { enum: ["read", "write"] } },
      }),
    ).toEqual({
      text: '{ mode?: "read" | "write" }',
      truncated: false,
    });
  });

  it("renders empty enums as the valid never type in compact discovery", () => {
    // `never` is the TypeScript bottom type, valid at both root and property
    // positions; an empty string was neither a type nor a readable constraint.
    const root = compactDiscoverySchema({ enum: [] });
    expect(root).toEqual({ text: "never", truncated: false });
    expectStructurallyCompleteTypeShape(root.text);

    const nested = compactDiscoverySchema({
      type: "object",
      properties: { state: { enum: [] } },
    });
    expect(nested).toEqual({
      text: "{ state?: never }",
      truncated: false,
    });
    expectStructurallyCompleteTypeShape(nested.text);
  });

  it("renders empty enums as never in ordinary compact describe", async () => {
    const shape = await shapeOf({ enum: [] });
    expect(shape).toBe("never");
    expectStructurallyCompleteTypeShape(shape);
  });

  it("bounds nested UTF-8 enums without hiding other property types", () => {
    const values = Array.from(
      { length: 80 },
      (_, index) => `${"😀".repeat(4)}-region-${index}`,
    );
    const schema = {
      type: "object",
      properties: {
        workspace: { type: "string" },
        filters: {
          type: "object",
          properties: {
            states: { type: "array", items: { enum: values } },
          },
        },
        traceId: { type: "string" },
        limit: { type: "integer" },
      },
      required: ["workspace"],
    };
    const compact = compactDiscoverySchema(schema);
    const exact = compactSchema(schema);

    expect(compact.truncated).toBe(true);
    expect(compact.text).toContain("workspace: string");
    expect(compact.text).toContain("filters?: { states?: (");
    expect(compact.text).toContain(")[] }");
    expect(compact.text).toContain("traceId?: string");
    expect(compact.text).toContain("limit?: integer");
    const omitted = compact.text.match(/(\d+) enum values omitted/);
    expect(omitted).not.toBeNull();
    const shown = compact.text.match(/-region-/g)?.length ?? 0;
    expect(shown + Number(required(omitted ?? undefined)[1])).toBe(
      values.length,
    );
    expectStructurallyCompleteTypeShape(compact.text);
    expect(new TextEncoder().encode(compact.text).length).toBeLessThan(
      new TextEncoder().encode(exact).length * 0.25,
    );
    expect(exact).toContain(required(values.at(-1)));
  });

  it("keeps exact enum values in JSON discovery and describe", async () => {
    const values = Array.from({ length: 40 }, (_, index) => `state-${index}`);
    const schema = {
      type: "object",
      properties: { state: { enum: values } },
    };
    const conn: Connector = {
      id: "enum_exact",
      kind: "mcp",
      async listTools() {
        return [{ name: "read", description: "Read state", inputSchema: schema }];
      },
      async callTool() {
        return null;
      },
    };
    const registry = makeRegistry([conn]);
    const search = textOf(
      await createMetaTools(registry, BASE).searchTools({
        query: "read state",
        includeSchemas: "json",
      }),
    ) as any;
    expect(required(required(search.connectors[0]).tools[0]).inputSchema).toEqual(
      schema,
    );

    const [describedJson] = await new CatalogService(registry, BASE).describe({
      addresses: ["enum_exact.read"],
      format: "json",
    });
    expect(required(describedJson).inputSchema).toEqual(schema);
    const [describedCompact] = await new CatalogService(
      registry,
      BASE,
    ).describe({ addresses: ["enum_exact.read"], format: "compact" });
    expect(required(describedCompact).inputSchema).toContain(
      required(values.at(-1)),
    );
    expect(required(describedCompact).inputSchema).not.toContain("omitted");
  });

  it("keeps oversized nested objects structurally complete", () => {
    const nestedObject = compactDiscoverySchema({
      type: "object",
      properties: {
        payload: {
          type: "object",
          properties: Object.fromEntries(
            Array.from({ length: 120 }, (_, index) => [
              `nestedField${index}`,
              {
                type: "object",
                properties: {
                  alpha: { type: "string" },
                  beta: { type: "integer" },
                },
              },
            ]),
          ),
        },
        traceId: { type: "string" },
      },
      required: ["payload"],
    });
    expect(nestedObject.truncated).toBe(true);
    expect(nestedObject.text).toBe(
      '{ "payload": unknown, "traceId"?: unknown } /* truncated */',
    );
    expectStructurallyCompleteTypeShape(nestedObject.text);

    expect(new TextEncoder().encode(nestedObject.text).length).toBeLessThanOrEqual(
      MAX_COMPACT_DISCOVERY_SCHEMA_BYTES,
    );
  });
});

describe("call_tool", () => {
  it("JSON-wraps an api connector's return value", async () => {
    const mt = createMetaTools(registry(), BASE);
    const result = await mt.callTool({
      address: "calc.add",
      args: { a: 2, b: 3 },
    });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(required(result.content[0]).text)).toEqual({ sum: 5 });
  });

  it("passes an mcp connector's content array through as-is", async () => {
    const mt = createMetaTools(registry(), BASE);
    const result = await mt.callTool({
      address: "remote.echo",
      args: { text: "hi" },
    });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([{ type: "text", text: "echo:hi" }]);
  });

  it("optionally unwraps MCP content into a structured value envelope", async () => {
    const mt = createMetaTools(makeRegistry([jsonMcpConnector]), BASE);
    const parsed = textOf(
      await mt.callTool({
        address: "jm.rec",
        resultMode: "value",
        fields: ["a"],
      }),
    ) as { ok: boolean; data: unknown; durationMs: number };

    expect(parsed.ok).toBe(true);
    expect(parsed.data).toEqual({ a: 1 });
    expect(parsed.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("turns downstream errors into isError results, not throws", async () => {
    const mt = createMetaTools(registry(), BASE);
    const result = await mt.callTool({ address: "calc.bogus", args: {} });
    expect(result.isError).toBe(true);
    expect(required(result.content[0]).text).toContain("Unknown tool");
  });

  it("returns an isError result for an unknown address", async () => {
    const mt = createMetaTools(registry(), BASE);
    const result = await mt.callTool({ address: "ghost.x" });
    expect(result.isError).toBe(true);
    expect(required(result.content[0]).text).toContain("Unknown address");
  });

  it("returns structured errors in value mode", async () => {
    const mt = createMetaTools(registry(), BASE);
    const parsed = textOf(
      await mt.callTool({
        address: "ghost.x",
        resultMode: "value",
      }),
    ) as {
      ok: boolean;
      error: { code: string; message: string; retryable: boolean };
      durationMs: number;
    };

    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("unknown_address");
    expect(parsed.error.message).toContain("Unknown address");
    expect(parsed.error.retryable).toBe(false);
  });

  it("returns actionable recovery for unknown addresses and tools", async () => {
    const mt = createMetaTools(registry(), BASE);
    const address = textOf(
      await mt.callTool({ address: "ghost.read_items" }),
    ) as {
      error: { nextAction: Record<string, unknown> };
    };
    expect(address.error.nextAction).toEqual({
      tool: "search_tools",
      arguments: {
        query: "read items",
        includeSchemas: "compact",
      },
      purpose: "Find the configured canonical address before retrying.",
    });

    const tool = textOf(
      await mt.callTool({ address: "calc.missing_sum" }),
    ) as {
      error: { nextAction: Record<string, unknown> };
    };
    expect(tool.error.nextAction).toEqual({
      tool: "search_tools",
      arguments: {
        query: "missing sum",
        connector: "calc",
        includeSchemas: "compact",
      },
      purpose: "Find the connector's current canonical tool address.",
    });
  });

  it("routes annotated destructive tools through the approval-specific handler", async () => {
    let calls = 0;
    const dangerous = api("danger", {
      tools: [
        {
          name: "erase",
          description: "Erase the thing",
          annotations: {
            destructiveHint: true,
            readOnlyHint: false,
          },
          handler: () => {
            calls++;
            return { erased: true };
          },
        },
      ],
    });
    const mt = createMetaTools(makeRegistry([dangerous]), BASE);

    const ordinary = await mt.callTool({
      address: "danger.erase",
      args: { target: "duplicate" },
    });
    expect(ordinary.isError).toBe(true);
    expect(textOf(ordinary)).toMatchObject({
      error: {
        nextAction: {
          tool: "call_destructive_tool",
          arguments: {
            address: "danger.erase",
            args: { target: "duplicate" },
          },
        },
      },
    });
    expect(calls).toBe(0);

    const approved = await mt.callDestructiveTool({
      address: "danger.erase",
      args: { target: "duplicate" },
      reason: "Remove the duplicate selected by the user.",
    });
    expect(approved.isError).toBeFalsy();
    expect(textOf(approved)).toEqual({ erased: true });
    expect(calls).toBe(1);
  });

  it("keeps a destructive refusal small when the arguments are not", async () => {
    // An error result is not size-guarded the way a result is, so echoing the
    // caller's arguments back unbounded once turned a 50 KB argument object
    // into a 101 KB refusal against a 1 KB cap — twice over, since it lands in
    // both the text content and structuredContent.
    const dangerous = api("danger", {
      tools: [
        {
          name: "erase",
          description: "Erase the thing",
          annotations: { destructiveHint: true, readOnlyHint: false },
          handler: () => ({ erased: true }),
        },
      ],
    });
    const mt = createMetaTools(
      makeRegistry([dangerous], { maxResultBytes: 1_000 }),
      BASE,
    );
    const huge = { blob: "x".repeat(50_000) };

    const direct = await mt.callTool({ address: "danger.erase", args: huge });
    const directBytes = JSON.stringify(direct).length;
    expect(direct.isError).toBe(true);
    expect(directBytes).toBeLessThan(4_000);
    expect(JSON.stringify(direct)).not.toContain("xxxxx");
    const refusal = textOf(direct) as {
      error: {
        nextAction: {
          arguments: { address: string; args?: unknown };
          purpose: string;
        };
      };
    };
    expect(refusal.error.nextAction.arguments).toEqual({
      address: "danger.erase",
    });
    expect(refusal.error.nextAction.purpose).toContain(
      "Re-send the arguments you just sent",
    );

    // Arguments that fit the echo budget still come back whole.
    const small = textOf(
      await mt.callTool({ address: "danger.erase", args: { target: "dupe" } }),
    ) as { error: { nextAction: { arguments: { args?: unknown } } } };
    expect(small.error.nextAction.arguments.args).toEqual({ target: "dupe" });
  });

  it("keeps a routing refusal small when the address is not", async () => {
    // The argument echo was bounded; the *address* was not. It reaches the
    // refusal twice over — once in the error message, once as the recovery
    // record's search query — and each of those lands in both the text content
    // and structuredContent, so a 50 KB invented address produced a 200 KB
    // refusal against a deployment that capped results at 1 KB.
    const mt = createMetaTools(
      makeRegistry([calcConnector], { maxResultBytes: 1_000 }),
      BASE,
    );
    const filler = "x".repeat(50_000);

    const unknownAddress = await mt.callTool({ address: `ghost.${filler}` });
    expect(unknownAddress.isError).toBe(true);
    expect(JSON.stringify(unknownAddress).length).toBeLessThan(4_000);
    const address = textOf(unknownAddress) as {
      error: {
        code: string;
        message: string;
        nextAction: { arguments: { query: string } };
      };
    };
    expect(address.error.code).toBe("unknown_address");
    expect(address.error.message).toContain("Unknown address");
    // Clamped, not dropped: the caller still learns which address was refused,
    // and the marker says it is not the whole of what it sent.
    expect(address.error.message).toContain("…");
    expect(address.error.nextAction.arguments.query).toContain("…");
    expect(address.error.nextAction.arguments.query.length).toBeLessThan(600);

    // Same bypass one resolution step later: the connector exists, the tool
    // name is the caller's invention.
    const unknownTool = await mt.callTool({ address: `calc.${filler}` });
    expect(unknownTool.isError).toBe(true);
    expect(JSON.stringify(unknownTool).length).toBeLessThan(4_000);
    const tool = textOf(unknownTool) as {
      error: {
        code: string;
        message: string;
        nextAction: { arguments: { query: string; connector: string } };
      };
    };
    expect(tool.error.code).toBe("unknown_tool");
    expect(tool.error.message).toContain("Unknown tool");
    expect(tool.error.nextAction.arguments.connector).toBe("calc");
    expect(tool.error.nextAction.arguments.query.length).toBeLessThan(600);

    // The common case must stay exact — a short address is corrected verbatim.
    const short = textOf(await mt.callTool({ address: "ghost.read_items" })) as {
      error: { message: string; nextAction: { arguments: { query: string } } };
    };
    expect(short.error.message).toBe('Unknown address "ghost.read_items"');
    expect(short.error.nextAction.arguments.query).toBe("read items");
  });

  it("keeps call_destructive_tool's reason out of the downstream arguments", async () => {
    const seen: unknown[] = [];
    const dangerous = api("danger", {
      tools: [
        {
          name: "erase",
          description: "Erase the thing",
          annotations: { destructiveHint: true, readOnlyHint: false },
          handler: (args: unknown) => {
            seen.push(args);
            return { erased: true };
          },
        },
      ],
    });
    const mt = createMetaTools(makeRegistry([dangerous]), BASE);

    await mt.callDestructiveTool({
      address: "danger.erase",
      args: { target: "duplicate" },
      reason: "The user asked to remove the duplicate they selected.",
    });

    // `reason` is context for the host's approval view and stops there. It is
    // not authority, and a connector must never see it as an input.
    expect(seen).toEqual([{ target: "duplicate" }]);
    expect(Object.keys(required(seen[0]) as object)).toEqual(["target"]);
  });

  it("requires approval for unannotated and contradictory tools", async () => {
    const calls: string[] = [];
    // An unannotated tool no longer comes from api() — it refuses to
    // construct one — so it arrives the way it does in production: from a
    // catalog somebody else annotated, or forgot to.
    const silent: Connector = {
      id: "silent",
      kind: "mcp",
      description: "A downstream that annotates nothing",
      async listTools() {
        return [{ name: "unannotated", description: "Who knows" }];
      },
      async callTool() {
        calls.push("unannotated");
        return { ok: true };
      },
    };
    const ambiguous = api("ambiguous", {
      tools: [
        {
          name: "contradictory",
          description: "Claims to read and destroy at once",
          annotations: {
            readOnlyHint: true,
            destructiveHint: true,
          },
          handler: () => {
            calls.push("contradictory");
            return { ok: true };
          },
        },
      ],
    });
    const mt = createMetaTools(makeRegistry([silent, ambiguous]), BASE);

    for (const address of [
      "silent.unannotated",
      "ambiguous.contradictory",
    ]) {
      const ordinary = await mt.callTool({ address });
      expect(ordinary.isError).toBe(true);
      expect(required(ordinary.content[0]).text).toContain("not explicitly read-only");
    }
    expect(calls).toEqual([]);

    const approved = await mt.callDestructiveTool({
      address: "silent.unannotated",
    });
    expect(approved.isError).toBeFalsy();
    expect(calls).toEqual(["unannotated"]);
  });

  it("deduplicates concurrent request-local catalog loads", async () => {
    let catalogLoads = 0;
    const connector: Connector = {
      id: "shared",
      kind: "api",
      async listTools() {
        catalogLoads++;
        await Promise.resolve();
        return [
          {
            name: "read",
            annotations: { readOnlyHint: true },
          },
        ];
      },
      async callTool() {
        return { ok: true };
      },
    };
    // One meta-tool set is one inbound request, so its two concurrent calls
    // share the request-local catalog rather than each loading their own.
    const mt = createMetaTools(
      makeRegistry([connector], { toolCacheTtlSeconds: 0 }),
      BASE,
    );
    const results = await Promise.all([
      mt.callTool({ address: "shared.read", resultMode: "value" }),
      mt.callTool({ address: "shared.read", resultMode: "value" }),
    ]);
    expect(results.every((result) => !result.isError)).toBe(true);
    expect(catalogLoads).toBe(1);
  });

  it("does not retain failed request-local catalog loads", async () => {
    let catalogLoads = 0;
    const connector: Connector = {
      id: "recovering",
      kind: "api",
      async listTools() {
        catalogLoads++;
        if (catalogLoads === 1) throw new Error("catalog temporarily down");
        return [
          {
            name: "read",
            annotations: { readOnlyHint: true },
          },
        ];
      },
      async callTool() {
        return { ok: true };
      },
    };
    const mt = createMetaTools(
      makeRegistry([connector], { toolCacheTtlSeconds: 0 }),
      BASE,
    );
    expect(
      (
        textOf(
          await mt.callTool({
            address: "recovering.read",
            resultMode: "value",
          }),
        ) as { ok: boolean }
      ).ok,
    ).toBe(false);
    expect(
      (
        textOf(
          await mt.callTool({
            address: "recovering.read",
            resultMode: "value",
          }),
        ) as { ok: boolean }
      ).ok,
    ).toBe(true);
    expect(catalogLoads).toBe(2);
  });

  it("retries transient failures only for safely annotated API tools", async () => {
    let safeCalls = 0;
    let unsafeCalls = 0;
    const connector = api("retry", {
      tools: [
        {
          name: "safe_read",
          description: "Read a value, retryably",
          annotations: { readOnlyHint: true },
          handler: () => {
            safeCalls++;
            if (safeCalls === 1) throw new Error("temporary 503");
            return { ok: true };
          },
        },
        {
          name: "unsafe_write",
          description: "Write something the host must approve",
          annotations: { readOnlyHint: false },
          handler: () => {
            unsafeCalls++;
            throw new Error("temporary 503");
          },
        },
      ],
    });
    const mt = createMetaTools(makeRegistry([connector]), BASE);
    const safe = textOf(
      await mt.callTool({
        address: "retry.safe_read",
        resultMode: "value",
        maxRetries: 1,
        diagnostics: true,
      }),
    ) as {
      ok: boolean;
      attempts: number;
      timing: {
        catalogMs: number;
        connectorMs: number;
        backoffMs: number;
        resultProcessingMs: number;
        totalMs: number;
      };
    };
    const unsafe = textOf(
      await mt.callTool({
        address: "retry.unsafe_write",
        resultMode: "value",
        maxRetries: 2,
      }),
    ) as { ok: boolean; attempts: number };

    expect(safe).toMatchObject({ ok: true, attempts: 2 });
    expect(safe.timing.connectorMs).toBeGreaterThanOrEqual(0);
    expect(safe.timing.backoffMs).toBeGreaterThanOrEqual(240);
    expect(safe.timing.totalMs).toBeGreaterThanOrEqual(safe.timing.connectorMs);
    expect(safeCalls).toBe(2);
    expect(unsafe).toMatchObject({
      ok: false,
      attempts: 0,
      error: { code: "destructive_tool_requires_approval" },
    });
    expect(unsafeCalls).toBe(0);
  });

  it("passes a deadline signal to API handlers and returns a timeout error", async () => {
    let sawSignal = false;
    const connector = api("slow", {
      tools: [
        {
          name: "wait",
          description: "Wait until the deadline",
          annotations: { readOnlyHint: true },
          async handler(_args, ctx) {
            sawSignal = Boolean(ctx.signal);
            await new Promise<void>((resolve) => {
              ctx.signal?.addEventListener("abort", () => resolve(), {
                once: true,
              });
            });
            return { completedAfterAbort: true };
          },
        },
      ],
    });
    const parsed = textOf(
      await createMetaTools(makeRegistry([connector]), BASE).callTool({
        address: "slow.wait",
        resultMode: "value",
        timeoutMs: 10,
      }),
    ) as {
      ok: boolean;
      error: { message: string; retryable: boolean };
      attempts: number;
    };
    expect(sawSignal).toBe(true);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.message).toContain("timed out");
    expect(parsed.error.retryable).toBe(true);
    expect(parsed.attempts).toBe(1);
  });

  it("no default deadline unless the deployment configures one", async () => {
    const seen: Array<{ timeoutMs?: number; hasSignal: boolean }> = [];
    const connector = api("budget", {
      tools: [
        {
          name: "peek",
          description: "Report the request context it received",
          annotations: { readOnlyHint: true },
          handler: (_args, ctx) => {
            seen.push({
              ...(ctx.timeoutMs !== undefined
                ? { timeoutMs: ctx.timeoutMs }
                : {}),
              hasSignal: Boolean(ctx.signal),
            });
            return { ok: true };
          },
        },
      ],
    });
    const call = { address: "budget.peek", resultMode: "value" as const };

    // Today's behaviour, unchanged: no budget and no way to be cancelled.
    await createMetaTools(makeRegistry([connector]), BASE).callTool(call);
    expect(seen[0]).toEqual({ timeoutMs: undefined, hasSignal: false });

    // defaultToolTimeoutMs fills the gap for callers that pass none…
    await createMetaTools(makeRegistry([connector]), BASE, {
      defaultToolTimeoutMs: 5_000,
    }).callTool(call);
    expect(seen[1]).toEqual({ timeoutMs: 5_000, hasSignal: true });

    // …and an explicit per-call timeoutMs still wins over it.
    await createMetaTools(makeRegistry([connector]), BASE, {
      defaultToolTimeoutMs: 5_000,
    }).callTool({ ...call, timeoutMs: 25 });
    expect(seen[2]).toEqual({ timeoutMs: 25, hasSignal: true });
  });

  it("a configured default deadline aborts and times out a hanging call", async () => {
    const connector = api("stuck", {
      tools: [
        {
          name: "wait",
          description: "Wait until the deadline",
          annotations: { readOnlyHint: true },
          async handler(_args, ctx) {
            await new Promise<void>((resolve) => {
              ctx.signal?.addEventListener("abort", () => resolve(), {
                once: true,
              });
            });
            return { completedAfterAbort: true };
          },
        },
      ],
    });
    const parsed = textOf(
      await createMetaTools(makeRegistry([connector]), BASE, {
        defaultToolTimeoutMs: 10,
      }).callTool({ address: "stuck.wait", resultMode: "value" }),
    ) as { ok: boolean; error: { code: string; retryable: boolean } };
    expect(parsed).toMatchObject({
      ok: false,
      error: { code: "timeout", retryable: true },
    });
  });

  it("surfaces a connector's retryAfterMs in the error envelope", async () => {
    const connector = api("limited", {
      tools: [
        {
          name: "read",
          description: "Read a value",
          annotations: { readOnlyHint: true },
          handler: () => {
            throw new ConnectorCallError("rate_limited", "slow down", {
              retryAfterMs: 3_600_000,
            });
          },
        },
      ],
    });
    const mt = createMetaTools(makeRegistry([connector]), BASE);
    const parsed = textOf(
      await mt.callTool({ address: "limited.read", resultMode: "value" }),
    ) as {
      ok: boolean;
      attempts: number;
      error: { code: string; retryable: boolean; retryAfterMs?: number };
    };
    // Reported verbatim even though the engine would never wait this long
    // itself — an hour is the agent's decision to make, not the engine's.
    expect(parsed).toMatchObject({
      ok: false,
      attempts: 1,
      error: { code: "rate_limited", retryable: true, retryAfterMs: 3_600_000 },
    });
  });

  it("omits retryAfterMs when the connector reports no window", async () => {
    const connector = api("plain", {
      tools: [
        {
          name: "read",
          description: "Read a value",
          annotations: { readOnlyHint: true },
          handler: () => {
            throw new ConnectorCallError("rate_limited", "slow down");
          },
        },
      ],
    });
    const parsed = textOf(
      await createMetaTools(makeRegistry([connector]), BASE).callTool({
        address: "plain.read",
        resultMode: "value",
      }),
    ) as { error: Record<string, unknown> };
    expect(parsed.error).toEqual({
      code: "rate_limited",
      message: "slow down",
      retryable: true,
    });
  });

  it("backs off for the connector's retryAfterMs instead of the exponential guess", async () => {
    let calls = 0;
    const connector = api("paced", {
      tools: [
        {
          name: "read",
          description: "Read a value",
          annotations: { readOnlyHint: true },
          handler: () => {
            calls++;
            if (calls === 1) {
              throw new ConnectorCallError("rate_limited", "slow down", {
                retryAfterMs: 600,
              });
            }
            return { ok: true };
          },
        },
      ],
    });
    const parsed = textOf(
      await createMetaTools(makeRegistry([connector]), BASE).callTool({
        address: "paced.read",
        resultMode: "value",
        maxRetries: 1,
        diagnostics: true,
      }),
    ) as { ok: boolean; attempts: number; timing: { backoffMs: number } };
    expect(parsed).toMatchObject({ ok: true, attempts: 2 });
    // The exponential default for attempt 1 is 250ms; the connector said 600.
    expect(parsed.timing.backoffMs).toBeGreaterThanOrEqual(550);
    expect(calls).toBe(2);
  });

  it("still backs off after an attempt that failed by timing out", async () => {
    // timeoutMs is a per-attempt budget, so an attempt that spends all of it
    // must not shorten the wait before the next one. A whole-call deadline
    // would leave nothing remaining here and retry instantly.
    let calls = 0;
    const connector = api("expiring", {
      tools: [
        {
          name: "read",
          description: "Read a value",
          annotations: { readOnlyHint: true },
          async handler(_args, ctx) {
            calls++;
            if (calls === 1) {
              await new Promise<void>((resolve) => {
                ctx.signal?.addEventListener("abort", () => resolve(), {
                  once: true,
                });
              });
            }
            return { ok: true };
          },
        },
      ],
    });
    const parsed = textOf(
      await createMetaTools(makeRegistry([connector]), BASE).callTool({
        address: "expiring.read",
        resultMode: "value",
        timeoutMs: 50,
        maxRetries: 1,
        diagnostics: true,
      }),
    ) as { ok: boolean; attempts: number; timing: { backoffMs: number } };
    expect(parsed).toMatchObject({ ok: true, attempts: 2 });
    // The full 250ms exponential default (less timer slop), not the ~0 a
    // spent whole-call deadline would have left.
    expect(parsed.timing.backoffMs).toBeGreaterThanOrEqual(240);
    expect(calls).toBe(2);
  });

  it("gives every attempt the full timeoutMs budget, not a share of one", async () => {
    let calls = 0;
    const connector = api("perattempt", {
      tools: [
        {
          name: "read",
          description: "Read a value",
          annotations: { readOnlyHint: true },
          async handler() {
            calls++;
            await new Promise((resolve) => setTimeout(resolve, 40));
            if (calls === 1) throw new Error("temporary 503");
            return { ok: true };
          },
        },
      ],
    });
    const parsed = textOf(
      await createMetaTools(makeRegistry([connector]), BASE).callTool({
        address: "perattempt.read",
        resultMode: "value",
        timeoutMs: 60,
        maxRetries: 1,
        diagnostics: true,
      }),
    ) as { ok: boolean; attempts: number; timing: { totalMs: number } };
    // Two 40ms attempts plus a 250ms backoff far exceed the 60ms budget in
    // total, and that is exactly the point: the budget is per attempt.
    expect(parsed).toMatchObject({ ok: true, attempts: 2 });
    expect(parsed.timing.totalMs).toBeGreaterThan(60);
    expect(calls).toBe(2);
  });

  it("waits a reported window in full even when it outlasts the per-attempt budget", async () => {
    let calls = 0;
    const connector = api("windowed", {
      tools: [
        {
          name: "read",
          description: "Read a value",
          annotations: { readOnlyHint: true },
          handler: () => {
            calls++;
            if (calls === 1) {
              throw new ConnectorCallError("rate_limited", "slow down", {
                retryAfterMs: 150,
              });
            }
            return { ok: true };
          },
        },
      ],
    });
    const parsed = textOf(
      await createMetaTools(makeRegistry([connector]), BASE).callTool({
        address: "windowed.read",
        resultMode: "value",
        timeoutMs: 25,
        maxRetries: 1,
        diagnostics: true,
      }),
    ) as { ok: boolean; attempts: number; timing: { backoffMs: number } };
    expect(parsed).toMatchObject({ ok: true, attempts: 2 });
    // The whole 150ms window (less timer slop), despite a 25ms per-attempt
    // budget that a whole-call deadline would have clamped it to.
    expect(parsed.timing.backoffMs).toBeGreaterThanOrEqual(140);
    expect(calls).toBe(2);
  });

  it("declines the retry outright when the reported window is too long to wait", async () => {
    let calls = 0;
    const connector = api("parked", {
      tools: [
        {
          name: "read",
          description: "Read a value",
          annotations: { readOnlyHint: true },
          handler: () => {
            calls++;
            throw new ConnectorCallError("rate_limited", "slow down", {
              retryAfterMs: 30_000,
            });
          },
        },
      ],
    });
    const startedAt = Date.now();
    const parsed = textOf(
      await createMetaTools(makeRegistry([connector]), BASE).callTool({
        address: "parked.read",
        resultMode: "value",
        maxRetries: 2,
        diagnostics: true,
      }),
    ) as {
      ok: boolean;
      attempts: number;
      error: { retryAfterMs?: number };
      timing: { backoffMs: number };
    };
    // Retrying inside a 30s rate-limit window is the harm this channel exists
    // to prevent, and truncating a *known* window to 10s would do exactly
    // that. So: no retry, no wait, and the window reported verbatim.
    expect(parsed).toMatchObject({
      ok: false,
      attempts: 1,
      error: { retryAfterMs: 30_000 },
    });
    expect(parsed.timing.backoffMs).toBe(0);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(calls).toBe(1);
  });

  // The 10s ceiling can't be waited out in a test, so it is asserted on the
  // pure calculation the retry loop calls.
  it("bounds the backoff: a reported window is honoured exactly or not at all", () => {
    // No window reported → the historical exponential guess, capped at 1s.
    expect(retryBackoffMs(1, undefined)).toBe(250);
    expect(retryBackoffMs(2, undefined)).toBe(500);
    expect(retryBackoffMs(3, undefined)).toBe(1_000);
    expect(retryBackoffMs(9, undefined)).toBe(1_000);

    // A reported window replaces the guess, in both directions, and 0 means
    // "retry now" rather than "no window".
    expect(retryBackoffMs(1, 40)).toBe(40);
    expect(retryBackoffMs(1, 4_000)).toBe(4_000);
    expect(retryBackoffMs(1, 0)).toBe(0);

    // Up to the ceiling it is honoured exactly; past it the retry is declined
    // (undefined) rather than truncated into the rate-limit window.
    expect(MAX_RETRY_BACKOFF_MS).toBe(10_000);
    expect(retryBackoffMs(1, MAX_RETRY_BACKOFF_MS)).toBe(MAX_RETRY_BACKOFF_MS);
    expect(retryBackoffMs(1, MAX_RETRY_BACKOFF_MS + 1)).toBe(undefined);
    expect(retryBackoffMs(1, 3_600_000)).toBe(undefined);
  });

  it("a typed non-retryable error is not retried even if its text says timeout", async () => {
    let calls = 0;
    const connector = api("typed", {
      tools: [
        {
          name: "read",
          description: "Read a value",
          annotations: { readOnlyHint: true },
          handler: () => {
            calls++;
            throw new ConnectorCallError(
              "connector_call_failed",
              'downstream rejected field "timeout"',
              { retryable: false },
            );
          },
        },
      ],
    });
    const parsed = textOf(
      await createMetaTools(makeRegistry([connector]), BASE).callTool({
        address: "typed.read",
        resultMode: "value",
        maxRetries: 2,
      }),
    ) as {
      ok: boolean;
      attempts: number;
      error: { code: string; retryable: boolean };
    };
    // The regex heuristic would have coded this "timeout" and retried it.
    expect(parsed).toMatchObject({
      ok: false,
      attempts: 1,
      error: { code: "connector_call_failed", retryable: false },
    });
    expect(calls).toBe(1);
  });

  it("a typed auth_required from a call keeps its code so the agent can re-auth", async () => {
    const connector = api("expired", {
      tools: [
        {
          name: "read",
          description: "Read a value",
          annotations: { readOnlyHint: true },
          handler: () => {
            throw new ConnectorCallError(
              "auth_required",
              'Connector "expired" requires authorization — call authorize_connector({ connector: "expired" }).',
            );
          },
        },
      ],
    });
    const parsed = textOf(
      await createMetaTools(makeRegistry([connector]), BASE).callTool({
        address: "expired.read",
        resultMode: "value",
        maxRetries: 2,
      }),
    ) as {
      ok: boolean;
      attempts: number;
      error: {
        code: string;
        message: string;
        retryable: boolean;
        retry: string;
      };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.attempts).toBe(1);
    expect(parsed.error.code).toBe("auth_required");
    expect(parsed.error.retryable).toBe(false);
    expect(parsed.error.message).toContain("authorize_connector");
    expect(parsed.error).toMatchObject({
      connector: "expired",
      operation: "expired.read",
      recovery: "unavailable",
      nextAction: {
        tool: "authorize_connector",
        arguments: { connector: "expired" },
      },
    });
    expect(parsed.error.retry).toContain("expired.read");
  });

  it("returns the same structured auth_required envelope in MCP result mode", async () => {
    const connector = api("expired", {
      tools: [
        {
          name: "read",
          description: "Read a value",
          annotations: { readOnlyHint: true },
          handler: () => {
            throw new ConnectorCallError(
              "auth_required",
              "Authorization is required.",
            );
          },
        },
      ],
    });
    const result = await createMetaTools(
      makeRegistry([connector]),
      BASE,
    ).callTool({ address: "expired.read" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatchObject({
      ok: false,
      error: {
        code: "auth_required",
        connector: "expired",
        operation: "expired.read",
        recovery: "unavailable",
      },
    });
  });

  it("schema-invalid args fail closed as invalid_args without reaching the handler", async () => {
    let calls = 0;
    const connector = api("strict", {
      tools: [
        {
          name: "page",
          description: "Read one page of values",
          annotations: { readOnlyHint: true },
          inputSchema: {
            type: "object",
            properties: { page: { type: "integer" } },
            required: ["page"],
          },
          handler: () => {
            calls++;
            return { ok: true };
          },
        },
      ],
    });
    const parsed = textOf(
      await createMetaTools(makeRegistry([connector]), BASE).callTool({
        address: "strict.page",
        resultMode: "value",
        args: { page: "3" },
        maxRetries: 2,
      }),
    ) as {
      ok: boolean;
      attempts: number;
      error: { code: string; retryable: boolean };
    };
    expect(parsed).toMatchObject({
      ok: false,
      attempts: 1,
      error: { code: "invalid_args", retryable: false },
    });
    expect(calls).toBe(0);
  });

  it("classifies remote schema mismatches consistently without provider prose", async () => {
    let calls = 0;
    const connector: Connector = {
      id: "remote_strict",
      kind: "mcp",
      async listTools() {
        const inputSchema = {
          type: "object" as const,
          properties: {
            title: { type: "string" as const },
            options: {
              type: "object" as const,
              properties: { enabled: { type: "boolean" as const } },
              required: ["enabled"],
            },
          },
          required: ["title", "options"],
        };
        return [
          {
            name: "read",
            annotations: { readOnlyHint: true },
            inputSchema,
          },
          {
            name: "write",
            annotations: { readOnlyHint: false, destructiveHint: true },
            inputSchema,
          },
          {
            name: "provider_only",
            annotations: { readOnlyHint: true },
            inputSchema: {
              type: "object",
              properties: { value: { $ref: "#/definitions/missing" } },
            },
          },
        ];
      },
      async callTool(name) {
        calls++;
        if (name === "provider_only") {
          throw new Error(
            'Malformed validation text: path=/value value="provider-secret"',
          );
        }
        return { content: [{ type: "text", text: "unexpected dispatch" }] };
      },
    };
    const mt = createMetaTools(makeRegistry([connector]), BASE);
    const args = {
      options: { enabled: "submitted-secret" },
    };
    const expected = {
      ok: false,
      attempts: 0,
      error: {
        code: "invalid_args",
        retryable: false,
        connector: "remote_strict",
        validation: {
          issues: [
            { path: "/title", code: "required", expected: "string" },
            {
              path: "/options/enabled",
              code: "type",
              expected: "boolean",
            },
          ],
        },
        nextAction: {
          tool: "search_tools",
          arguments: {
            connector: "remote_strict",
            includeSchemas: "compact",
          },
        },
      },
    };

    const direct = textOf(
      await mt.callTool({ address: "remote_strict.read", args }),
    );
    const destructive = textOf(
      await mt.callDestructiveTool({
        address: "remote_strict.write",
        args,
      }),
    );
    expect(direct).toMatchObject({
      ...expected,
      error: { ...expected.error, operation: "remote_strict.read" },
    });
    expect(destructive).toMatchObject({
      ...expected,
      error: { ...expected.error, operation: "remote_strict.write" },
    });

    expect(JSON.stringify([direct, destructive])).not.toContain(
      "submitted-secret",
    );
    expect(calls).toBe(0);

    const providerOnly = textOf(
      await mt.callTool({
        address: "remote_strict.provider_only",
        args: { value: "provider-secret" },
        resultMode: "value",
      }),
    ) as { error: { code: string; validation?: unknown } };
    expect(providerOnly.error).toMatchObject({
      code: "connector_call_failed",
    });
    expect(providerOnly.error.validation).toBeUndefined();
    expect(calls).toBe(1);
  });
});

// A connector returning a rich nested payload (for fields) and a big blob.
const dataConnector: Connector = {
  id: "data",
  kind: "api",
  description: "Data",
  async listTools() {
    return [
      {
        name: "get",
        description: "Get a nested record",
        annotations: { readOnlyHint: true },
        outputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            user: {
              type: "object",
              additionalProperties: false,
              properties: {
                name: { type: "string" },
                address: {
                  type: "object",
                  additionalProperties: false,
                  properties: { city: { type: "string" } },
                },
              },
            },
            results: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  id: { type: "number" },
                  optionalId: { type: "number" },
                  realNull: { type: "null" },
                },
              },
            },
            groups: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  results: {
                    type: "array",
                    items: {
                      type: "object",
                      additionalProperties: false,
                      properties: { id: { type: "number" } },
                    },
                  },
                },
              },
            },
          },
        },
      },
      {
        name: "big",
        description: "Return a large blob",
        annotations: { readOnlyHint: true },
      },
      {
        name: "loose",
        description: "Return a record without an output schema",
        annotations: { readOnlyHint: true },
      },
      {
        name: "empty",
        description: "Return an empty record with an optional declared field",
        annotations: { readOnlyHint: true },
        outputSchema: {
          type: "object",
          additionalProperties: false,
          properties: { title: { type: "string" } },
        },
      },
    ];
  },
  async callTool(name) {
    if (name === "get") {
      return {
        user: { name: "Ada", address: { city: "London" } },
        results: [
          { id: 1, optionalId: 10, realNull: null },
          { id: 2, realNull: null },
          { id: 3, optionalId: 30, realNull: null },
        ],
        groups: [
          { results: [{ id: 1 }, {}] },
          { results: [{ id: 3 }] },
        ],
      };
    }
    if (name === "big") return { blob: "x".repeat(500) };
    if (name === "loose") {
      return { a: 1, b: 2, results: [{ value: null }, {}] };
    }
    if (name === "empty") return {};
    throw new Error(`Unknown tool "${name}" on connector "data"`);
  },
};

// An mcp connector whose text block is JSON (for fields over content).
const jsonMcpConnector: Connector = {
  id: "jm",
  kind: "mcp",
  description: "JSON mcp",
  async listTools() {
    return [
      {
        name: "rec",
        description: "record",
        annotations: { readOnlyHint: true },
        outputSchema: {
          type: "object",
          additionalProperties: false,
          properties: { a: { type: "number" }, b: { type: "number" } },
        },
      },
      {
        name: "loose",
        description: "record without an output schema",
        annotations: { readOnlyHint: true },
      },
    ];
  },
  async callTool() {
    return {
      content: [{ type: "text", text: JSON.stringify({ a: 1, b: 2 }) }],
    };
  },
};

function deepProjectionSchema(): Record<string, unknown> {
  let nested: Record<string, unknown> = { type: "string" };
  for (let i = 0; i < 40; i++) {
    nested = {
      type: "object",
      additionalProperties: false,
      properties: { next: nested },
    };
  }
  return nested;
}

const projectionSchemaConnector: Connector = {
  id: "projection-schemas",
  kind: "api",
  description: "Projection schema edge cases",
  async listTools() {
    return [
      {
        name: "ref",
        annotations: { readOnlyHint: true },
        outputSchema: {
          $ref: "#/$defs/record",
          $defs: {
            record: {
              type: "object",
              additionalProperties: false,
              properties: { title: { type: "string" } },
            },
          },
        },
      },
      {
        name: "open",
        annotations: { readOnlyHint: true },
        outputSchema: {
          type: "object",
          properties: { known: { type: "string" } },
        },
      },
      {
        name: "ref-sibling",
        annotations: { readOnlyHint: true },
        outputSchema: {
          $ref: "#/$defs/record",
          type: "object",
          properties: { sibling: { type: "string" } },
          $defs: {
            record: {
              type: "object",
              additionalProperties: false,
              properties: { title: { type: "string" } },
            },
          },
        },
      },
      {
        name: "false-property",
        annotations: { readOnlyHint: true },
        outputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            forbidden: false,
            known: { type: "string" },
          },
        },
      },
      {
        name: "unresolved",
        annotations: { readOnlyHint: true },
        outputSchema: { $ref: "https://schemas.example/record.json" },
      },
      {
        name: "patterned",
        annotations: { readOnlyHint: true },
        outputSchema: {
          type: "object",
          additionalProperties: false,
          patternProperties: { "^x-": { type: "string" } },
          properties: { known: { type: "string" } },
        },
      },
      {
        name: "tuple",
        annotations: { readOnlyHint: true },
        outputSchema: {
          type: "array",
          prefixItems: [
            {
              type: "object",
              additionalProperties: false,
              properties: { id: { type: "number" } },
            },
          ],
          items: false,
        },
      },
      {
        name: "unselectable",
        annotations: { readOnlyHint: true },
        outputSchema: {
          type: "object",
          additionalProperties: false,
          properties: { "a.b": { type: "string" } },
        },
      },
      {
        name: "deep",
        annotations: { readOnlyHint: true },
        outputSchema: deepProjectionSchema(),
      },
      {
        name: "broad",
        annotations: { readOnlyHint: true },
        outputSchema: {
          type: "object",
          additionalProperties: false,
          properties: Object.fromEntries(
            Array.from({ length: 300 }, (_, i) => [
              `field${String(i).padStart(3, "0")}`,
              { type: "string" },
            ]),
          ),
        },
      },
      {
        name: "huge-key",
        annotations: { readOnlyHint: true },
        outputSchema: {
          type: "object",
          additionalProperties: false,
          properties: { ["x".repeat(100_000)]: { type: "string" } },
        },
      },
      {
        name: "character-heavy",
        annotations: { readOnlyHint: true },
        outputSchema: {
          type: "object",
          additionalProperties: false,
          properties: Object.fromEntries(
            Array.from({ length: 30 }, (_, i) => [
              `${String(i).padStart(2, "0")}-${"é".repeat(190)}`,
              { type: "string" },
            ]),
          ),
        },
      },
      {
        name: "collision",
        annotations: { readOnlyHint: true },
      },
    ];
  },
  async callTool(name) {
    if (name === "tuple") return [];
    if (name === "collision") {
      return {
        data: "downstream data",
        projection: "downstream projection",
        $connecta: "downstream namespace",
      };
    }
    return {};
  },
};

describe("call_tool fields selection", () => {
  it("keeps all-valid nested and array-map projections flat", async () => {
    const mt = createMetaTools(makeRegistry([dataConnector]), BASE);
    const parsed = textOf(
      await mt.callTool({
        address: "data.get",
        fields: ["user.address.city", "results[].id"],
      }),
    ) as Record<string, unknown>;
    expect(parsed).toEqual({
      "user.address.city": "London",
      "results[].id": [1, 2, 3],
    });
  });

  it("reports an element-level total miss without serializing false nulls", async () => {
    const mt = createMetaTools(makeRegistry([dataConnector]), BASE);
    const parsed = textOf(
      await mt.callTool({
        address: "data.get",
        fields: ["results[].missing"],
      }),
    );
    expect(parsed).toEqual({
      data: {},
      $connecta: {
        type: "field_projection",
        unmatchedFields: ["results[].missing"],
        schemaDeclared: true,
        schemaCoverage: "complete",
        invalidFields: ["results[].missing"],
        availableFields: [
          "groups",
          "groups[]",
          "groups[].results",
          "groups[].results[]",
          "groups[].results[].id",
          "results",
          "results[]",
          "results[].id",
          "results[].optionalId",
          "results[].realNull",
          "user",
          "user.address",
          "user.address.city",
          "user.name",
        ],
      },
    });
  });

  it("distinguishes partial element misses from genuine nulls", async () => {
    const mt = createMetaTools(makeRegistry([dataConnector]), BASE);
    expect(
      textOf(
        await mt.callTool({
          address: "data.get",
          fields: ["results[].optionalId"],
        }),
      ),
    ).toEqual({
      data: { "results[].optionalId": [10, null, 30] },
      $connecta: {
        type: "field_projection",
        unmatchedFields: [],
        partialFields: ["results[].optionalId"],
        schemaDeclared: true,
        schemaCoverage: "complete",
        availableFields: [
          "groups",
          "groups[]",
          "groups[].results",
          "groups[].results[]",
          "groups[].results[].id",
          "results",
          "results[]",
          "results[].id",
          "results[].optionalId",
          "results[].realNull",
          "user",
          "user.address",
          "user.address.city",
          "user.name",
        ],
      },
    });
    expect(
      textOf(
        await mt.callTool({
          address: "data.get",
          fields: ["results[].realNull"],
        }),
      ),
    ).toEqual({ "results[].realNull": [null, null, null] });
  });

  it("tracks misses through nested arrays", async () => {
    const mt = createMetaTools(makeRegistry([dataConnector]), BASE);
    expect(
      textOf(
        await mt.callTool({
          address: "data.get",
          fields: ["groups[].results[].id"],
        }),
      ),
    ).toEqual({
      data: { "groups[].results[].id": [[1, null], [3]] },
      $connecta: {
        type: "field_projection",
        unmatchedFields: [],
        partialFields: ["groups[].results[].id"],
        schemaDeclared: true,
        schemaCoverage: "complete",
        availableFields: [
          "groups",
          "groups[]",
          "groups[].results",
          "groups[].results[]",
          "groups[].results[].id",
          "results",
          "results[]",
          "results[].id",
          "results[].optionalId",
          "results[].realNull",
          "user",
          "user.address",
          "user.address.city",
          "user.name",
        ],
      },
    });
  });

  it("keeps an empty array traversal as a clean match", async () => {
    const connector: Connector = {
      ...dataConnector,
      id: "empty-array",
      async callTool() {
        return { results: [] };
      },
    };
    const mt = createMetaTools(makeRegistry([connector]), BASE);
    expect(
      textOf(
        await mt.callTool({
          address: "empty-array.get",
          fields: ["results[].id"],
        }),
      ),
    ).toEqual({ "results[].id": [] });
  });

  it("reports partial array misses without an output schema", async () => {
    const mt = createMetaTools(makeRegistry([dataConnector]), BASE);
    expect(
      textOf(
        await mt.callTool({
          address: "data.loose",
          fields: ["results[].value"],
        }),
      ),
    ).toEqual({
      data: { "results[].value": [null, null] },
      $connecta: {
        type: "field_projection",
        unmatchedFields: [],
        partialFields: ["results[].value"],
      },
    });
  });

  it("preserves API matches and reports schema-declared misses", async () => {
    const mt = createMetaTools(makeRegistry([dataConnector]), BASE);
    const parsed = textOf(
      await mt.callTool({
        address: "data.get",
        fields: ["user.address.city", "user.missing.deep"],
      }),
    ) as {
      data: Record<string, unknown>;
      $connecta: {
        type: string;
        unmatchedFields: string[];
        schemaDeclared: boolean;
        availableFields: string[];
      };
    };
    expect(parsed.data).toEqual({ "user.address.city": "London" });
    expect(parsed.$connecta).toMatchObject({
      type: "field_projection",
      unmatchedFields: ["user.missing.deep"],
      schemaDeclared: true,
      schemaCoverage: "complete",
      invalidFields: ["user.missing.deep"],
    });
    expect(parsed.$connecta.availableFields).toContain("user.address.city");
    expect(parsed.$connecta.availableFields).toContain("results[].id");
  });

  it("teaches array traversal when a plausible dot path misses", async () => {
    const mt = createMetaTools(makeRegistry([dataConnector]), BASE);
    const missed = textOf(
      await mt.callTool({
        address: "data.get",
        fields: ["results.id"],
      }),
    ) as {
      $connecta: {
        unmatchedFields: string[];
        hint: string;
      };
    };
    expect(missed.$connecta).toMatchObject({
      unmatchedFields: ["results.id"],
      hint:
        'Traverse arrays with [] after the array field name, for example "results[].id".',
    });

    expect(
      textOf(
        await mt.callTool({
          address: "data.get",
          fields: ["results[].id"],
        }),
      ),
    ).toEqual({ "results[].id": [1, 2, 3] });
  });

  it("reports all-unmatched API projections in value mode", async () => {
    const mt = createMetaTools(makeRegistry([dataConnector]), BASE);
    const parsed = textOf(
      await mt.callTool({
        address: "data.get",
        fields: ["title", "url"],
        resultMode: "value",
      }),
    ) as {
      ok: boolean;
      data: {
        data: Record<string, unknown>;
        $connecta: { unmatchedFields: string[] };
      };
    };
    expect(parsed).toMatchObject({
      ok: true,
      data: {
        data: {},
        $connecta: {
          type: "field_projection",
          unmatchedFields: ["title", "url"],
          schemaDeclared: true,
          schemaCoverage: "complete",
          invalidFields: ["title", "url"],
        },
      },
    });
  });

  it("reports undeclared API misses without claiming a complete field list", async () => {
    const mt = createMetaTools(makeRegistry([dataConnector]), BASE);
    const parsed = textOf(
      await mt.callTool({
        address: "data.loose",
        fields: ["a", "missing"],
      }),
    );
    expect(parsed).toEqual({
      data: { a: 1 },
      $connecta: {
        type: "field_projection",
        unmatchedFields: ["missing"],
      },
    });
  });

  it("distinguishes an absent declared value from an invalid path", async () => {
    const mt = createMetaTools(makeRegistry([dataConnector]), BASE);
    const parsed = textOf(
      await mt.callTool({ address: "data.empty", fields: ["title"] }),
    );
    expect(parsed).toEqual({
      data: {},
      $connecta: {
        type: "field_projection",
        unmatchedFields: ["title"],
        schemaDeclared: true,
        schemaCoverage: "complete",
        availableFields: ["title"],
      },
    });
  });

  it("keeps all-valid JSON MCP text projections compatible", async () => {
    const mt = createMetaTools(makeRegistry([jsonMcpConnector]), BASE);
    const result = await mt.callTool({ address: "jm.rec", fields: ["a"] });
    expect(JSON.parse(required(result.content[0]).text)).toEqual({ a: 1 });
  });

  it("adds declared-schema guidance to JSON MCP misses", async () => {
    const mt = createMetaTools(makeRegistry([jsonMcpConnector]), BASE);
    const result = await mt.callTool({
      address: "jm.rec",
      fields: ["a", "missing"],
    });
    expect(JSON.parse(required(result.content[0]).text)).toEqual({
      data: { a: 1 },
      $connecta: {
        type: "field_projection",
        unmatchedFields: ["missing"],
        schemaDeclared: true,
        schemaCoverage: "complete",
        invalidFields: ["missing"],
        availableFields: ["a", "b"],
      },
    });
  });

  it("reports JSON MCP misses without inventing undeclared schema fields", async () => {
    const mt = createMetaTools(makeRegistry([jsonMcpConnector]), BASE);
    const result = await mt.callTool({
      address: "jm.loose",
      fields: ["a", "missing"],
    });
    expect(JSON.parse(required(result.content[0]).text)).toEqual({
      data: { a: 1 },
      $connecta: {
        type: "field_projection",
        unmatchedFields: ["missing"],
      },
    });
  });

  it("resolves a closed local $ref before identifying invalid fields", async () => {
    const mt = createMetaTools(
      makeRegistry([projectionSchemaConnector]),
      BASE,
    );
    const parsed = textOf(
      await mt.callTool({
        address: "projection-schemas.ref",
        fields: ["title", "url"],
      }),
    ) as {
      $connecta: Record<string, unknown>;
    };
    expect(parsed.$connecta).toEqual({
      type: "field_projection",
      unmatchedFields: ["title", "url"],
      schemaDeclared: true,
      schemaCoverage: "complete",
      invalidFields: ["url"],
      availableFields: ["title"],
    });
  });

  it("does not advertise false-schema properties as selectable", async () => {
    const mt = createMetaTools(
      makeRegistry([projectionSchemaConnector]),
      BASE,
    );
    const parsed = textOf(
      await mt.callTool({
        address: "projection-schemas.false-property",
        fields: ["forbidden"],
      }),
    ) as {
      $connecta: Record<string, unknown>;
    };
    expect(parsed.$connecta).toEqual({
      type: "field_projection",
      unmatchedFields: ["forbidden"],
      schemaDeclared: true,
      schemaCoverage: "complete",
      invalidFields: ["forbidden"],
      availableFields: ["known"],
    });
  });

  it("treats semantic $ref siblings as partial without advertised fields", async () => {
    const mt = createMetaTools(
      makeRegistry([projectionSchemaConnector]),
      BASE,
    );
    const parsed = textOf(
      await mt.callTool({
        address: "projection-schemas.ref-sibling",
        fields: ["title"],
      }),
    ) as {
      $connecta: Record<string, unknown>;
    };
    expect(parsed.$connecta).toEqual({
      type: "field_projection",
      unmatchedFields: ["title"],
      schemaDeclared: true,
      schemaCoverage: "partial",
    });
  });

  it.each(["open", "unresolved", "patterned", "tuple", "unselectable"])(
    "does not claim invalid fields for a %s schema",
    async (name) => {
      const mt = createMetaTools(
        makeRegistry([projectionSchemaConnector]),
        BASE,
      );
      const parsed = textOf(
        await mt.callTool({
          address: `projection-schemas.${name}`,
          fields: ["missing"],
        }),
      ) as {
        $connecta: Record<string, unknown>;
      };
      expect(parsed.$connecta).toMatchObject({
        type: "field_projection",
        unmatchedFields: ["missing"],
        schemaDeclared: true,
        schemaCoverage: "partial",
      });
      expect(parsed.$connecta).not.toHaveProperty("invalidFields");
    },
  );

  it("bounds deep, broad, and large-path schemas before rendering feedback", async () => {
    const mt = createMetaTools(
      makeRegistry([projectionSchemaConnector]),
      BASE,
    );
    for (const name of [
      "deep",
      "broad",
      "huge-key",
      "character-heavy",
    ]) {
      const result = await mt.callTool({
        address: `projection-schemas.${name}`,
        fields: ["missing"],
      });
      const text = required(result.content[0]).text;
      const parsed = JSON.parse(text) as {
        $connecta: Record<string, unknown>;
      };
      expect(parsed.$connecta).toMatchObject({
        schemaCoverage: "partial",
        availableFieldsTruncated: true,
      });
      expect(parsed.$connecta).not.toHaveProperty("invalidFields");
      expect(text.length).toBeLessThan(1_000);
    }
  });

  it("keeps colliding downstream field names below reserved metadata", async () => {
    const mt = createMetaTools(
      makeRegistry([projectionSchemaConnector]),
      BASE,
    );
    const parsed = textOf(
      await mt.callTool({
        address: "projection-schemas.collision",
        fields: ["data", "projection", "$connecta", "missing"],
      }),
    );
    expect(parsed).toEqual({
      data: {
        data: "downstream data",
        projection: "downstream projection",
        $connecta: "downstream namespace",
      },
      $connecta: {
        type: "field_projection",
        unmatchedFields: ["missing"],
      },
    });
  });

  it("escapes an all-valid downstream $connecta field", async () => {
    const mt = createMetaTools(
      makeRegistry([projectionSchemaConnector]),
      BASE,
    );
    const parsed = textOf(
      await mt.callTool({
        address: "projection-schemas.collision",
        fields: ["data", "$connecta"],
      }),
    );
    expect(parsed).toEqual({
      data: {
        data: "downstream data",
        $connecta: "downstream namespace",
      },
      $connecta: {
        type: "field_projection",
        unmatchedFields: [],
      },
    });
  });
});

describe("call_tool size guard + get_result", () => {
  it("truncates oversized results and pages the rest via get_result", async () => {
    const registryWithData = makeRegistry([dataConnector], {
      maxResultBytes: 100,
    });
    const mt = createMetaTools(registryWithData, BASE);
    const result = await mt.callTool({ address: "data.big" });
    const lines = required(result.content[0]).text.split("\n");
    const notice = JSON.parse(required(lines[lines.length - 1])) as {
      truncated: boolean;
      resultId: string;
      totalBytes: number;
      nextAction: {
        tool: string;
        arguments: { id: string; offset: number };
      };
    };
    expect(notice.truncated).toBe(true);
    expect(notice.totalBytes).toBeGreaterThan(100);
    expect(notice.nextAction).toEqual({
      tool: "get_result",
      arguments: { id: notice.resultId, offset: 0 },
    });

    // Round-trip the full text back through get_result.
    let offset = 0;
    let assembled = "";
    for (;;) {
      const page = textOf(
        await mt.getResult({ id: notice.resultId, offset, maxBytes: 100 }),
      ) as { text: string; nextOffset?: number; totalBytes: number };
      assembled += page.text;
      if (page.nextOffset === undefined) break;
      offset = page.nextOffset;
    }
    expect(assembled).toBe(JSON.stringify({ blob: "x".repeat(500) }));
  });

  it("returns an error for an unknown/expired result id", async () => {
    const mt = createMetaTools(makeRegistry([dataConnector]), BASE);
    const result = await mt.getResult({ id: "nope" });
    expect(result.isError).toBe(true);
    expect(required(result.content[0]).text).toContain("Unknown or expired");
  });

  it("replaces oversized value-mode data with a page handle", async () => {
    const mt = createMetaTools(
      makeRegistry([dataConnector], { maxResultBytes: 100 }),
      BASE,
    );
    const parsed = textOf(
      await mt.callTool({
        address: "data.big",
        resultMode: "value",
      }),
    ) as {
      ok: boolean;
      data: { truncated: boolean; resultId: string; totalBytes: number };
    };

    expect(parsed.ok).toBe(true);
    expect(parsed.data.truncated).toBe(true);
    expect(parsed.data.totalBytes).toBeGreaterThan(100);
    expect(parsed.data).toMatchObject({
      nextAction: {
        tool: "get_result",
        arguments: { id: parsed.data.resultId, offset: 0 },
      },
    });
    const page = textOf(
      await mt.getResult({ id: parsed.data.resultId, maxBytes: 1_000 }),
    ) as { text: string };
    expect(JSON.parse(page.text)).toEqual({ blob: "x".repeat(500) });
  });

  it("pages multi-byte content at a codepoint-splitting boundary byte-exactly", async () => {
    // "aa😀bb" — the emoji is 4 UTF-8 bytes, so a 4-byte page ending at byte 4
    // lands mid-codepoint. Reassembly must equal the original with no U+FFFD.
    const original = JSON.stringify({ v: "aa😀bb界🎉cc" });
    const conn: Connector = {
      id: "mb",
      kind: "api",
      description: "Multibyte",
      async listTools() {
        return [
          {
            name: "get",
            description: "unicode",
            annotations: { readOnlyHint: true },
          },
        ];
      },
      async callTool() {
        return JSON.parse(original);
      },
    };
    // cap of 4 forces truncation and 4-byte pages that split codepoints.
    const mt = createMetaTools(
      makeRegistry([conn], { maxResultBytes: 4 }),
      BASE,
    );
    const call = await mt.callTool({ address: "mb.get" });
    const lines = required(call.content[0]).text.split("\n");
    const notice = JSON.parse(required(lines[lines.length - 1])) as { resultId: string };

    const expected = JSON.stringify(JSON.parse(original));
    let offset = 0;
    let assembled = "";
    for (;;) {
      const page = textOf(
        await mt.getResult({ id: notice.resultId, offset, maxBytes: 4 }),
      ) as { text: string; nextOffset?: number };
      expect(page.text).not.toContain("�");
      assembled += page.text;
      if (page.nextOffset === undefined) break;
      offset = page.nextOffset;
    }
    expect(assembled).toBe(expected);
  });

  it("guardText's truncated head never ends in a replacement char", async () => {
    // Emoji straddles the cap boundary; the head must stop before it.
    const conn: Connector = {
      id: "mb2",
      kind: "api",
      description: "Multibyte head",
      async listTools() {
        return [
          {
            name: "get",
            description: "unicode",
            annotations: { readOnlyHint: true },
          },
        ];
      },
      async callTool() {
        return "abc😀defghijklmnop";
      },
    };
    const mt = createMetaTools(
      makeRegistry([conn], { maxResultBytes: 5 }),
      BASE,
    );
    const call = await mt.callTool({ address: "mb2.get" });
    const head = required(call.content[0]).text.split("\n")[0];
    expect(head).not.toContain("�");
    // Head is a byte-exact prefix of the original (JSON-encoded) string.
    const full = JSON.stringify("abc😀defghijklmnop");
    expect(full.startsWith(required(head))).toBe(true);
  });
});

describe("per-connector maxResultBytes override", () => {
  // ASCII, so byte length == char length, and it JSON-encodes to one line —
  // the truncation notice is therefore always exactly the second line.
  const PAYLOAD = "x".repeat(500);
  const FULL = JSON.stringify(PAYLOAD); // 502 bytes

  /** An api connector returning PAYLOAD, optionally under its own byte cap. */
  function capped(id: string, maxResultBytes?: number): Connector {
    return {
      id,
      kind: "api",
      description: "Capped",
      ...(maxResultBytes !== undefined ? { maxResultBytes } : {}),
      async listTools() {
        return [
          {
            name: "big",
            description: "Return a large blob",
            annotations: { readOnlyHint: true },
          },
        ];
      },
      async callTool() {
        return PAYLOAD;
      },
    };
  }

  interface Notice {
    truncated: boolean;
    resultId: string;
    totalBytes: number;
  }

  /** Split a guarded text result into its head and its truncation notice. */
  function truncation(result: { content: { text: string }[] }): {
    head: string;
    notice: Notice;
  } {
    const [head, notice] = required(result.content[0]).text.split("\n");
    return {
      head: required(head),
      notice: JSON.parse(required(notice)) as Notice,
    };
  }

  it("truncates at a connector cap lower than the global one", async () => {
    const mt = createMetaTools(
      makeRegistry([capped("tight", 100)], { maxResultBytes: 400 }),
      BASE,
    );
    const { head, notice } = truncation(
      await mt.callTool({ address: "tight.big" }),
    );
    expect(head).toBe(FULL.slice(0, 100));
    expect(notice.truncated).toBe(true);
    expect(notice.totalBytes).toBe(FULL.length);
  });

  it("keeps a result inline under a connector cap higher than the global one", async () => {
    const mt = createMetaTools(
      makeRegistry([capped("wide", 1_000)], { maxResultBytes: 100 }),
      BASE,
    );
    const result = await mt.callTool({ address: "wide.big" });
    expect(required(result.content[0]).text).toBe(FULL);
  });

  it("falls back to the global cap when a connector declares no override", async () => {
    const mt = createMetaTools(
      makeRegistry([capped("plain")], { maxResultBytes: 300 }),
      BASE,
    );
    const { head, notice } = truncation(
      await mt.callTool({ address: "plain.big" }),
    );
    expect(head).toBe(FULL.slice(0, 300));
    expect(notice.totalBytes).toBe(FULL.length);
  });

  it("falls back to the registry default when nothing is configured", async () => {
    // 502 bytes is far below the built-in 50_000, so nothing truncates.
    const mt = createMetaTools(makeRegistry([capped("plain")]), BASE);
    const result = await mt.callTool({ address: "plain.big" });
    expect(required(result.content[0]).text).toBe(FULL);
  });

  it("pages a result truncated under an override through get_result", async () => {
    const mt = createMetaTools(
      makeRegistry([capped("tight", 100)], { maxResultBytes: 400 }),
      BASE,
    );
    const { notice } = truncation(await mt.callTool({ address: "tight.big" }));

    let offset = 0;
    let assembled = "";
    for (;;) {
      const page = textOf(
        await mt.getResult({ id: notice.resultId, offset, maxBytes: 64 }),
      ) as { text: string; nextOffset?: number; totalBytes: number };
      expect(page.totalBytes).toBe(FULL.length);
      assembled += page.text;
      if (page.nextOffset === undefined) break;
      offset = page.nextOffset;
    }
    expect(assembled).toBe(FULL);
  });

  it("pages an override-truncated result with get_result's default page size", async () => {
    // Cap above the global one but below the payload: truncation happens at
    // the connector's 300 while get_result, given no maxBytes, falls back to
    // the deployment-wide 100 — so this covers both the larger-than-global
    // truncation and get_result's default page size in one round trip.
    const mt = createMetaTools(
      makeRegistry([capped("wide", 300)], { maxResultBytes: 100 }),
      BASE,
    );
    const { head, notice } = truncation(
      await mt.callTool({ address: "wide.big" }),
    );
    expect(head).toBe(FULL.slice(0, 300));

    let offset = 0;
    let assembled = "";
    let pages = 0;
    for (;;) {
      const page = textOf(
        await mt.getResult({ id: notice.resultId, offset }),
      ) as { text: string; nextOffset?: number; totalBytes: number };
      pages++;
      expect(page.totalBytes).toBe(FULL.length);
      expect(page.text.length).toBeLessThanOrEqual(100);
      assembled += page.text;
      if (page.nextOffset === undefined) break;
      offset = page.nextOffset;
    }
    // 502 bytes in 100-byte default pages — the global cap, not the 300 the
    // connector truncated at.
    expect(pages).toBe(6);
    expect(assembled).toBe(FULL);
  });

  it("value mode honours the override too", async () => {
    const mt = createMetaTools(
      makeRegistry([capped("tight", 100), capped("wide", 1_000)], {
        maxResultBytes: 400,
      }),
      BASE,
    );
    const truncated = textOf(
      await mt.callTool({ address: "tight.big", resultMode: "value" }),
    ) as { data: { truncated?: boolean; totalBytes?: number } };
    const inline = textOf(
      await mt.callTool({ address: "wide.big", resultMode: "value" }),
    ) as { data: unknown };

    expect(truncated.data.truncated).toBe(true);
    expect(truncated.data.totalBytes).toBe(FULL.length);
    expect(inline.data).toBe(PAYLOAD);
  });
});

describe("maxResultBytes validation", () => {
  // Same 502-byte fixture as the override suite above, so the measured heads
  // line up with the numbers in issue #32.
  const PAYLOAD = "x".repeat(500);
  const FULL = JSON.stringify(PAYLOAD); // 502 bytes

  /** Caps that are accepted today but silently do something wrong (issue #32). */
  const BAD_CAPS = [0, -1, -50, 1.5, Number.NaN, Number.POSITIVE_INFINITY];

  function capped(id: string, maxResultBytes?: number): Connector {
    return {
      id,
      kind: "api",
      description: "Capped",
      ...(maxResultBytes !== undefined ? { maxResultBytes } : {}),
      async listTools() {
        return [
          {
            name: "big",
            description: "Return a large blob",
            annotations: { readOnlyHint: true },
          },
        ];
      },
      async callTool() {
        return PAYLOAD;
      },
    };
  }

  /** Stash an oversized result and hand back its page id. */
  async function stash(): Promise<{
    mt: ReturnType<typeof createMetaTools>;
    resultId: string;
  }> {
    const mt = createMetaTools(
      makeRegistry([capped("c")], { maxResultBytes: 100 }),
      BASE,
    );
    const call = await mt.callTool({ address: "c.big" });
    const notice = JSON.parse(required(required(call.content[0]).text.split("\n")[1])) as {
      resultId: string;
    };
    return { mt, resultId: notice.resultId };
  }

  it("rejects a get_result maxBytes of 0 instead of never advancing", async () => {
    // Pre-fix this returned { offset: 0, nextOffset: 0, text: "" } — a client
    // paging on nextOffset loops forever.
    const { mt, resultId } = await stash();
    const result = await mt.getResult({ id: resultId, offset: 0, maxBytes: 0 });
    expect(result.isError).toBe(true);
    expect(required(result.content[0]).text).toContain("Invalid maxBytes 0");
  });

  it("rejects every get_result maxBytes that is not a whole positive byte count", async () => {
    const { mt, resultId } = await stash();
    for (const maxBytes of BAD_CAPS) {
      const result = await mt.getResult({ id: resultId, maxBytes });
      expect(result.isError, `maxBytes ${String(maxBytes)}`).toBe(true);
      expect(required(result.content[0]).text).toContain("Invalid maxBytes");
    }
  });

  it("accepts the 1-byte floor and still pages to completion", async () => {
    const { mt, resultId } = await stash();
    let offset = 0;
    let assembled = "";
    for (let guard = 0; guard < FULL.length + 10; guard++) {
      const page = textOf(
        await mt.getResult({ id: resultId, offset, maxBytes: 1 }),
      ) as { text: string; nextOffset?: number };
      assembled += page.text;
      if (page.nextOffset === undefined) break;
      expect(page.nextOffset).toBeGreaterThan(offset);
      offset = page.nextOffset;
    }
    expect(assembled).toBe(FULL);
  });

  it("always advances past the offset, whatever end is asked for", () => {
    // Belt and braces behind the argument check: an empty or inverted window
    // must still yield forward progress rather than nextOffset === offset.
    const bytes = new TextEncoder().encode('"aa😀bb"');
    for (const end of [-5, 0, 1, 2]) {
      expect(
        alignEndToCharBoundary(bytes, 1, end, bytes.length),
        `end ${end}`,
      ).toBeGreaterThan(1);
    }
    // At a multi-byte codepoint the widened window still lands on a boundary:
    // byte 3 starts the 4-byte emoji, so the whole emoji comes along.
    expect(alignEndToCharBoundary(bytes, 3, 3, bytes.length)).toBe(7);
  });

  it("ignores a deployment cap that would zero or invert the guard", async () => {
    for (const maxResultBytes of BAD_CAPS) {
      const mt = createMetaTools(
        makeRegistry([capped("c")], { maxResultBytes }),
        BASE,
      );
      const result = await mt.callTool({ address: "c.big" });
      // Falls back to the built-in 50_000, so 502 bytes stay inline whole —
      // never an empty head (0/NaN) or an over-long one (negatives).
      expect(required(result.content[0]).text, `cap ${String(maxResultBytes)}`).toBe(FULL);
    }
  });

  it("ignores a connector override that would zero or invert the guard", async () => {
    for (const override of BAD_CAPS) {
      const mt = createMetaTools(
        makeRegistry([capped("c", override)], { maxResultBytes: 400 }),
        BASE,
      );
      const result = await mt.callTool({ address: "c.big" });
      const [head] = required(result.content[0]).text.split("\n");
      // Inherits the deployment-wide 400 exactly as an unset override would.
      expect(head, `override ${String(override)}`).toBe(FULL.slice(0, 400));
    }
  });

  it("warns with the very cap a call then falls back to", async () => {
    // The startup warning quotes a number; a call inheriting that fallback
    // must truncate at exactly it, or the warning tells operators a fiction.
    const warnings: string[] = [];
    const registry = new Registry([capped("c", 0)], {
      storage: memoryStorage(),
      logger: {
        ...silentLogger,
        warn: (...args: unknown[]) => warnings.push(String(args[0])),
      },
      maxResultBytes: 400,
    });
    const warning = warnings.find((w) => w.includes("Ignoring the override"));
    const warned = Number(/\((\d+)\)\.$/.exec(warning ?? "")?.[1]);
    expect(warned).toBe(400);

    const result = await createMetaTools(registry, BASE).callTool({
      address: "c.big",
    });
    expect(required(result.content[0]).text.split("\n")[0]).toBe(FULL.slice(0, warned));
  });

  it("leaves valid caps byte-identical at every level", async () => {
    // The floor, a tiny cap, and a cap either side of the payload — all
    // unchanged by validation.
    for (const cap of [1, 4, 100, 400, 1_000]) {
      const viaGlobal = await createMetaTools(
        makeRegistry([capped("c")], { maxResultBytes: cap }),
        BASE,
      ).callTool({ address: "c.big" });
      const viaOverride = await createMetaTools(
        makeRegistry([capped("c", cap)], { maxResultBytes: 50_000 }),
        BASE,
      ).callTool({ address: "c.big" });
      const expected = cap >= FULL.length ? FULL : FULL.slice(0, cap);
      expect(required(viaGlobal.content[0]).text.split("\n")[0], `global ${cap}`).toBe(
        expected,
      );
      expect(
        required(viaOverride.content[0]).text.split("\n")[0],
        `override ${cap}`,
      ).toBe(expected);
    }
  });
});

/** UTF-8 byte length, the unit every cap and offset in these suites is in. */
function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Assert a result is valid against the MCP schema as a client receives it. */
function overTheWire(result: unknown): {
  content: { type: string; text?: string }[];
} {
  const serialized = JSON.parse(JSON.stringify(result));
  const parsed =
    specTypeSchemas.CallToolResult["~standard"].validate(serialized);
  expect(parsed.issues, JSON.stringify(serialized)).toBeUndefined();
  return serialized;
}

describe("handler returns JSON cannot represent", () => {
  /** An api connector whose one read-only tool returns `value`. */
  function returning(value: unknown): Connector {
    return api("ret", {
      description: "Returns a canned value",
      tools: [
        {
          name: "get",
          description: "Return the canned value",
          inputSchema: { type: "object" },
          annotations: { readOnlyHint: true },
          handler: () => value,
        },
      ],
    });
  }

  function callFor(value: unknown) {
    return createMetaTools(makeRegistry([returning(value)]), BASE).callTool({
      address: "ret.get",
    });
  }

  it("renders an undefined return as text instead of a block with no text", async () => {
    // Pre-fix this emitted `{"type":"text"}` — schema-invalid, because
    // JSON.stringify(undefined) is undefined and the size guard measured the
    // empty string the TextEncoder substituted for it (issue #42).
    const result = await callFor(undefined);
    expect(overTheWire(result).content).toEqual([
      { type: "text", text: "undefined" },
    ]);
  });

  it("renders the other returns JSON drops the same way", async () => {
    // A function and a Symbol also serialize as `undefined`.
    const fn = () => 1;
    const sym = Symbol("marker");
    for (const value of [fn, sym]) {
      const result = await callFor(value);
      expect(overTheWire(result).content).toEqual([
        { type: "text", text: String(value) },
      ]);
    }
  });

  it("renders null as JSON null on both result paths", async () => {
    // `null` was never the hole — JSON renders it as "null" — so this pins it.
    const mcp = await callFor(null);
    expect(overTheWire(mcp).content).toEqual([{ type: "text", text: "null" }]);

    const value = await createMetaTools(
      makeRegistry([returning(null)]),
      BASE,
    ).callTool({ address: "ret.get", resultMode: "value" });
    expect(overTheWire(value)).toBeTruthy();
    expect(textOf(value)).toMatchObject({ ok: true, data: null });
  });

  it("carries no data for an undefined return in value mode", async () => {
    // JSON has no `undefined`, so the envelope simply omits the key — a
    // well-formed answer, unlike the block the mcp path used to emit.
    const result = await createMetaTools(
      makeRegistry([returning(undefined)]),
      BASE,
    ).callTool({ address: "ret.get", resultMode: "value" });
    const parsed = textOf(result) as Record<string, unknown>;
    expect(overTheWire(result)).toBeTruthy();
    expect(parsed.ok).toBe(true);
    expect("data" in parsed).toBe(false);
  });

  it("leaves a serializable return byte-identical", async () => {
    const value = { user: { name: "Ada" }, ids: [1, 2, 3] };
    const result = await callFor(value);
    expect(required(result.content[0]).text).toBe(JSON.stringify(value));
  });

  it("stashes an oversized undefined-adjacent return under the same text", async () => {
    // The guard measures and stashes one string on every path, so what pages
    // back is what was measured — even for a return JSON cannot represent.
    const long = "y".repeat(500);
    const mt = createMetaTools(
      makeRegistry([returning(long)], { maxResultBytes: 100 }),
      BASE,
    );
    const call = await mt.callTool({ address: "ret.get" });
    const notice = JSON.parse(required(required(call.content[0]).text.split("\n")[1])) as {
      resultId: string;
      totalBytes: number;
    };
    const full = JSON.stringify(long);
    expect(notice.totalBytes).toBe(byteLength(full));
    const page = textOf(
      await mt.getResult({ id: notice.resultId, maxBytes: 10_000 }),
    ) as { text: string };
    expect(page.text).toBe(full);
  });
});

describe("mcp-mode content size guard", () => {
  /** A kind:"mcp" connector whose one tool returns `content` verbatim. */
  function downstream(content: unknown[]): Connector {
    return {
      id: "down",
      kind: "mcp",
      description: "Downstream MCP",
      async listTools() {
        return [
          {
            name: "fetch",
            description: "Return canned content",
            annotations: { readOnlyHint: true },
          },
        ];
      },
      async callTool() {
        return { content };
      },
    };
  }

  function metaTools(content: unknown[], maxResultBytes?: number) {
    return createMetaTools(
      makeRegistry(
        [downstream(content)],
        maxResultBytes !== undefined ? { maxResultBytes } : {},
      ),
      BASE,
    );
  }

  /** What `call_tool` stashes and pages for an oversized mcp result. */
  function envelope(content: unknown[]): string {
    return JSON.stringify(content);
  }

  interface Notice {
    truncated: boolean;
    resultId: string;
    totalBytes: number;
  }

  it("measures the envelope it truncates, not just the text inside it", async () => {
    // 12 blocks of 20 characters: 240 bytes of text, but a 700+ byte envelope
    // once block wrappers, keys, quoting and indentation are counted. Pre-fix
    // the decision used the 240 while the head and totalBytes were cut from
    // the envelope, so a cap between the two returned everything inline and a
    // cap under both described a string it never compared against (issue #43).
    const content = Array.from({ length: 12 }, (_, i) => ({
      type: "text",
      text: `block-${i}`.padEnd(20, "x"),
    }));
    const full = envelope(content);
    const textOnly = content.reduce((n, b) => n + byteLength(b.text), 0);
    const cap = 300;
    expect(textOnly).toBeLessThan(cap);
    expect(byteLength(full)).toBeGreaterThan(cap);

    const result = await metaTools(content, cap).callTool({
      address: "down.fetch",
    });
    const lines = required(result.content[0]).text.split("\n");
    const notice = JSON.parse(required(lines[lines.length - 1])) as Notice;
    const head = lines.slice(0, -1).join("\n");
    expect(notice.truncated).toBe(true);
    // One unit for all three: the cap, the head served, and totalBytes.
    expect(notice.totalBytes).toBe(byteLength(full));
    expect(head).toBe(full.slice(0, cap));
    expect(byteLength(head)).toBeLessThanOrEqual(cap);
  });

  it("bounds an all-image result and hands back a page handle", async () => {
    // Pre-fix contentBytes([image]) was 0, so `0 > cap` was false and the whole
    // 50 KB envelope came back inline with no resultId to page from — the one
    // guarantee maxResultBytes exists to give, missing entirely.
    const content = [
      { type: "image", data: "A".repeat(50_000), mimeType: "image/png" },
    ];
    const full = envelope(content);
    const cap = 1_000;
    const mt = metaTools(content, cap);
    const result = await mt.callTool({ address: "down.fetch" });

    expect(overTheWire(result).content).toHaveLength(1);
    const notice = JSON.parse(required(result.content[0]).text) as Notice;
    expect(notice.truncated).toBe(true);
    expect(notice.totalBytes).toBe(byteLength(full));
    expect(byteLength(required(result.content[0]).text)).toBeLessThan(cap);
    // The notice alone — no prefix of a base64 image, which no client could use.
    expect(required(result.content[0]).text).not.toContain("AAAA");

    let offset = 0;
    let assembled = "";
    for (;;) {
      const page = textOf(
        await mt.getResult({ id: notice.resultId, offset, maxBytes: 10_000 }),
      ) as { text: string; nextOffset?: number; totalBytes: number };
      expect(page.totalBytes).toBe(byteLength(full));
      assembled += page.text;
      if (page.nextOffset === undefined) break;
      offset = page.nextOffset;
    }
    expect(assembled).toBe(full);
    expect(JSON.parse(assembled)).toEqual(content);
  });

  it("counts text and non-text blocks together", async () => {
    const content = [
      { type: "text", text: "a caption" },
      {
        type: "resource",
        resource: { uri: "file:///big", text: "z".repeat(5_000) },
      },
    ];
    const result = await metaTools(content, 1_000).callTool({
      address: "down.fetch",
    });
    const notice = JSON.parse(required(result.content[0]).text) as Notice;
    expect(notice.truncated).toBe(true);
    expect(notice.totalBytes).toBe(byteLength(envelope(content)));
  });

  it("passes an unserializable under-cap result through instead of failing", async () => {
    // The guard has to serialize the envelope to measure it, but a block
    // carrying a BigInt or a cycle cannot be serialized — and could not be
    // stashed or paged either, so the cap has nothing to offer it. Such a result
    // came back inline under the old text-only measure; failing it with
    // result_processing_failed would be a regression, not a fix.
    const withBigInt = [{ type: "text", text: "small", size: 1n }];
    const circular: Record<string, unknown>[] = [
      { type: "text", text: "small" },
    ];
    required(circular[0]).self = circular[0];
    for (const content of [withBigInt, circular]) {
      const result = await metaTools(content).callTool({
        address: "down.fetch",
      });
      expect(result.isError).toBeUndefined();
      expect(result.content).toHaveLength(1);
      expect(required(result.content[0]).text).toBe("small");
    }
    // The block reaches the client exactly as the downstream produced it.
    const result = await metaTools(withBigInt).callTool({
      address: "down.fetch",
    });
    expect((result.content[0] as unknown as Record<string, unknown>).size).toBe(
      1n,
    );
  });

  it("passes an under-cap result through untouched, blocks and order intact", async () => {
    const content = [
      { type: "text", text: "first" },
      { type: "image", data: "AAA", mimeType: "image/png" },
      { type: "text", text: "last" },
    ];
    const result = await metaTools(content).callTool({ address: "down.fetch" });
    expect(result.content).toEqual(content);
    expect(overTheWire(result).content).toEqual(content);
  });
});

describe("get_result offset validation and alignment", () => {
  // Stored as `"aa😀bb"` — byte 3 starts the 4-byte emoji, so bytes 4, 5 and 6
  // are inside a character and byte 3 is the boundary they belong to.
  const PAYLOAD = "aa😀bb";
  const FULL = JSON.stringify(PAYLOAD);
  const EMOJI_START = 3;

  async function stash(): Promise<{
    mt: ReturnType<typeof createMetaTools>;
    resultId: string;
  }> {
    const conn = api("mb", {
      description: "Multibyte",
      tools: [
        {
          name: "get",
          description: "unicode",
          inputSchema: { type: "object" },
          annotations: { readOnlyHint: true },
          handler: () => PAYLOAD,
        },
      ],
    });
    // A cap of 1 stashes the payload whole while keeping the inline head tiny.
    const mt = createMetaTools(
      makeRegistry([conn], { maxResultBytes: 1 }),
      BASE,
    );
    const call = await mt.callTool({ address: "mb.get" });
    const lines = required(call.content[0]).text.split("\n");
    const notice = JSON.parse(required(lines[lines.length - 1])) as { resultId: string };
    return { mt, resultId: notice.resultId };
  }

  it("rejects an in-process offset that is not a whole byte count", async () => {
    // The tier #32 chose to defend for maxBytes: MCP callers are stopped by the
    // registered schema, in-process callers of createMetaTools are not. Pre-fix
    // `offset: NaN` answered with `"offset": null`, empty text and no
    // nextOffset — the result silently vanished instead of erroring (issue #38).
    const { mt, resultId } = await stash();
    for (const offset of [
      -1,
      -50,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      const result = await mt.getResult({ id: resultId, offset });
      expect(result.isError, `offset ${String(offset)}`).toBe(true);
      expect(required(result.content[0]).text).toContain("Invalid offset");
    }
  });

  it("aligns an offset landing inside a character and reports the one served", async () => {
    // Pre-fix these decoded the severed bytes as U+FFFD.
    const { mt, resultId } = await stash();
    for (const requested of [4, 5, 6]) {
      const page = textOf(
        await mt.getResult({ id: resultId, offset: requested, maxBytes: 100 }),
      ) as { text: string; offset: number; totalBytes: number };
      expect(page.text, `offset ${requested}`).not.toContain("�");
      expect(page.offset, `offset ${requested}`).toBe(EMOJI_START);
      expect(page.text).toBe("😀bb\"");
      expect(page.totalBytes).toBe(byteLength(FULL));
    }
  });

  it("leaves a boundary-aligned offset byte-identical", async () => {
    const { mt, resultId } = await stash();
    // Every boundary in the payload, including the ones paging produces.
    for (const offset of [0, 1, 2, EMOJI_START, 7, 8]) {
      const page = textOf(
        await mt.getResult({ id: resultId, offset, maxBytes: 100 }),
      ) as { text: string; offset: number };
      expect(page.offset, `offset ${offset}`).toBe(offset);
      expect(page.text).not.toContain("�");
    }
    // And a full paging loop still reassembles the stashed text exactly.
    let offset = 0;
    let assembled = "";
    for (;;) {
      const page = textOf(
        await mt.getResult({ id: resultId, offset, maxBytes: 3 }),
      ) as { text: string; nextOffset?: number };
      expect(page.text).not.toContain("�");
      assembled += page.text;
      if (page.nextOffset === undefined) break;
      offset = page.nextOffset;
    }
    expect(assembled).toBe(FULL);
  });

  it("answers an offset past the end with an empty final page", async () => {
    // Still a whole number of bytes, so still legal: an empty last page rather
    // than an error, and nothing to align.
    const { mt, resultId } = await stash();
    const page = textOf(
      await mt.getResult({ id: resultId, offset: byteLength(FULL) + 5 }),
    ) as { text: string; offset: number; nextOffset?: number };
    expect(page.text).toBe("");
    expect(page.offset).toBe(byteLength(FULL) + 5);
    expect(page.nextOffset).toBeUndefined();
  });

  it("moves a start offset back to the character it lands inside", () => {
    const bytes = new TextEncoder().encode(FULL);
    expect([4, 5, 6].map((o) => alignStartToCharBoundary(bytes, o))).toEqual([
      3, 3, 3,
    ]);
    for (const o of [0, 1, 2, 3, 7, 8, 9]) {
      expect(alignStartToCharBoundary(bytes, o), `offset ${o}`).toBe(o);
    }
    // Past the end there is no character to split.
    expect(alignStartToCharBoundary(bytes, bytes.length + 5)).toBe(
      bytes.length + 5,
    );
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
    const noUrl: Connector = {
      id: "nourl",
      kind: "mcp",
      async listTools() {
        throw new Error("unauthorized");
      },
      async callTool() {
        throw new Error("unauthorized");
      },
      async startAuth() {
        return { state: "auth_required" };
      },
    };
    const mt = createMetaTools(makeRegistry([noUrl]), BASE);
    const result = await mt.authorizeConnector({ connector: "nourl" });
    expect(result.isError).toBe(true);
    expect(required(result.content[0]).text).toContain("no URL is available");
  });

  it("surfaces a startAuth error state as a structured error status (not isError)", async () => {
    const errConn: Connector = {
      id: "erroauth",
      kind: "mcp",
      async listTools() {
        throw new Error("x");
      },
      async callTool() {
        throw new Error("x");
      },
      async startAuth() {
        return { state: "error", message: "connect ECONNREFUSED" };
      },
    };
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
    const throwConn: Connector = {
      id: "throws",
      kind: "mcp",
      async listTools() {
        throw new Error("x");
      },
      async callTool() {
        throw new Error("x");
      },
      async startAuth() {
        throw new Error("boom during force");
      },
    };
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
        {
          id: "vaulted",
          kind: "api",
          description: "Operator credential",
          credential: { label: "API key" },
          async listTools() {
            return [];
          },
          async callTool() {
            return null;
          },
        },
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
  const hangingConnector: Connector = {
    id: "hang",
    kind: "mcp",
    description: "Never resolves",
    listTools() {
      return new Promise<never>(() => {});
    },
    async callTool() {
      throw new Error("n/a");
    },
  };

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
    const typed: Connector = {
      id: "billing",
      kind: "api",
      async listTools() {
        throw new ConnectorCallError(
          "unavailable",
          `Upstream returned 503. Operator must restore access. ${"x".repeat(1_000)}`,
          { retryAfterMs: 30_000 },
        );
      },
      async callTool() {
        return null;
      },
    };
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
  const unavailable = (): Connector => ({
    id: "billing",
    kind: "api",
    usageGuide: {
      content: "# Billing\n\nInvoice ids are prefixed.\n",
      summary: "Invoice ids are prefixed.",
      required: true,
    },
    async listTools() {
      throw new ConnectorCallError(
        "unavailable",
        "Upstream returned 503. Operator must restore access.",
        { retryAfterMs: 30_000 },
      );
    },
    async callTool() {
      return null;
    },
  });

  /** A connector that answers, correctly, with nothing. */
  const barren: Connector = {
    id: "barren",
    kind: "api",
    async listTools() {
      return [];
    },
    async callTool() {
      return null;
    },
  };

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
  const barren: Connector = {
    id: "barren",
    kind: "api",
    async listTools() {
      return [];
    },
    async callTool() {
      return null;
    },
  };

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
