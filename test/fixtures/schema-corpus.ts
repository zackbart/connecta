import type { JsonSchema } from "../../src/types.js";

/**
 * Tool schemas as maintained providers' live `tools/list` responses served
 * them in September 2026, captured through a connecta deployment's JSON
 * search. They are a rendering corpus, not a contract: remote MCP schemas stay
 * owned by the live response, so drift here is harmless and nothing checks
 * these against the provider. Descriptions are trimmed where the length added
 * nothing but bytes; every structural keyword is as served.
 */

const DRAFT = "https://json-schema.org/draft/2020-12/schema";

/** Linear `list_issues`: 21 optional filters, a string-enum array, a type list. */
export const LINEAR_LIST_ISSUES: JsonSchema = {
  type: "object",
  properties: {
    limit: { default: 50, description: "Max results (default 50, max 250)", type: "number", maximum: 250 },
    cursor: { description: "Next page cursor", type: "string" },
    orderBy: { default: "updatedAt", description: "Sort: createdAt | updatedAt", type: "string", enum: ["createdAt", "updatedAt"] },
    query: { description: "Search issue title or description. Cannot be combined with customView", type: "string" },
    customView: { description: "Saved view ID, URL, slug, or exact name.", type: "string", minLength: 1 },
    team: { description: "Team name or ID", type: "string" },
    state: { description: "State type, name, or ID", type: "string" },
    cycle: { description: "Cycle name, number, or ID", type: "string" },
    label: { description: "Label name or ID", type: "string" },
    assignee: { description: "User ID, name, email, or \"me\"", type: ["string", "null"] },
    creator: { description: "User ID, name, email, or \"me\"", type: "string" },
    delegate: { description: "Agent name or ID.", type: "string" },
    project: { description: "Project name, ID, identifier (e.g., P-ENG-123), or slug", type: "string" },
    release: { description: "Release ID or slug", type: "string" },
    priority: { description: "0=None, 1=Urgent, 2=High, 3=Medium, 4=Low", type: "number" },
    parentId: { description: "Parent issue ID or identifier (e.g., LIN-123)", type: "string" },
    fields: {
      description: "Fields to include in each result. `id` is always included.",
      type: "array",
      items: {
        type: "string",
        enum: [
          "id", "uuid", "title", "description", "projectMilestone", "priority",
          "estimate", "url", "gitBranchName", "createdAt", "updatedAt",
          "archivedAt", "completedAt", "startedAt", "canceledAt",
          "startedTriageAt", "triagedAt", "dueDate", "slaStartedAt",
          "slaMediumRiskAt", "slaHighRiskAt", "slaBreachesAt", "slaType",
          "status", "statusType", "labels", "triageIntel", "createdBy",
          "createdById", "assignee", "assigneeId", "delegate", "delegateId",
          "project", "projectId", "parentId", "team", "teamId", "cycleId",
        ],
      },
    },
    createdAt: { description: "Created after: ISO-8601 date/duration (e.g., -P1D)", type: "string" },
    updatedAt: { description: "Updated after: ISO-8601 date/duration (e.g., -P1D)", type: "string" },
    triagedAt: { description: "Left triage after: ISO-8601 date/duration (e.g., -P1D).", type: "string" },
    includeArchived: { default: false, description: "Include archived items", type: "boolean" },
  },
  $schema: DRAFT,
  additionalProperties: false,
};

/** Linear `list_issue_statuses`: the smallest real shape, one required key. */
export const LINEAR_LIST_ISSUE_STATUSES: JsonSchema = {
  type: "object",
  properties: { team: { type: "string", description: "Team name or ID" } },
  required: ["team"],
  $schema: DRAFT,
  additionalProperties: false,
};

/**
 * Linear `save_issue`, abridged to the keys that exercise the renderer: a
 * `oneOf` of `const`-discriminated patch operations inside an array, `anyOf`
 * with a null member, and a date-time pattern long enough to cost real bytes.
 */
export const LINEAR_SAVE_ISSUE: JsonSchema = {
  type: "object",
  properties: {
    id: { description: "Only for updating an existing issue.", type: "string" },
    title: { description: "Issue title (required when creating, unless template is set)", type: "string" },
    patch: {
      description: "Partial edits applied to the current content, in order and atomically.",
      minItems: 1,
      maxItems: 50,
      type: "array",
      items: {
        oneOf: [
          {
            type: "object",
            properties: {
              op: { type: "string", const: "replace" },
              old_string: { type: "string", minLength: 1, description: "Exact text to replace." },
              new_string: { type: "string", description: "Replacement text. Empty string deletes the match" },
              replace_all: { description: "Replace every occurrence instead of requiring a unique match", type: "boolean" },
            },
            required: ["op", "old_string", "new_string"],
          },
          {
            type: "object",
            properties: {
              op: { type: "string", const: "append" },
              text: { type: "string", minLength: 1, description: "Text to insert at the very end of the content" },
            },
            required: ["op", "text"],
          },
        ],
      },
    },
    team: { description: "Team name or ID (required when creating)", type: "string" },
    cycle: { description: "Cycle name, number, or ID. Null to remove", type: ["string", "null"] },
    priority: { description: "0=None, 1=Urgent, 2=High, 3=Medium, 4=Low", type: "number" },
    labels: { description: "Label names or IDs.", type: "array", items: { type: "string" } },
    slaBreachesAt: {
      description: "ISO-8601 timestamp when the SLA will breach. On update, pass null to remove the SLA",
      anyOf: [
        {
          type: "string",
          format: "date-time",
          pattern: "^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d(?:\\.\\d+)?(?:Z|[+-]\\d\\d:\\d\\d)$",
        },
        { type: "null" },
      ],
    },
    slaType: {
      description: "SLA day counting type: \"all\" or \"onlyBusinessDays\".",
      anyOf: [{ type: "string", enum: ["all", "onlyBusinessDays"] }, { type: "null" }],
    },
    estimate: { description: "Issue estimate value.", type: ["number", "null"] },
    links: {
      description: "Link attachments to add [{url, title}].",
      type: "array",
      items: {
        type: "object",
        properties: {
          url: { type: "string", format: "uri" },
          title: { type: "string", minLength: 1 },
        },
        required: ["url", "title"],
      },
    },
  },
  $schema: DRAFT,
  additionalProperties: false,
};

/** Stripe `list_available_accounts_or_orgs`: no input, a declared output. */
export const STRIPE_LIST_ACCOUNTS_INPUT: JsonSchema = {
  type: "object",
  properties: {},
};

export const STRIPE_LIST_ACCOUNTS_OUTPUT: JsonSchema = {
  type: "object",
  properties: {
    accounts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          stripe_context: {
            type: "string",
            description: "Value to pass as Stripe-Context tool param when targeting this account, can be account_id or org_id",
          },
          livemode: { type: "boolean", description: "Whether the account is in livemode" },
          name: { type: "string", description: "Name of the account or org" },
        },
        required: ["stripe_context", "livemode"],
      },
    },
  },
  required: ["accounts"],
};

/** Stripe `stripe_implementation_planner`: required keys declared last. */
export const STRIPE_IMPLEMENTATION_PLANNER: JsonSchema = {
  type: "object",
  properties: {
    guide_id: { description: "ONLY pass a guide_id that was returned by a previous call to this tool.", type: "string" },
    message: { description: "For new guides: describe the use case or business requirements.", type: "string" },
    accept: { description: "Set to true when returning the completed decision trees.", type: "boolean" },
    selected_leaf_nodes: { type: "array", items: { type: "string" }, description: "The IDs of all terminal leaves reached." },
    stripe_context: { type: "string", description: "The account to target for this request." },
    livemode: { type: "boolean", description: "Whether to operate in livemode (true) or test mode/ sandbox (false)." },
  },
  required: ["stripe_context", "livemode"],
};

/** RevenueCat `list-subscriptions`: kebab-case address, integer bounds, enum array. */
export const REVENUECAT_LIST_SUBSCRIPTIONS: JsonSchema = {
  type: "object",
  properties: {
    project_id: { type: "string", maxLength: 255, description: "ID of the project" },
    customer_id: { type: "string", minLength: 1, maxLength: 1500, description: "ID of the customer" },
    environment: { type: "string", enum: ["sandbox", "production"], description: "Filter by environment, omit to include both." },
    starting_after: { type: "string", description: "Pagination cursor." },
    limit: { default: 20, type: "integer", minimum: -9007199254740991, maximum: 9007199254740991, description: "Maximum number of items to return per page." },
    expand: {
      type: "array",
      items: { type: "string", enum: ["items.redemption"] },
      description: "Specifies which fields in the response should be expanded.\n Accepted values are: `items.redemption`.",
    },
  },
  required: ["project_id", "customer_id"],
  $schema: DRAFT,
};

/** Every provider shape above as an input/output pair, keyed by address. */
export const PROVIDER_CORPUS: ReadonlyArray<{
  address: string;
  input: JsonSchema;
  output?: JsonSchema;
}> = [
  { address: "linear.list_issues", input: LINEAR_LIST_ISSUES },
  { address: "linear.list_issue_statuses", input: LINEAR_LIST_ISSUE_STATUSES },
  { address: "linear.save_issue", input: LINEAR_SAVE_ISSUE },
  {
    address: "stripe.list_available_accounts_or_orgs",
    input: STRIPE_LIST_ACCOUNTS_INPUT,
    output: STRIPE_LIST_ACCOUNTS_OUTPUT,
  },
  {
    address: "stripe.stripe_implementation_planner",
    input: STRIPE_IMPLEMENTATION_PLANNER,
  },
  {
    address: "revenuecat.list-subscriptions",
    input: REVENUECAT_LIST_SUBSCRIPTIONS,
  },
];

function nested(depth: number): JsonSchema {
  let schema: JsonSchema = { type: "string" };
  for (let level = 0; level < depth; level += 1) {
    schema = { type: "object", properties: { next: schema }, required: ["next"] };
  }
  return schema;
}

/**
 * Shapes built to hurt a renderer: each must degrade to a bounded, flagged
 * `unknown` rather than exploding, looping, or quietly claiming exactness.
 */
export const PATHOLOGICAL_CORPUS: Readonly<Record<string, JsonSchema>> = {
  deepNesting: nested(40),
  hugeEnum: {
    type: "object",
    properties: {
      code: { enum: Array.from({ length: 5_000 }, (_, index) => `code_${index}`) },
    },
    required: ["code"],
  },
  refCycle: {
    $ref: "#/$defs/Node",
    $defs: {
      Node: {
        type: "object",
        properties: {
          value: { type: "string" },
          children: { type: "array", items: { $ref: "#/$defs/Node" } },
        },
        required: ["value"],
      },
    },
  },
  mutualRefCycle: {
    type: "object",
    properties: { a: { $ref: "#/definitions/A" } },
    definitions: {
      A: { type: "object", properties: { b: { $ref: "#/definitions/B" } } },
      B: { type: "object", properties: { a: { $ref: "#/definitions/A" } } },
    },
  },
  unresolvedRef: {
    type: "object",
    properties: { owner: { $ref: "#/$defs/Missing" } },
  },
  composites2020: {
    type: "object",
    properties: {
      point: { type: "array", prefixItems: [{ type: "number" }, { type: "number" }], items: false },
      tagged: { type: "array", prefixItems: [{ const: "tag" }], items: { type: "integer" } },
      shipping: {
        type: "object",
        properties: { method: { enum: ["post", "pickup"] }, address: { type: "string" } },
        if: { properties: { method: { const: "post" } } },
        // oxlint-disable-next-line unicorn/no-thenable -- JSON Schema keyword, not a promise method.
        then: { required: ["address"] },
      },
      billing: {
        type: "object",
        properties: { card: { type: "string" } },
        dependentSchemas: { card: { required: ["cvc"] } },
      },
      tree: { $dynamicRef: "#node" },
      merged: {
        allOf: [
          { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
          { type: "object", properties: { name: { type: "string" } } },
        ],
      },
    },
  },
  wideObject: {
    type: "object",
    properties: Object.fromEntries(
      Array.from({ length: 3_000 }, (_, index) => [`field_${index}`, { type: "string" }]),
    ),
  },
  wideUnion: {
    anyOf: Array.from({ length: 3_000 }, (_, index) => ({
      type: "object",
      properties: { [`k${index}`]: { type: "number" } },
    })),
  },
  hostileText: {
    type: "object",
    properties: {
      "*/ evil": {
        type: "string",
        description: "closes */ the comment } ) ] and opens /* another",
      },
      "kebab-key": { type: "string", description: "a) stray bracket" },
      union: {
        type: "array",
        items: {
          oneOf: [
            { type: "object", properties: { x: { type: "string", description: "b) c)" } } },
            { type: "number" },
          ],
        },
      },
      pattern: { type: "string", pattern: "a*/b|c" },
    },
  },
  openApiNullable: {
    type: "object",
    properties: {
      name: { type: "string", nullable: true },
      tags: { type: "array", items: { type: "string" }, nullable: true },
    },
  },
  indexSignature: {
    type: "object",
    properties: { id: { type: "string" } },
    additionalProperties: { type: "integer" },
    required: ["id"],
  },
  booleanSchemas: {
    type: "object",
    properties: { anything: true, nothing: false, bare: {} },
  },
};
