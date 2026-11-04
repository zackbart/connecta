/** Deterministic distractors use private ledgers, never the task ledger. */
import { z } from "zod";
import { FakeService, Ledger, type FakeTool } from "./service.js";

const IDS = ["billing_ops", "helpdesk", "docs_store", "people", "warehouse", "marketing"];
const VERBS = ["list", "get", "search", "create", "update", "archive", "export", "reconcile"];
const OBJECTS = ["issues", "invoices", "messages", "customers", "logs", "subscriptions", "records", "campaigns"];
const FIELDS = [
  "query",
  "status",
  "limit",
  "cursor",
  "customerId",
  "filters",
  "includeArchived",
  "sort",
  "tags",
  "metadata",
];
export function catalogServices(count: number): FakeService[] {
  return IDS.flatMap((id, connector) => {
    const tools: FakeTool[] = [];
    for (let i = connector; i < count; i += IDS.length) {
      const sequence = Math.floor(i / IDS.length);
      const verb = VERBS[sequence % VERBS.length]!;
      const object = OBJECTS[Math.floor(sequence / VERBS.length) % OBJECTS.length]!;
      const name = `${verb}_${object}_${Math.floor(sequence / 64) + 1}`;
      const properties = Object.fromEntries(
        FIELDS.slice(0, 1 + (i % 10)).map((field) => [
          field,
          field === "limit"
            ? z.number().int().min(1).max(100).optional()
            : field === "status"
              ? z.enum(["active", "pending", "closed"]).optional()
              : field === "includeArchived"
                ? z.boolean().optional()
                : field === "tags"
                  ? z.array(z.string()).optional()
                  : field === "filters" || field === "metadata"
                    ? z
                        .object({ region: z.enum(["north", "south"]).optional(), owner: z.string().optional() })
                        .optional()
                    : z.string().optional(),
        ]),
      );
      const read = ["list", "get", "search", "export"].includes(verb);
      tools.push({
        name,
        description: (
          `${verb} ${object} in the ${id} workspace. Supports scoped operational records and stable identifiers. ` +
          "Filter by lifecycle status and customer reference; results include public timestamps and summary fields. ".repeat(
            i % 5,
          )
        ).slice(0, 500),
        input: z.object(properties),
        annotations: { readOnlyHint: read, destructiveHint: !read, idempotentHint: read },
        run: () => ({ json: { connector: id, operation: name, records: [], revision: 1 } }),
      });
    }
    return tools.length
      ? [new FakeService(id, `Operational ${id} catalog for workspace records and reporting.`, tools, new Ledger())]
      : [];
  });
}
