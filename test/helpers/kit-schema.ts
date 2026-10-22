import { Schema } from "effect";
import type { ApiTool } from "../../src/connectors/api-connector.js";
import { kitInput } from "../../src/http/tools.js";
import { validateToolInput } from "../../src/validate.js";

// Every value an agent could send at each property's edges: the validator
// api() runs on the rendered catalog and the Schema the builder decodes
// with must accept exactly the same ones, or a call passes validation and
// dies in decoding (a defect whose text api() withholds).
const EDGES: unknown[] = [
  0,
  -1,
  1,
  1.5,
  99,
  100,
  2 ** 53,
  -(2 ** 53),
  Number.MAX_SAFE_INTEGER,
  1e21,
  "",
  " ",
  "a",
  "x".repeat(512),
  "x".repeat(513),
  // Lengths count code points, as api()'s validator does, never UTF-16 units.
  "😀",
  "😀".repeat(256),
  "/" + "😀".repeat(300),
  "😀".repeat(512),
  "😀".repeat(513),
  "x".repeat(511) + "😀",
  // A combining mark is its own code point.
  "e\u0301",
  "e\u0301".repeat(256),
  "e\u0301".repeat(257),
  // A lone surrogate counts as one, high or low, alone or in a run.
  "\ud800",
  "\udc00",
  "\udc00\ud800",
  "\ud800".repeat(512),
  "\ud800".repeat(513),
  "x".repeat(511) + "\ud83d",
  "POST",
  "GET",
  "asc",
  true,
  null,
  [],
  {},
  [{ name: "a", value: 1 }],
  [{ name: "", value: 1 }],
  [{ name: "a", value: null }],
  Array.from({ length: 51 }, () => ({ name: "a", value: "b" })),
];

export function kitInputDisagreements(tool: ApiTool, base: Record<string, unknown>): string[] {
  const input = kitInput(tool)!;
  const schema = tool.inputSchema!;
  const out: string[] = [];
  for (const name of Object.keys(schema["properties"] as object)) {
    for (const value of EDGES) {
      const args = { ...base, [name]: value };
      const validated = validateToolInput(schema, args, { address: tool.name, failClosed: true }) === null;
      const decoded =
        Schema.decodeUnknownExit(input as Schema.Codec<unknown>, { onExcessProperty: "error" })(args)._tag ===
        "Success";
      if (validated !== decoded) out.push(`${tool.name}.${name} = ${JSON.stringify(value)}`);
    }
  }
  return out;
}
