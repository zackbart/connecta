// Public re-export of the JSON Schema validator connecta itself uses, so
// downstream code that validates at build time (a manifest generator asserting
// its own output, say) resolves the same implementation and version through an
// explicit subpath rather than through npm hoisting.
export { Validator } from "@cfworker/json-schema";
export type {
  OutputUnit,
  Schema,
  SchemaDraft,
  ValidationResult,
} from "@cfworker/json-schema";
