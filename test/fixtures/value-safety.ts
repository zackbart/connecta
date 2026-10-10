// The shared value-safety harness (decision 0005, "Value safety"). Every REST
// vendor runs it from its own `value-safety.node.test.ts` over its reviewed
// table, its pinned index, and the candidates `providers:spec` derived from
// the pinned spec. It fails on:
//
// - candidates derived from another pin, detector format, or detector option;
// - a flagged operation without a verdict;
// - a verdict for an operation the pinned index does not carry;
// - a verdict without a reason, a redact verdict without paths, or a path
//   outside the path language;
// - a flagged response field no `redact` path, `keep` path, reviewed URL, or
//   vendor-wide field review accounts for;
// - a `keep` (by path or by field name) that exempts anything below it;
// - a `refuse` verdict that reaches transport through the generic tools;
// - a reviewed operation whose failure echoes the vendor's error text;
// - a moved verdict count (a reviewed change updates it with the table).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConnectorCallError } from "../../src/errors.js";
import type { OperationIndex } from "../../src/providers/_shared/rest/operation-index.js";
import {
  CREDENTIAL_SUFFIX,
  CREDENTIAL_WORDS,
  METADATA_NAMES,
  METADATA_SUFFIXES,
  credentialName,
  REDACTED,
  validPath,
  valueSafety,
  type ValueSafetyTable,
} from "../../src/providers/_shared/rest/value-safety.js";
import type { Connector, ConnectorContext } from "../../src/types.js";

const script = (await import(new URL("../../scripts/value-safety.mjs", import.meta.url).href)) as {
  VALUE_SAFETY_FORMAT: number;
  CREDENTIAL_WORDS: string[];
  CREDENTIAL_SUFFIX: RegExp;
  METADATA_SUFFIXES: string[];
  METADATA_NAMES: string[];
  credentialName(name: string): boolean;
};

interface Candidates {
  format: number;
  digest: string;
  options?: unknown;
  candidates: Record<string, { fields: string[]; named: boolean }>;
}

export interface ValueSafetyHarness {
  readonly table: ValueSafetyTable;
  readonly index: OperationIndex;
  /** The provider's `openapi.source.json`. */
  readonly source: { digest: string; options?: { valueSafety?: unknown } };
  /** The provider's `value-safety.candidates.json`. */
  readonly candidates: Candidates;
  /** `{ refuse, redact, safe }`: a moved count is a reviewed change. */
  readonly counts: { refuse: number; redact: number; safe: number };
  /**
   * A flagged spec field as the path into the data a tool returns ("" for
   * the whole data), or undefined for a field the tools never return (an
   * envelope's paging metadata). Defaults to the field itself.
   */
  dataPath?(field: string): string | undefined;
  /** A connector over this table, for the refusal sweep. */
  connector(): Connector;
  /** A context whose credential is set. */
  ctx(): ConnectorContext;
  /** A concrete path for a template; defaults to every `{param}` as `x`. */
  fill?(template: string): string;
  /** A reviewed operation answering a failure that echoes a marker; its vendor text must be withheld. */
  readonly echo: {
    readonly tool: string;
    readonly args: Record<string, unknown>;
    respond(marker: string): Response;
  };
}

/** Names that are a credential wherever they appear; no vendor-wide review may keep one. */
const CORE_CREDENTIALS: ReadonlySet<string> = new Set([
  "token",
  "tokens",
  "secret",
  "secrets",
  "password",
  "passphrase",
  "apikey",
  "api_key",
  "access_token",
  "accesstoken",
  "refresh_token",
  "private_key",
  "privatekey",
  "client_secret",
  "clientsecret",
  "authorization",
  "cookie",
  "cookies",
  "credential",
  "credentials",
  "jwt",
  "signature",
]);

/** A path's named segments as the coverage check compares them: list markers dropped, maps as `*`. */
function segments(path: string): string[] {
  return path
    .replace(/^(?:url|origin):/, "")
    .replace(/#url$/, "")
    .replace(/\{\}/g, ".*")
    .replace(/\[\??[a-z]*\]|@keys/g, "")
    .split(".")
    .filter(Boolean);
}

/** Whether a reviewed path covers a field: the field, anything inside it, or a reviewed part of it. */
function covers(cover: string, field: string): boolean {
  const parts = segments(cover);
  const at = segments(field);
  const length = Math.min(parts.length, at.length);
  return parts.slice(0, length).every((part, index) => part === "*" || at[index] === "*" || part === at[index]);
}

/** A body that holds `leaf` at a reviewed path. */
function nest(path: string, leaf: unknown): unknown {
  const parts = path
    .replace(/^(?:url|origin):/, "")
    .replace(/#url$/, "")
    .split(".")
    .flatMap((part) => part.match(/\[\??[a-z]*\]|\{\}|@keys|[^[\]{}@]+/g) ?? []);
  let value = leaf;
  for (const part of [...parts].reverse()) {
    if (part.startsWith("[")) value = [value];
    else if (part === "{}" || part === "*") value = { any: value };
    else if (part !== "@keys") value = { [part]: value };
  }
  return value;
}

export function describeValueSafety(name: string, harness: ValueSafetyHarness): void {
  const { table, index, candidates } = harness;
  const safety = valueSafety(table, () => index);
  const operations = Object.entries(table.operations);
  const fields = table.fields ?? {};

  describe(`${name} value safety`, () => {
    it("matches the detection script's credential vocabulary and metadata lists", () => {
      expect(CREDENTIAL_WORDS).toEqual(script.CREDENTIAL_WORDS);
      expect(CREDENTIAL_SUFFIX.source).toBe(script.CREDENTIAL_SUFFIX.source);
      expect(METADATA_SUFFIXES).toEqual(script.METADATA_SUFFIXES);
      expect(METADATA_NAMES).toEqual(script.METADATA_NAMES);
      for (const sample of ["clientSecret", "x-vercel-protection-bypass", "privateKeyPem", "jwt", "tokenId", "input_tokens"]) {
        expect(credentialName(sample), sample).toBe(script.credentialName(sample));
      }
    });

    it("INV-5: reviews every operation the pinned spec flags, from candidates derived at that pin", () => {
      expect(candidates.digest, "candidates come from the pinned document").toBe(harness.source.digest);
      expect(candidates.format, "candidates come from the current detector").toBe(script.VALUE_SAFETY_FORMAT);
      const options = harness.source.options?.valueSafety;
      expect(candidates.options ?? {}, "candidates come from the source record's detector options").toEqual(
        typeof options === "object" && options !== null ? options : {},
      );
      const unreviewed = Object.keys(candidates.candidates).filter((key) => !Object.hasOwn(table.operations, key));
      expect(unreviewed, "flagged operations without a verdict").toEqual([]);
    });

    it("INV-5: reviews only operations the index carries, each with a reason and valid paths", () => {
      const counts = { refuse: 0, redact: 0, safe: 0 };
      for (const [key, verdict] of operations) {
        const [method, path] = key.split(" ") as [string, string];
        expect(index.operation(method, path), `${key} is in the pinned index`).toBeDefined();
        expect(verdict.reason.trim(), key).not.toBe("");
        counts[verdict.verdict] += 1;
        if (verdict.verdict === "refuse") continue;
        if (verdict.verdict === "redact") expect(verdict.paths.length, key).toBeGreaterThan(0);
        const paths = [
          ...(verdict.verdict === "redact" ? verdict.paths : []),
          ...(verdict.keep ?? []),
          ...(verdict.urls ?? []),
        ];
        for (const path of paths) expect(validPath(path), `${key}: ${path}`).toBe(true);
      }
      for (const [field, review] of Object.entries(fields)) expect(review.reason.trim(), field).not.toBe("");
      expect(counts).toEqual(harness.counts);
    });

    it("INV-5: accounts for every flagged response field with a redact path, a keep, or a field review", () => {
      const uncovered: string[] = [];
      for (const [key, { fields: flagged }] of Object.entries(candidates.candidates)) {
        const verdict = table.operations[key];
        if (!verdict || verdict.verdict === "refuse") continue;
        const covered = [
          ...(verdict.verdict === "redact" ? verdict.paths : []),
          ...(verdict.keep ?? []),
          ...(verdict.urls ?? []),
        ];
        for (const field of flagged) {
          const path = harness.dataPath ? harness.dataPath(field) : field;
          if (path === undefined || path === "") continue;
          const named = segments(path);
          // A field review covers the field and anything inside it.
          if (named.some((segment) => Object.hasOwn(fields, segment))) continue;
          // A permission scope list under a reviewed scope map is action names, never a secret.
          if (named.length > 1 && (table.scopeMaps ?? []).includes(named.at(-2)!)) continue;
          if (!covered.some((cover) => covers(cover, path))) uncovered.push(`${key}: ${path}`);
        }
      }
      expect(uncovered).toEqual([]);
    });

    it("INV-5: keeps exempt only the reviewed field, never anything below it", () => {
      const marker = "KEEP-SUBTREE-SECRET";
      const leaks: string[] = [];
      // One level down, so a reviewed `@keys` redaction of the same map still leaves the secret to find.
      const below = { entry: { access_token: marker, nested: { private_key: marker, api_key: marker } } };
      // A field review may keep metadata wherever it appears, never a name that is itself a credential.
      const core = Object.entries(fields)
        .filter(([field, review]) => review.verdict === "keep" && CORE_CREDENTIALS.has(field.toLowerCase()))
        .map(([field]) => `fields: ${field}`);
      expect(core, "vendor-wide keeps of credential names").toEqual([]);
      for (const [key, verdict] of operations) {
        if (verdict.verdict === "refuse") continue;
        const [method, path] = key.split(" ") as [string, string];
        for (const keep of verdict.keep ?? []) {
          const out = safety.redact(nest(keep, below), method, path);
          if (JSON.stringify(out).includes(marker)) leaks.push(`${key}: ${keep}`);
        }
      }
      for (const [field, review] of Object.entries(fields)) {
        if (review.verdict !== "keep") continue;
        const out = safety.redact({ [field]: below }, "GET", "/");
        if (JSON.stringify(out).includes(marker)) leaks.push(`fields: ${field}`);
      }
      expect(leaks).toEqual([]);
    });

    it("INV-5: redacts every reviewed redact path on a body that carries it", () => {
      const marker = "REDACT-PATH-SECRET";
      const leaks: string[] = [];
      for (const [key, verdict] of operations) {
        if (verdict.verdict !== "redact") continue;
        const [method, path] = key.split(" ") as [string, string];
        for (const reviewed of verdict.paths) {
          // Filtered list items (`[?env]`) and map keys (`@keys`) need their own shape; their providers test them.
          if (/\[\?|@keys/.test(reviewed)) continue;
          const leaf = `https://user:${marker}@example.com/?token=${marker}`;
          const out = safety.redact(nest(reviewed, leaf), method, path);
          if (JSON.stringify(out).includes(marker)) leaks.push(`${key}: ${reviewed}`);
        }
      }
      for (const [field, review] of Object.entries(fields)) {
        if (review.verdict !== "redact") continue;
        const out = safety.redact({ deep: [{ [field]: marker }] }, "GET", "/");
        if (JSON.stringify(out).includes(marker)) leaks.push(`fields: ${field}`);
      }
      expect(leaks).toEqual([]);
      expect(safety.redact({ client_secret: marker }, "GET", "/")).toEqual({ client_secret: REDACTED });
    });

    describe("refusals", () => {
      const realFetch = globalThis.fetch;
      let sent = 0;
      let respond: (() => Response) | undefined;
      beforeEach(() => {
        sent = 0;
        respond = undefined;
        globalThis.fetch = (async () => {
          sent += 1;
          return respond ? respond() : Response.json({});
        }) as typeof fetch;
      });
      afterEach(() => {
        globalThis.fetch = realFetch;
      });

      it("INV-3: the generic tools refuse every refuse verdict before anything is sent", async () => {
        const connector = harness.connector();
        const tool = (kind: string) => `${table.title.toLowerCase()}_api_${kind}`;
        const fill = harness.fill ?? ((template: string) => template.replace(/\{[^}]+\}/g, "x"));
        const reached: string[] = [];
        for (const [key, verdict] of operations) {
          if (verdict.verdict !== "refuse") continue;
          const [method, template] = key.split(" ") as [string, string];
          const read = method === "GET" || method === "HEAD";
          const error = await connector
            .callTool(
              read ? tool("read") : tool("write"),
              { ...(read && method === "GET" ? {} : { method }), path: fill(template) },
              harness.ctx(),
            )
            .then(
              () => undefined,
              (caught: unknown) => caught,
            );
          if (
            !(error instanceof ConnectorCallError) ||
            !error.message.includes(`Connecta refuses ${method} ${template}.`)
          ) {
            reached.push(`${key}: ${error instanceof Error ? error.message : "answered"}`);
          }
        }
        expect(reached).toEqual([]);
        expect(sent).toBe(0);
      });

      it("INV-5: withholds the vendor's error text for a reviewed operation", async () => {
        const marker = "ECHOED-SECRET-VALUE";
        respond = () => harness.echo.respond(marker);
        const error = await harness
          .connector()
          .callTool(harness.echo.tool, harness.echo.args, harness.ctx())
          .then(
            () => undefined,
            (caught: unknown) => caught,
          );
        expect(error).toBeInstanceOf(ConnectorCallError);
        expect(sent).toBe(1);
        expect((error as ConnectorCallError).message).not.toContain(marker);
      });
    });
  });
}
