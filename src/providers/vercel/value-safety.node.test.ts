// Node-only: compares the runtime vocabulary with the maintainer detection script in scripts/.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import candidates from "./value-safety.candidates.json";
import source from "./openapi.source.json";
import { openapi } from "./openapi.generated.js";
import {
  CREDENTIAL_WORDS,
  METADATA_NAMES,
  METADATA_SUFFIXES,
  VALUE_SAFETY,
  credentialName,
  type ValueSafetyVerdict,
} from "./value-safety.js";
import { OperationIndex } from "../_shared/rest/operation-index.js";
import { ConnectorCallError } from "../../errors.js";
import { connectorContext } from "../../../test/fixtures/misc.js";
import { vercel } from "./index.js";

const script = (await import(new URL("../../../scripts/value-safety.mjs", import.meta.url).href)) as {
  VALUE_SAFETY_FORMAT: number;
  CREDENTIAL_WORDS: string[];
  METADATA_SUFFIXES: string[];
  METADATA_NAMES: string[];
  credentialName(name: string): boolean;
};

const index = new OperationIndex(openapi, { vendor: "vercel", title: "Vercel" });
const table = VALUE_SAFETY as Record<string, ValueSafetyVerdict>;

describe("Vercel value-safety review", () => {
  it("INV-5: reviews every operation the pinned spec flags, from candidates derived at that pin", () => {
    expect(candidates.digest).toBe(source.digest);
    expect(candidates.format).toBe(script.VALUE_SAFETY_FORMAT);
    const unreviewed = Object.keys(candidates.candidates).filter((key) => !Object.hasOwn(table, key));
    expect(unreviewed, "flagged operations without a verdict in value-safety.ts").toEqual([]);
  });

  it("INV-5: reviews only operations the index carries, each with a reason and redact paths", () => {
    for (const [key, verdict] of Object.entries(table)) {
      const [method, path] = key.split(" ") as [string, string];
      expect(index.operation(method, path), key).toBeDefined();
      expect(verdict.reason.trim(), key).not.toBe("");
      if (verdict.verdict === "redact") expect(verdict.paths.length, key).toBeGreaterThan(0);
    }
    const counts = { refuse: 0, redact: 0, safe: 0 };
    for (const verdict of Object.values(table)) counts[verdict.verdict] += 1;
    // A moved count is a reviewed change: update it with the table.
    expect(counts).toEqual({ refuse: 25, redact: 52, safe: 63 });
  });

  it("matches the detection script's credential vocabulary and metadata allowlist", () => {
    expect(CREDENTIAL_WORDS).toEqual(script.CREDENTIAL_WORDS);
    expect(METADATA_SUFFIXES).toEqual(script.METADATA_SUFFIXES);
    expect(METADATA_NAMES).toEqual(script.METADATA_NAMES);
    for (const name of [
      "clientSecret",
      "x-vercel-protection-bypass",
      "privateKeyPem",
      "jwt",
      "tokenId",
      "partialKeyValue",
    ]) {
      expect(credentialName(name), name).toBe(script.credentialName(name));
    }
  });
});

describe("Vercel refused operations", () => {
  const realFetch = globalThis.fetch;
  let sent = 0;
  beforeEach(() => {
    sent = 0;
    globalThis.fetch = (async () => {
      sent += 1;
      return Response.json({});
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("INV-3: the generic tools refuse every refuse verdict before anything is sent", async () => {
    const connector = vercel("hosting", { purpose: "Apps", auth: { type: "token" } });
    const ctx = {
      ...connectorContext(),
      credential: { get: async () => "tok", getAll: async () => ({ value: "tok" }) },
    };
    for (const [key, verdict] of Object.entries(table)) {
      if (verdict.verdict !== "refuse") continue;
      const [method, template] = key.split(" ") as [string, string];
      const path = template.replace(/\{[^}]+\}/g, "x");
      const tool = method === "GET" || method === "HEAD" ? "vercel_api_read" : "vercel_api_write";
      const error = await connector
        .callTool(tool, { ...(tool === "vercel_api_write" || method === "HEAD" ? { method } : {}), path }, ctx)
        .then(
          () => undefined,
          (caught: unknown) => caught,
        );
      expect(error, key).toBeInstanceOf(ConnectorCallError);
      expect((error as ConnectorCallError).message, key).toContain(`Connecta refuses ${method} ${template}`);
    }
    expect(sent).toBe(0);
  });
});
