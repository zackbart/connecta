import type { JsonSchema } from "../../src/types.js";

export const PRIVATE_MARKER = "private-argument-marker-987654321";
const privateField = { type: "string", writeOnly: true };
const config = { type: "object", properties: { label: { type: "string" }, password: privateField } };
const value = { label: "database", password: PRIVATE_MARKER };
const safeValue = { label: "database" };
const nestedArgs = { target: "project-1", config: value };
const nestedEcho = { args: { target: "project-1", config: safeValue }, argsRedacted: true as const };
const withheld = { argsRedacted: true as const };
interface PrivateArgumentCase {
  name: string;
  schema: JsonSchema;
  args: Record<string, unknown>;
  echo: { args?: unknown; argsRedacted: true };
}

export const privateArgumentCases: PrivateArgumentCase[] = [
  { name: "malformed writeOnly annotation", schema: { type: "object", properties: { config: { properties: { password: { writeOnly: "true" } } } } }, args: nestedArgs, echo: withheld },
  { name: "dynamic ref", schema: { type: "object", properties: { config: { $dynamicRef: "#node" } } }, args: nestedArgs, echo: withheld },
  { name: "nested properties", schema: { type: "object", properties: { config } }, args: nestedArgs, echo: nestedEcho },
  {
    name: "array items",
    schema: { type: "object", properties: { configs: { type: "array", items: config } } },
    args: { configs: [value, { ...value, label: "replica" }] },
    echo: { args: { configs: [safeValue, { label: "replica" }] }, argsRedacted: true },
  },
  {
    name: "prefixItems and trailing items",
    schema: { type: "object", properties: { configs: { type: "array", prefixItems: [{ type: "string" }, config], items: config } } },
    args: { configs: ["public prefix", value, value] },
    echo: { args: { configs: ["public prefix", safeValue, safeValue] }, argsRedacted: true },
  },
  {
    name: "legacy tuple items",
    schema: { type: "object", properties: { configs: { type: "array", items: [{ type: "string" }, config], additionalItems: config } } },
    args: { configs: ["public prefix", value, value] },
    echo: { args: { configs: ["public prefix", safeValue, safeValue] }, argsRedacted: true },
  },
  {
    name: "private array elements",
    schema: { type: "object", properties: { secrets: { type: "array", items: privateField } } },
    args: { target: "project-1", secrets: [PRIVATE_MARKER] },
    echo: { args: { target: "project-1" }, argsRedacted: true },
  },
  {
    name: "local ref and escaped definition pointer",
    schema: { type: "object", $defs: { "config/entry~": config }, properties: { config: { $ref: "#/$defs/config~1entry~0" } } },
    args: nestedArgs, echo: nestedEcho,
  },
  {
    name: "ref siblings",
    schema: { type: "object", $defs: { config: { properties: { label: {} } } }, properties: { config: { $ref: "#/$defs/config", properties: { password: privateField } } } },
    args: nestedArgs, echo: nestedEcho,
  },
  {
    name: "allOf at multiple depths",
    schema: { type: "object", allOf: [{ properties: { config: { allOf: [{ properties: { password: privateField } }, { properties: { label: {} } }] } } }, { properties: { target: {} } }] },
    args: nestedArgs, echo: nestedEcho,
  },
  {
    name: "allOf array offsets",
    schema: { type: "object", properties: { configs: { allOf: [{ prefixItems: [{}], items: config }, { prefixItems: [config, {}], items: { properties: { password: privateField } } }] } } },
    args: { configs: [value, value, value] },
    echo: { args: { configs: [safeValue, safeValue, safeValue] }, argsRedacted: true },
  },
  ...["oneOf", "anyOf"].flatMap((keyword): PrivateArgumentCase[] => [
    {
      name: `${keyword} agreeing sensitivity`,
      schema: { type: "object", [keyword]: [{ properties: { mode: { const: "private" }, config } }, { properties: { mode: { const: "public" }, config } }] },
      args: { ...nestedArgs, mode: "private" },
      echo: { args: { ...nestedEcho.args as object, mode: "private" }, argsRedacted: true },
    },
    {
      name: `${keyword} disagreeing sensitivity`,
      schema: { type: "object", [keyword]: [{ properties: { mode: { const: "private" }, config } }, { properties: { mode: { const: "public" }, config: { properties: { password: { writeOnly: false } } } } }] },
      args: { ...nestedArgs, mode: "private" }, echo: withheld,
    },
  ]),
  { name: "root writeOnly", schema: { type: "object", writeOnly: true }, args: nestedArgs, echo: withheld },
  ...["https://schemas.example/private.json", "#/$defs/missing", "#unknown-anchor"].map((ref): PrivateArgumentCase => ({
    name: `unresolved ref ${ref}`, schema: { type: "object", properties: { config: { $ref: ref } } }, args: nestedArgs, echo: withheld,
  })),
  {
    name: "recursive ref",
    schema: { type: "object", $defs: { node: { properties: { password: privateField, child: { $ref: "#/$defs/node" } } } }, properties: { config: { $ref: "#/$defs/node" } } },
    args: nestedArgs, echo: withheld,
  },
  {
    name: "sensitive patternProperties",
    schema: { type: "object", patternProperties: { "^config$": config } }, args: nestedArgs, echo: withheld,
  },
  {
    name: "sensitive additionalProperties ref",
    schema: { type: "object", $defs: { config }, additionalProperties: { $ref: "#/$defs/config" } }, args: { config: value }, echo: withheld,
  },
  {
    name: "conditional sensitivity",
    // oxlint-disable-next-line unicorn/no-thenable -- JSON Schema keyword, not a promise method.
    schema: { type: "object", if: { properties: { mode: { const: "private" } } }, then: { properties: { config } } }, args: nestedArgs, echo: withheld,
  },
];
