// Fix round 2 of the redact-before-cut work: the output boundary's projection, its K-unit
// fragment guarantee, and the provider sites it cannot cover. Every check decodes the output
// itself (`leakedRun`) rather than trusting redaction's own list of forms.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agentOutputOperations,
  encodeForAgent,
  redactAgentOutput,
  redactBoundedRead,
  requestSentSecrets,
  sentSecretsFor,
  sentSecretsForRequest,
  SentSecrets,
} from "../src/sent-secrets.js";
import { ProtocolError, SdkError, SdkErrorCode, UnauthorizedError } from "@modelcontextprotocol/client";
import { CallAdmissionError } from "../src/call-admission.js";
import { ConnectorCallError } from "../src/errors.js";
import { ExecutorExecutionError } from "../src/executor-admission.js";
import "../src/connectors/remote-mcp.js";
import { buildSandboxProviders } from "../src/execute.js";
import { createMetaTools } from "../src/meta-tools.js";
import {
  attachFailureFacts,
  carryFailureFacts,
  classifiedFailure,
  failureRecord,
  failureStatus,
  labelErrorClass,
  statusFailure,
} from "../src/operator-record.js";
import { docs } from "../src/providers/docs/index.js";
import { drive } from "../src/providers/drive/index.js";
import { notion } from "../src/providers/notion/index.js";
import { slides } from "../src/providers/slides/index.js";
import { planningCenter } from "../src/providers/planning-center/index.js";
import { tithely } from "../src/providers/tithely/index.js";
import { vercel } from "../src/providers/vercel/index.js";
import type { Connector, ConnectorContext } from "../src/types.js";
import { caller, stubGoogle, workspaceOptions } from "./helpers/google-echo.js";
import { decodedViews, echoForms, holdsValue, leakedRun, SECRET } from "./helpers/secret-echoes.js";
import { connectorContext } from "./fixtures/misc.js";
import { makeRegistry, silentLogger } from "./helpers.js";

const MARK = "[redacted]";
const K = 8;
const schema = { type: "object", properties: { value: { type: "string", writeOnly: true } } };
/** High-entropy, like a real credential: no eight-unit run of ordinary text. */
const TOKEN = "aF7!pR2#vX9$kM4?cZ6@tN3+qL8=H5/w";

/** A request whose private argument is `value`. */
function context(value = SECRET): ConnectorContext {
  const ctx = caller();
  ctx.requestScope = {};
  requestSentSecrets(ctx).arguments({ value }, schema);
  return ctx;
}
function set(value = SECRET): SentSecrets {
  const secrets = new SentSecrets();
  secrets.arguments({ value }, schema);
  return secrets;
}
function keyed(value = SECRET): ConnectorContext {
  return { ...connectorContext(), credential: { get: async () => value, getAll: async () => ({ value }) } };
}
/** Text of every string leaf, object key and number. */
function shown(value: unknown): string {
  return JSON.stringify(value) ?? "";
}
/** Base64 of UTF-8 text, or base64url with `url`. */
function encoded(text: string, url = false): string {
  const standard = btoa(Array.from(new TextEncoder().encode(text), (byte) => String.fromCharCode(byte)).join(""));
  return url ? standard.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : standard;
}

/** Every own property name, enumerable or not, and every string under one, read from
 * descriptors, never invoking an accessor. */
function everyText(value: unknown, seen = new Set<object>()): string[] {
  if (typeof value === "string") return [value];
  if (value === null || typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  return Object.getOwnPropertyNames(value).flatMap((name) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, name)!;
    return [name, ...("value" in descriptor ? everyText(descriptor.value, seen) : [])];
  });
}

/** Every string and number under a value read from descriptors, in property order, without
 * names: the leaves the projection joins, in its order. */
function everyValue(value: unknown, seen = new Set<object>()): string[] {
  if (typeof value === "string") return [value];
  if (typeof value === "number" || typeof value === "bigint") return [String(value)];
  if (value === null || typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  return Object.getOwnPropertyNames(value).flatMap((name) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, name)!;
    return "value" in descriptor && !(Array.isArray(value) && name === "length")
      ? everyValue(descriptor.value, seen)
      : [];
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The named echo forms of SECRET a matrix keeps: one per distinct matching branch. */
function formsOf(...names: string[]): [string, string][] {
  return echoForms(SECRET).filter(([name]) => names.includes(name));
}

describe("the output boundary's projection", () => {
  it.each(formsOf("raw", "\\u-escaped (lower hex)"))(
    "INV-5: a whole %s form split into one-unit leaves is found across them, in nested JSON and error fields, without mutating the input",
    (_name, form) => {
      const secrets = set();
      const pieces = Array.from(form, (unit) => ({ value: unit }));
      const original = structuredClone(pieces);
      const result = redactAgentOutput(secrets, { runs: pieces, after: "Public suffix." });
      expect(result.runs.every((piece) => piece.value === MARK)).toBe(true);
      expect(result.after).toBe("Public suffix.");
      expect(pieces).toEqual(original);
      const json = redactAgentOutput(secrets, JSON.stringify({ runs: pieces }));
      expect(JSON.parse(json).runs.every((piece: { value: string }) => piece.value === MARK)).toBe(true);
      const error = Object.assign(new ConnectorCallError("invalid_args", "Public diagnostic."), { pieces });
      const safe = redactAgentOutput(secrets, error);
      expect(safe).toBeInstanceOf(ConnectorCallError);
      expect(safe.code).toBe("invalid_args");
      expect(safe.message).toBe("Public diagnostic.");
      expect(safe.pieces.every((piece) => piece.value === MARK)).toBe(true);
      expect(error.pieces).toEqual(original);
    },
  );

  it.each(formsOf("raw", "base64", "\\u-escaped (lower hex)"))(
    "INV-5: every K-unit run of the %s form is removed wherever it starts, checked by independent decoding",
    (name, form) => {
      const secrets = set();
      // JSON escapes are a decoding layer, not a form: K counts the units they decode to.
      const escape = (text: string) =>
        Array.from(text, (unit) => {
          const hex = unit.charCodeAt(0).toString(16).padStart(4, "0");
          return `\\u${name.includes("upper") ? hex.toUpperCase() : hex}`;
        }).join("");
      const units = name.startsWith("\\u") ? SECRET.length : form.length;
      for (let start = 0; start + K <= units; start++) {
        const run = name.startsWith("\\u") ? escape(SECRET.slice(start, start + K)) : form.slice(start, start + K);
        const out = redactAgentOutput(secrets, { a: `public ${run} suffix` }).a;
        expect(out, `${start}`).toContain(MARK);
        expect(out).toMatch(/^public .*suffix$/);
        expect(leakedRun(out, SECRET), `${start}`).toBeUndefined();
      }
      // A run split into one-unit leaves is still a run.
      const split = redactAgentOutput(secrets, { parts: Array.from(form.slice(3, 3 + K)) });
      expect(leakedRun(split.parts.join(""), SECRET)).toBeUndefined();
    },
  );

  it.each(["drive", "resource", "image"])(
    "INV-5: declared %s binary content is decoded at every byte alignment and withheld whole as the marker",
    (kind) => {
      for (const secret of [SECRET, "🌈private/日本語-value"]) {
        for (let prefix = 0; prefix < 4; prefix++) {
          const bytes = new TextEncoder().encode(`${"x".repeat(prefix)}${secret}z`);
          const encoded = btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
          const value =
            kind === "drive"
              ? { format: "base64", content: encoded }
              : kind === "resource"
                ? { uri: "notes://file", blob: encoded }
                : { type: kind, mimeType: "application/octet-stream", data: encoded };
          const result: Record<string, string> = redactAgentOutput(set(secret), value);
          const field = result["content"] ?? result["blob"] ?? result["data"]!;
          expect(atob(field)).toBe(MARK);
          expect(leakedRun(shown(result), secret)).toBeUndefined();
          expect(Object.values(value)).toContain(encoded);
        }
      }
      const publicFile = { format: "base64", content: btoa("Ordinary public file.") };
      expect(redactAgentOutput(set(), publicFile)).toBe(publicFile);
    },
  );

  it("INV-5: only exact Connecta-minted state is framing; vendor state and appended payload are still matched", () => {
    const secrets = set("zq7x");
    const minted = secrets.mintedState("v1.authenticated-zq7x-state");
    expect(secrets.redact({ requestState: minted })).toEqual({ requestState: minted });
    expect(JSON.parse(secrets.redact(JSON.stringify({ requestState: minted })))).toEqual({ requestState: minted });
    expect(secrets.redact({ requestState: "vendor-zq7x-state" })).toEqual({ requestState: `vendor-${MARK}-state` });
    expect(secrets.redact({ requestState: `${minted}zq7x` }).requestState).not.toContain("zq7x-state");
  });

  it("INV-5: continuation tokens are not registered, so the next page's cursor survives", () => {
    const secrets = new SentSecrets();
    secrets.request("https://api.example/items?pageToken=AAAA-shared-cursor-1&api_key=k9Q2x7Vm4Lp8Rz3");
    expect(secrets.redact({ nextPageToken: "AAAA-shared-cursor-2" })).toEqual({
      nextPageToken: "AAAA-shared-cursor-2",
    });
    expect(secrets.redact("k9Q2x7Vm4Lp8")).toBe(MARK);
  });

  it("INV-5: a realistic document, log, JSON and URL corpus is unchanged under a high-entropy set (zero changed leaves)", () => {
    const titles = ["Weekly planning notes", "Quarterly budget report", "Volunteer welcome guide", "Release checklist"];
    const corpus = Array.from({ length: 400 }, (_, index) => ({
      title: titles[index % titles.length],
      body:
        "The team will meet on Tuesday to confirm the schedule. Use Bearer authentication and pass the token in the " +
        "Authorization header. Keys start with sk_live_ or ghp_. The repository contains setup instructions, request " +
        "examples, and troubleshooting notes. Send questions to alice@example.com.",
      html: '<p>Public resources are available to every member.</p><a href="https://example.com/notes?page=2">Notes</a>',
      log: `2026-10-20T09:00:00Z INFO request completed status=200 durationMs=12 row=${index} id=4f1d2c9a-${index}`,
      json: JSON.stringify({ id: `doc-${index}`, created: 1_760_000_000 + index, tags: ["public", "notes"] }),
      count: index,
    }));
    const secrets = set("qL8!mP2#vX6$kN4?rS9@tW3+eZ7=F5/u");
    secrets.add(TOKEN);
    secrets.add("ghp_R4nd0mT0k3nV4lu3XyZ12345678901234");
    expect(redactAgentOutput(secrets, corpus)).toBe(corpus);
    expect(secrets.redact(corpus)).toBe(corpus);
    expect(shown(corpus).length).toBeGreaterThan(200_000);
  });

  it("INV-5: cycles, accessors, over-depth and unregistered values fail closed without mutating the input", () => {
    const value: Record<string, unknown> = {
      public: "Public text.",
      get unsafe() {
        throw new Error("Getter was invoked");
      },
    };
    value["cycle"] = value;
    const output = redactAgentOutput(set(), value);
    expect(output["public"]).toBe("Public text.");
    expect(output["unsafe"]).toBeUndefined();
    expect(output["cycle"]).toBe(MARK);
    expect(value["cycle"]).toBe(value);
    // A value too large to register: any K-unit run could hold its fragment, shorter pieces cannot.
    const long = set("s".repeat(524_289));
    expect(long.redact({ text: "short unchecked content", id: "ab", n: 7 })).toEqual({ text: MARK, id: "ab", n: 7 });
    expect(long.redact({ a: "abcd", b: "efgh" })).toEqual({ a: MARK, b: MARK });
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let depth = 0; depth < 520; depth++) cursor = cursor["child"] = {};
    cursor["text"] = SECRET;
    expect(shown(redactAgentOutput(set(), deep))).not.toContain(SECRET);
  });

  it("INV-5: leaves too large to match joined within the budget are matched alone and across their seams", () => {
    const secrets = set(TOKEN);
    const clean = "x".repeat(18_000_000);
    const result = secrets.redact({ first: clean, big: clean, id: "needed-id" });
    expect(result.first === clean).toBe(true);
    expect(result.big).toBe(MARK);
    expect(result.id).toBe("needed-id");
    const filler = "y".repeat(12_000_000);
    const seam = secrets.redact({ a: `${filler}${TOKEN.slice(0, 5)}`, b: `${TOKEN.slice(5)} public`, c: filler });
    expect(leakedRun(`${seam.a.slice(-40)}${seam.b}`, TOKEN)).toBeUndefined();
    expect(seam.b).toBe(`${MARK} public`);
  });

});

describe("open tails and nested escapes", () => {
  it.each([1, 4])(
    "INV-5: an incomplete escape revealed by decoding layer %i keeps only the checked public prefix",
    (depth) => {
      const value = "private-credential-value-0123456789";
      const secrets = set(value);
      let tail = "private-credential-v\\u";
      for (let layer = 0; layer < depth; layer++) tail = JSON.stringify(tail).slice(1, -1);
      expect(secrets.redactOpenTail(`intro ${tail}`)).toBe(`intro ${MARK}`);
    },
  );

  it("INV-5: a bounded read drops only the uncertain suffix", () => {
    const ctx = context(TOKEN);
    expect(redactBoundedRead(ctx, `Public text. ${TOKEN.slice(0, 3)}`)).toBe(`Public text. ${MARK}`);
    expect(redactBoundedRead(ctx, "Public text. zz")).toBe("Public text. zz");
  });
});

describe("provider sites the boundary cannot cover", () => {
  it("INV-5: Docs matches text across link groups and paragraphs before Markdown links and previews separate it", async () => {
    const value = "Q8!wZ2?"; // Each piece is below K: only the whole source lane holds the form.
    const spanning = "A7!\nvR?"; // Crosses a paragraph break, so each paragraph's preview holds one piece.
    stubGoogle(() => ({
      documentId: "d1",
      title: "Public document",
      body: {
        content: [
          {
            paragraph: {
              elements: [
                { textRun: { content: value.slice(0, 3), textStyle: { link: { url: "https://example.com/notes" } } } },
                { textRun: { content: `${value.slice(3)} then A7!\n` } },
              ],
            },
          },
          { paragraph: { elements: [{ textRun: { content: "vR? continues\n" } }] } },
        ],
      },
    }));
    const ctx = context(value);
    requestSentSecrets(ctx).arguments({ value: spanning }, schema);
    const result = await docs("docs", await workspaceOptions()).callTool(
      "get_document",
      { documentId: "d1", withIndexes: true },
      ctx,
    );
    const text = shown(result);
    for (const piece of [value.slice(0, 3), value.slice(3), "A7!", "vR?"]) expect(text).not.toContain(piece);
    expect(text).toContain("https://example.com/notes");
    expect(text).toContain("continues");
  });

  it("INV-5: a Docs preview is checked after collapsing whitespace, before its cut can leave a short remnant", async () => {
    const spanning = "alpha beta";
    // The collapse joins a soft line break into the value, and the 80-unit cut keeps `alpha b`.
    const content = `${"x".repeat(72)} alpha\u000bbeta and more public text\n`;
    stubGoogle(() => ({
      documentId: "d1",
      title: "Public document",
      body: { content: [{ startIndex: 1, endIndex: 120, paragraph: { elements: [{ textRun: { content } }] } }] },
    }));
    const result = (await docs("docs", await workspaceOptions()).callTool(
      "get_document",
      { documentId: "d1", withIndexes: true },
      context(spanning),
    )) as { tabs: Array<{ elements: Array<{ text: string }> }> };
    const preview = result.tabs[0]!.elements[0]!.text;
    // The cut may also shorten the placeholder itself.
    expect(preview).toMatch(/^x{72} \[redact/);
    expect(preview).not.toContain("alpha b");
  });

  it("INV-5: Notion rich text split across runs below K leaves no piece in either copy, cut short or not", async () => {
    const value = "Q8!wZ2?";
    const publicRun = {
      type: "text",
      plain_text: "Public linked heading. ",
      text: { content: "Public linked heading. ", link: { url: "https://example.com/notes" } },
      annotations: { bold: true },
    };
    let truncated = false;
    vi.stubGlobal("fetch", async () =>
      Response.json({
        object: "page",
        id: "p1",
        properties: {
          Name: {
            type: "title",
            has_more: truncated,
            title: [
              publicRun,
              ...Array.from(truncated ? value.slice(0, 1) : value, (unit) => ({
                type: "text",
                plain_text: unit,
                text: { content: unit },
              })),
            ],
          },
          Notes: {
            type: "rich_text",
            rich_text: Array.from(value, (unit) => ({ type: "text", plain_text: unit, text: { content: unit } })),
          },
        },
      }),
    );
    const connector = notion("notes", { purpose: "Notes", auth: { type: "token" } });
    for (const cut of [false, true]) {
      truncated = cut;
      const result = (await connector.callTool(
        "integration_get_page",
        { page_id: "p1", raw: true },
        { ...context(value), credential: keyed(TOKEN).credential! },
      )) as { properties: Record<string, { title?: unknown[]; rich_text?: unknown[] }> };
      const runs = result.properties["Name"]!.title as Array<{ plain_text: string; text: { content: string } }>;
      expect(runs[0]).toEqual(publicRun);
      expect(runs.slice(1).every((run) => run.plain_text === MARK && run.text.content === MARK)).toBe(true);
      const notes = result.properties["Notes"]!.rich_text as Array<{ plain_text: string }>;
      expect(notes.every((run) => run.plain_text === MARK)).toBe(true);
    }
  });

  it.each(["planning-center", "tithely"])(
    "INV-5: %s redacts a short private value padded with spaces before trimming its error text",
    async (name) => {
      const value = " Q8!w "; // Below K, so the boundary's fragment matching cannot stand in for the site.
      vi.stubGlobal("fetch", async () =>
        Response.json(name === "planning-center" ? { errors: [{ title: value, detail: value }] } : { reason: value }, {
          status: 400,
        }),
      );
      const connector =
        name === "planning-center"
          ? planningCenter("planning", { purpose: "People" })
          : tithely("giving", { purpose: "Giving", environment: "live" });
      const ctx = {
        ...context(value),
        credential: {
          get: async () => "public",
          getAll: async () =>
            name === "planning-center"
              ? { applicationId: "public-app", secret: TOKEN }
              : { publicKey: "pub_public", privateKey: `pri_${TOKEN}` },
        },
      };
      const error = (await connector
        .callTool(
          name === "planning-center" ? "pco_api_get" : "tithely_api_get",
          name === "planning-center" ? { path: "/people/v2/people" } : { path: "/organization" },
          ctx,
        )
        .catch((caught: unknown) => caught)) as Error;
      expect(error.message).toContain(MARK);
      expect(error.message).not.toContain("Q8!w");
    },
  );

  it("INV-5: Tithe.ly parses amounts from the redacted body, so a short private value cannot reappear as a number", async () => {
    const value = "00042"; // Below K: parsed to 42, it would no longer hold the whole value.
    vi.stubGlobal("fetch", async () =>
      Response.json({ data: [{ charge_id: "c1", amount: value, net_amount: "4100", currency: "usd" }] }),
    );
    const result = (await tithely("giving", { purpose: "Giving", environment: "live" }).callTool(
      "list_charges",
      { organizationId: "org-1" },
      {
        ...context(value),
        credential: {
          get: async () => "public",
          getAll: async () => ({ publicKey: "pub_public", privateKey: `pri_${TOKEN}` }),
        },
      },
    )) as { charges: Array<{ amountCents?: number; netAmountCents?: number }> };
    expect(result.charges[0]!.amountCents).toBeUndefined();
    expect(result.charges[0]!.netAmountCents).toBe(4100);
  });

});

describe("review round 3", () => {
  it("INV-5: a payload cannot claim framing exemptions: a plain object's code, name and numeric facts are matched", () => {
    const secrets = set(TOKEN);
    const claim = { retryable: true, code: TOKEN, name: TOKEN, retryAfterMs: 1, ok: true };
    const expected = { retryable: true, code: MARK, name: MARK, retryAfterMs: 1, ok: true };
    expect(secrets.redact(claim)).toEqual(expected);
    expect(redactAgentOutput(secrets, claim)).toEqual(expected);
    expect(secrets.redact(Object.assign(new Error("Public."), { code: TOKEN })).code).toBe(MARK);
    // A numeric credential under outcome names is a number like any other.
    const numeric = new SentSecrets();
    numeric.add("73519046");
    const facts = { retryAfterMs: 73519046, truncated: 73519046, ok: 73519046, hasMore: 73519046, isError: 73519046 };
    for (const safe of [numeric.redact(facts), redactAgentOutput(numeric, facts)])
      expect(Object.values(safe as Record<string, unknown>).every((value) => value === MARK)).toBe(true);
    // A typed number on an error is dropped rather than turned into text.
    const slow = new ConnectorCallError("rate_limited", "Slow down.", { retryAfterMs: 73519046 });
    expect(numeric.redact(slow).retryAfterMs).toBeUndefined();
  });

  it("INV-5: tiny private values match only whole field values, short ones as substrings, K and longer by fragments", () => {
    // One to three units: a whole leaf, key, number or decoded view only.
    expect(set("a1Z").redact({ a: "a1Z", b: "xa1Zx", t: "row a1Z", k: { a1Z: 1, xa1Z: 2 } })).toEqual({
      a: MARK,
      b: "xa1Zx",
      t: "row a1Z",
      k: { [MARK]: 1, xa1Z: 2 },
    });
    expect(set("123").redact({ n: 123, m: 1234, t: "row 123" })).toEqual({ n: MARK, m: 1234, t: "row 123" });
    expect(set("1").redact({ text: "row 10", id: 1, count: 10 })).toEqual({ text: "row 10", id: MARK, count: 10 });
    expect(set("pin").redact({ format: "base64", content: btoa("pin") }).content).toBe(btoa(MARK));
    expect(set("pin").redact({ format: "base64", content: btoa("xpinz") }).content).toBe(btoa("xpinz"));
    // Four to seven: wherever they occur in payload text, numbers and decoded views; pieces never.
    expect(set("a1Z9").redact({ b: "xa1Z9x", p: "a1Z", n: 1, key: { xa1Z9: 1 } })).toEqual({
      b: `x${MARK}x`,
      p: "a1Z",
      n: 1,
      key: { [`x${MARK}`]: 1 },
    });
    expect(set("1234").redact({ n: 512345 })).toEqual({ n: MARK });
    expect(set("Q8!wZ2?").redact({ b: "xQ8!wZ2?x", c: "Q8!wZ2" })).toEqual({ b: `x${MARK}x`, c: "Q8!wZ2" });
    // Eight and more: whole and by every K-unit run; K-1 pieces survive away from a cut.
    expect(set("Q8!wZ2?A").redact({ c: "xQ8!wZ2?Ax", d: "Q8!wZ2?" })).toEqual({ c: `x${MARK}x`, d: "Q8!wZ2?" });
    const long = "Q8!wZ2?A7@vR4#";
    expect(set(long).redact({ c: `x${long.slice(3, 11)}x`, d: long.slice(0, 7) })).toEqual({
      c: `x${MARK}x`,
      d: long.slice(0, 7),
    });
  });

  it("INV-5: base64 and base64url no field declares is decoded and checked, whole, nested or inside text", () => {
    const secrets = set(TOKEN);
    for (let prefix = 0; prefix < 4; prefix++) {
      const body = `${"x".repeat(prefix)}${TOKEN}z`;
      for (const url of [false, true]) {
        const input = {
          whole: encoded(body, url),
          nested: encoded(encoded(body, url)),
          inline: `see token=${encoded(body, url)} and more`,
          jwt: `${encoded('{"alg":"none"}', true)}.${encoded(JSON.stringify({ sub: body }), true)}.c2ln`,
          id: "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms",
          file: encoded("Ordinary public content of a file."),
        };
        const result = secrets.redact(input);
        // At the alignment of a registered form, its runs are replaced in place; at any other,
        // only decoding finds the value, and the whole field is withheld.
        for (const field of ["whole", "nested", "inline", "jwt"] as const) {
          expect(result[field], `${prefix} ${url} ${field}`).not.toBe(input[field]);
          expect(leakedRun(JSON.stringify(result[field]), TOKEN), `${prefix} ${url} ${field}`).toBeUndefined();
        }
        if (prefix % 3) expect(result.whole).toBe(MARK);
        expect([result.id, result.file]).toEqual([input.id, input.file]);
        expect(leakedRun(shown(result), TOKEN)).toBeUndefined();
      }
    }
  });

  it("INV-5: Connecta's own encodings check what they encode: downloads, REST bodies and attachments", async () => {
    const ctx = context(TOKEN);
    const clean = new TextEncoder().encode("Ordinary public bytes.");
    expect(encodeForAgent(ctx, clean)).toBe(btoa("Ordinary public bytes."));
    expect(atob(encodeForAgent(ctx, new TextEncoder().encode(`x${TOKEN}z`)))).toBe(MARK);
    expect(encodeForAgent(ctx, `x${TOKEN.slice(4, 4 + K)}z`, { url: true })).toBe(encoded(MARK, true));
    // A generic REST read of an octet-stream body, decoded by the agent, holds no private value.
    vi.stubGlobal(
      "fetch",
      async () => new Response(`x${TOKEN}z`, { headers: { "content-type": "application/octet-stream" } }),
    );
    const result = await vercel("hosting", { purpose: "Hosting", auth: { type: "token" }, teamId: "team_1" }).callTool(
      "vercel_api_read",
      { path: "/v8/deployments/dpl_1/files/f1" },
      { ...ctx, credential: keyed("qL8!mP2#vX6$kN4?rS9@tW3+eZ7=F5/u").credential! },
    );
    expect(shown(result)).toContain(btoa(MARK));
    expect(leakedRun(shown(result), TOKEN)).toBeUndefined();
  });

  it("INV-5: what returns is what was checked: accessors are never invoked and their containers are copied without them", () => {
    const secrets = set(TOKEN);
    let reads = 0;
    const getter = () => (reads++ ? TOKEN : "public text");
    const rows: unknown[] = ["public"];
    Object.defineProperty(rows, 1, { enumerable: true, get: getter });
    const row = Object.defineProperty({ id: "r1" }, "text", { enumerable: true, get: getter });
    const out = secrets.redact({ rows, row, kept: { id: "r2" } });
    // Read before any assertion touches the originals, which would invoke the getters itself.
    expect(reads).toBe(0);
    expect(out.rows === rows || out.row === row).toBe(false);
    expect(out.rows).toEqual(["public", MARK]);
    expect(Object.getOwnPropertyDescriptor(out.row, "text")).toBeUndefined();
    expect(out.row).toEqual({ id: "r1" });
    expect(shown(out)).not.toContain(TOKEN);
    // A container whose every field is a data property this pass read stays the caller's own.
    const kept = { id: "r2", nested: [{ text: "public" }] };
    expect(secrets.redact({ kept }).kept).toBe(kept);
    // A change copies only the containers on its path; the caller's value is never mutated.
    const input = { a: { text: `echo ${TOKEN}` }, b: { text: "public" } };
    const safe = secrets.redact(input);
    expect([safe.a === input.a, safe.b === input.b, input.a.text]).toEqual([false, true, `echo ${TOKEN}`]);
    // toJSON is called once, as serialization would, and its result is what is checked.
    expect(secrets.redact({ dated: { toJSON: () => `echo ${TOKEN}` } })).toEqual({ dated: `echo ${MARK}` });
    expect(secrets.redact({ when: new Date(0) })).toEqual({ when: "1970-01-01T00:00:00.000Z" });
  });

});

describe("review round 4", () => {
  /** Base64 or base64url of `body`, padded or not. */
  const base64Of = (body: string, url: boolean, padded: boolean) => {
    const bare = encoded(body, url).replace(/=+$/, "");
    return padded ? bare + "=".repeat((4 - (bare.length % 4)) % 4) : bare;
  };
  /** An array of `length` holes. */
  const holes = (length: number): unknown[] => Object.assign([], { length }) as unknown[];

  it.each([
    ["four", "Pq4!"],
    ["eight", "Q8!wZ2?A"],
  ])(
    "INV-5: a %s-unit private value base64-encoded in text is decoded at every alignment, padded or not, in both alphabets",
    (_name, value) => {
      const secrets = set(value);
      for (let prefix = 0; prefix < 3; prefix++)
        for (let suffix = 0; suffix < 3; suffix++)
          for (const url of [false, true])
            for (const padded of [false, true]) {
              const run = base64Of(`${"x".repeat(prefix)}${value}${"z".repeat(suffix)}`, url, padded);
              for (const input of [`echo: ${run} end`, run, `{"note":"${run}"}`]) {
                const out = shown(secrets.redact({ v: input }));
                expect(holdsValue(out, value), `${prefix} ${suffix} ${url} ${padded} ${input}`).toBe(false);
              }
            }
      // Public base64 of the same lengths is decoded, found clean, and kept.
      const clean = { a: `echo: ${btoa("public!")} end`, b: `echo: ${btoa("x public text z")} end` };
      expect(secrets.redact(clean)).toBe(clean);
    },
  );

  it("INV-5: cursor claims are checked under payload rules, strings by value, Connecta's keys and counts left alone", () => {
    const ctx = context("4201");
    const claims = (value: object) => encodeForAgent(ctx, JSON.stringify(value), { url: true, claims: true });
    // A short private value equal to one of Connecta's counts leaves the cursor intact.
    const counts = { k: "page", i: 4201, o: 4201 };
    expect(claims(counts)).toBe(encoded(JSON.stringify(counts), true));
    // A downstream string holding it withholds the cursor, though no provider redacted it.
    expect(claims({ k: "page", g: "s0-4201-id", i: 0 })).toBe(encoded(MARK, true));
    // Checked so, a cursor is remembered as clean: a later payload pass keeps it as it stands.
    const issued = claims(counts);
    expect(requestSentSecrets(ctx).redact({ page: { nextCursor: issued } }).page.nextCursor).toBe(issued);
  });

  it("INV-5: an array's toJSON, own or inherited, and an inherited hole getter never reach the wire unchecked", async () => {
    const secrets = new SentSecrets();
    secrets.add(TOKEN);
    const own = Object.assign(["public"], { toJSON: () => ({ echo: TOKEN }) });
    const inheritedJson = Object.setPrototypeOf(
      ["public"],
      Object.assign(Object.create(Array.prototype) as object, { toJSON: () => ({ echo: TOKEN }) }),
    ) as unknown[];
    let reads = 0;
    const getterProto = Object.create(Array.prototype) as object;
    Object.defineProperty(getterProto, "0", { get: () => (reads++, TOKEN) });
    const holed = Object.setPrototypeOf(holes(1), getterProto) as unknown[];
    const dataProto = Object.create(Array.prototype) as object;
    Object.defineProperty(dataProto, "0", { value: `echo ${TOKEN}` });
    const filled = Object.setPrototypeOf(holes(1), dataProto) as unknown[];
    const outs = [own, inheritedJson, holed, filled].map((value) => [value, secrets.redact(value)] as const);
    for (const [value, out] of outs) {
      expect(out).not.toBe(value);
      expect(JSON.stringify(out)).not.toContain(TOKEN);
    }
    expect(reads).toBe(0);
    expect(outs.map(([, out]) => out)).toEqual([{ echo: MARK }, { echo: MARK }, [MARK], [`echo ${MARK}`]]);
    // Through the guest bridge, as a program's connecta.call receives it.
    const registry = makeRegistry([
      {
        id: "notes",
        kind: "api",
        listTools: async () => [{ name: "read", annotations: { readOnlyHint: true } }],
        callTool: async (_name, _args, ctx) => {
          sentSecretsFor(ctx).add(TOKEN);
          return Object.assign(["public"], { toJSON: () => ({ echo: TOKEN }) });
        },
      } as Connector,
    ]);
    const [provider] = await buildSandboxProviders(registry, "https://connecta.test", silentLogger);
    const value = await provider!.fns["call"]!({ address: "notes.read" });
    expect(JSON.stringify(value)).not.toContain(TOKEN);
    expect(leakedRun(JSON.stringify(value), TOKEN)).toBeUndefined();
  });

  it("INV-5: an error is always a checked copy holding what its stack and class accessors answered once", () => {
    const secrets = new SentSecrets();
    secrets.add(TOKEN);
    let stackReads = 0;
    const stacked = new Error("public");
    Object.defineProperty(stacked, "stack", {
      configurable: true,
      get: () => (++stackReads === 1 ? "public stack" : TOKEN),
    });
    const first = secrets.redact(stacked);
    expect(first).not.toBe(stacked);
    expect([first.stack, first.stack, stackReads]).toEqual(["public stack", "public stack", 1]);
    let detailReads = 0;
    class Detailed extends Error {
      get detail() {
        return ++detailReads === 1 ? "public detail" : TOKEN;
      }
    }
    const detailed = secrets.redact(new Detailed("public"));
    expect(detailed).toBeInstanceOf(Detailed);
    expect([detailed.detail, detailed.detail, detailReads]).toEqual(["public detail", "public detail", 1]);
    // A getter over the error's own data, such as an SDK's HTTP status, keeps its answer.
    class HttpError extends Error {
      constructor(
        message: string,
        readonly data: { status: number },
      ) {
        super(message);
      }
      get status() {
        return this.data.status;
      }
    }
    expect(secrets.redact(new HttpError("Too many requests.", { status: 429 })).status).toBe(429);
    // An error is never replaced by its toJSON, and its copy does not call one.
    class Serialized extends Error {
      toJSON() {
        return { echo: TOKEN };
      }
    }
    expect(JSON.stringify(secrets.redact(new Serialized("public")))).not.toContain(TOKEN);
  });

  it("INV-5: a container past the node budget is withheld whole, never serialized unchecked, read or stashed", async () => {
    const secrets = set(TOKEN);
    const echo = encoded(`x${TOKEN}z`);
    let reads = 0;
    const huge = holes(1_048_577);
    huge[0] = { v: echo };
    Object.defineProperty(huge, 1, { enumerable: true, get: () => (reads++, TOKEN) });
    expect(secrets.redact(huge)).toBe(MARK);
    expect(secrets.redact({ rows: huge, kept: "public" })).toEqual({ rows: MARK, kept: "public" });
    expect(secrets.changes(huge)).toBe(true);
    expect(reads).toBe(0);
    const serialized = holes(1_048_577);
    serialized[0] = { v: echo };
    expect(secrets.text(JSON.stringify({ rows: serialized }))).toBe(JSON.stringify({ rows: MARK }));
    // A direct value-mode read cannot stash what was never checked.
    const registry = makeRegistry([
      {
        id: "notes",
        kind: "api",
        listTools: async () => [{ name: "read", annotations: { readOnlyHint: true } }],
        callTool: async (_name, _args, ctx) => {
          sentSecretsFor(ctx).arguments({ value: TOKEN }, schema);
          return serialized;
        },
      } as Connector,
    ]);
    const stash = vi.spyOn(registry, "stashResult");
    const meta = createMetaTools(registry, "https://connecta.test");
    const result = await meta.callTool({ address: "notes.read", resultMode: "value" });
    expect(shown(result)).not.toContain(echo);
    expect(shown(result)).toContain(MARK);
    for (const [, chunks] of stash.mock.calls) expect(chunks.join("")).not.toContain(echo);
  });

  it("INV-5: array and error copies keep the identity facts registered beside them", () => {
    const secrets = new SentSecrets();
    secrets.add(TOKEN);
    class RoundFourHttpError extends Error {}
    labelErrorClass(RoundFourHttpError, "RoundFourHttpError");
    const original = attachFailureFacts(new RoundFourHttpError(TOKEN), {
      httpStatus: 503,
      step: "tools/call",
      origin: "https://api.example.com",
    });
    const typed = carryFailureFacts(original, new ConnectorCallError("connector_call_failed", TOKEN));
    const copy = secrets.redact(typed);
    expect(copy).not.toBe(typed);
    expect(copy.message).toBe(MARK);
    expect(typed.message).toBe(TOKEN);
    expect(failureRecord({}, copy)).toEqual(failureRecord({}, typed));
    expect(failureRecord({}, copy)).toMatchObject({ errorClass: "RoundFourHttpError", httpStatus: 503 });
    expect(failureRecord({}, secrets.redact(copy))).toEqual(failureRecord({}, typed));
    const classification = classifiedFailure({ code: "connector_call_failed", message: TOKEN, retryable: true });
    expect(failureRecord({}, secrets.redact(classification))).toEqual(failureRecord({}, classification));
    const rows = attachFailureFacts([TOKEN], { httpStatus: 503, origin: "https://api.example.com" });
    const safeRows = secrets.redact(rows);
    expect(safeRows).toEqual([MARK]);
    expect(failureRecord({}, safeRows)).toEqual(failureRecord({}, rows));
    expect(failureRecord({}, safeRows)).toMatchObject({ httpStatus: 503, origin: "https://api.example.com" });
    const status = failureStatus("notes", typed);
    expect(statusFailure(secrets.redact(status))).toBe(statusFailure(status));
  });
});

describe("review round 5", () => {
  /** Every UTF-16 unit as a `\u` escape. */
  const escapeAll = (text: string) =>
    Array.from(text, (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
  /** A connector whose one read registers `value` and returns what `reply` makes. */
  const echoing = (value: string, reply: () => unknown, privateValue = true, maxResultBytes?: number): Connector => ({
    id: "notes",
    kind: "api",
    ...(maxResultBytes ? { maxResultBytes } : {}),
    listTools: async () => [{ name: "read", annotations: { readOnlyHint: true }, inputSchema: { type: "object" } }],
    callTool: async (_name, _args, ctx) => {
      if (privateValue) sentSecretsFor(ctx).arguments({ value }, schema);
      else sentSecretsFor(ctx).add(value);
      return reply();
    },
  });
  /** What a program's connecta.call("notes.read") receives, before the executor marshals it. */
  const bridged = async (connector: Connector): Promise<unknown> => {
    const [provider] = await buildSandboxProviders(makeRegistry([connector]), "https://connecta.test", silentLogger);
    return await provider!.fns["call"]!({ address: "notes.read" });
  };
  /** Text of a value as every exit could serialize it: JSON, a bigint as its digits, and bytes
   * as the base64 the Worker codec sends. */
  const wire = (value: unknown): string =>
    JSON.stringify(value, (_key, item: unknown) =>
      typeof item === "bigint"
        ? String(item)
        : item instanceof Uint8Array
          ? { bytes: btoa(String.fromCharCode(...item)) }
          : item,
    ) ?? "";
  /** Every place `value` holds something other than JSON data, a fresh Uint8Array or an error
   * copy whose fields are; read from descriptors, never invoking an accessor. */
  const nonJson = (value: unknown, path = "$", seen = new Set<object>()): string[] => {
    if (typeof value === "function" || typeof value === "symbol") return [`${path}: ${typeof value}`];
    if (value === null || typeof value !== "object" || seen.has(value)) return [];
    seen.add(value);
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype === Uint8Array.prototype)
      return Object.getOwnPropertyNames(value).every((name) => /^\d+$/.test(name)) &&
        !Object.getOwnPropertySymbols(value).length
        ? []
        : [`${path}: binary with fields`];
    const problems: string[] = [];
    if (!(value instanceof Error) && ![Object.prototype, Array.prototype, null].includes(prototype))
      problems.push(`${path}: prototype`);
    if (Array.isArray(value) && prototype !== Array.prototype) problems.push(`${path}: array class`);
    if (Object.getOwnPropertySymbols(value).length) problems.push(`${path}: symbol field`);
    for (let at: object | null = value; at; at = Object.getPrototypeOf(at) as object | null) {
      const descriptor = Object.getOwnPropertyDescriptor(at, "toJSON");
      if (!descriptor) continue;
      if (!("value" in descriptor) || typeof descriptor.value === "function") problems.push(`${path}: toJSON`);
      break;
    }
    for (const name of Object.getOwnPropertyNames(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name)!;
      if ("value" in descriptor) problems.push(...nonJson(descriptor.value, `${path}.${name}`, seen));
      else problems.push(`${path}.${name}: accessor`);
    }
    return problems;
  };

  it("INV-5: plus-only form encoding is decoded, so a `+` separator hides no base64 through the stash and a fresh read", async () => {
    const value = "pin42";
    const secrets = set(value);
    const form = `echo=x+${btoa(`x${value}`)}`;
    expect(secrets.redact({ echo: form }).echo).toBe(MARK);
    for (let prefix = 0; prefix < 3; prefix++)
      for (const url of [false, true]) {
        const run = encoded(`${"x".repeat(prefix)}${value}z`, url);
        for (const input of [
          `echo=x+${run}`,
          `a+b+${run}+tail`,
          `${run}+tail`,
          new URLSearchParams({ echo: `see ${run}` }).toString(),
          `q=one+two&echo=x+${run}`,
        ]) {
          const out = shown(secrets.redact({ v: input }));
          expect(out, `${prefix} ${url} ${input}`).not.toBe(shown({ v: input }));
          expect(holdsValue(out, value), `${prefix} ${url} ${input}`).toBe(false);
        }
      }
    // Prose with a plus decodes nothing new and stays.
    const prose = { v: "one+two = three, 2+2 = 4" };
    expect(secrets.redact(prose)).toBe(prose);
    // The review's path: a value-mode direct call stashes the result, and a fresh read pages it.
    const registry = makeRegistry([echoing(value, () => ({ echo: form, filler: "!".repeat(4096) }), true, 1024)]);
    const direct = await createMetaTools(registry, "https://connecta.test").callTool({
      address: "notes.read",
      resultMode: "value",
    });
    const id = (direct.structuredContent as { data: { resultId?: string } }).data.resultId;
    expect(id).toBeDefined();
    const page = await createMetaTools(registry, "https://connecta.test").readResult({
      id: id!,
      offset: 0,
      maxBytes: 1024,
    });
    for (const out of [shown(direct), shown(page)]) {
      expect(out).not.toContain(form);
      expect(holdsValue(out, value)).toBe(false);
    }
  });

  it("INV-5: every other non-JSON value becomes the data JSON shows for it, checked, or is withheld", () => {
    const secrets = new SentSecrets();
    secrets.add(TOKEN);
    class Row {
      id = "r1";
      get secret() {
        return TOKEN;
      }
    }
    const out = secrets.redact({
      date: new Date(0),
      invalid: new Date(NaN),
      map: new Map([["k", TOKEN]]),
      set: new Set([TOKEN]),
      weak: new WeakMap(),
      regexp: /public/g,
      promise: Promise.resolve(TOKEN),
      row: new Row(),
      string: new String(`echo ${TOKEN}`),
      number: new Number(5),
      boolean: new Boolean(false),
      bigint: 5n,
      symbol: Symbol("public"),
      absent: undefined,
      method() {
        return TOKEN;
      },
    });
    expect(out).toEqual({
      date: "1970-01-01T00:00:00.000Z",
      invalid: null,
      map: {},
      set: {},
      weak: {},
      regexp: {},
      promise: {},
      row: { id: "r1" },
      string: `echo ${MARK}`,
      number: 5,
      boolean: false,
      bigint: 5n,
      symbol: MARK,
      absent: undefined,
      method: MARK,
    });
    expect(nonJson(out)).toEqual([]);
    // A bigint is checked as its digits.
    expect(set("12345678").redact({ id: 12345678n })).toEqual({ id: MARK });
  });

  it("INV-5: random nested values of every kind redact to JSON data, canonical bytes and error copies only", () => {
    const token = TOKEN;
    const value = "pin42";
    let seed = 0x5eed;
    const next = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let mixed = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
      return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
    };
    const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
    const strings = [
      "Ordinary public text.",
      token,
      `echo ${token}`,
      encoded(`x${token}z`),
      encodeURIComponent(encoded(`x${value}z`)),
      `echo=x+${btoa(`x${value}`)}`,
      escapeAll(encoded(`x${token}z`)),
      value,
      "",
    ];
    // Bytes are checked as decoded binary is: raw, through JSON escapes, as UTF-8 and through the
    // base64 they carry. Text views are views of strings, so content that needs one to reveal
    // base64 is left to the strings above.
    const bytes = () => new TextEncoder().encode(pick([...strings.slice(0, 5), value, ""]));
    class Bytes extends Uint8Array {
      toJSON() {
        return { echo: token };
      }
    }
    class Echo extends Error {
      get toJSON() {
        return () => ({ echo: token });
      }
      get detail() {
        return token;
      }
    }
    class Row {
      id = "r1";
      get secret() {
        return token;
      }
    }
    const leaves: (() => unknown)[] = [
      () => pick(strings),
      () => Math.floor(next() * 1e9),
      () => 12345678,
      () => BigInt(Math.floor(next() * 1e6)),
      () => next() < 0.5,
      () => null,
      () => undefined,
      () => Symbol(token),
      () => Object.assign(() => token, { toJSON: () => ({ echo: token }) }),
      () => new Date(Math.floor(next() * 1e12)),
      () => /public/g,
      () => new Map([["k", token]]),
      () => new Set([token]),
      () => new String(pick(strings)),
      () => new Number(4),
      () => new Bytes(bytes()),
      () => bytes(),
      () => new Uint32Array([12345678, 1]),
      () => new Float64Array([1.5]),
      () => new DataView(bytes().buffer),
      () => bytes().buffer,
      () => ({ format: "base64", content: pick(strings) }),
      () => ({ type: "image", data: pick([btoa(`x${token}z`), btoa("public"), pick(strings)]), mimeType: "image/png" }),
    ];
    const containers: ((depth: number) => unknown)[] = [
      (depth) => ({ a: make(depth), [pick(strings) || "k"]: make(depth) }),
      (depth) => Object.assign(Object.create(null) as object, { a: make(depth) }),
      (depth) => [make(depth), make(depth)],
      (depth) => Object.assign([], { length: 3, 1: make(depth) }),
      (depth) => Object.assign(new (class Items extends Array {})(), { 0: make(depth) }),
      () => new Row(),
      (depth) => Object.defineProperty({ kept: make(depth) }, "secret", { enumerable: true, get: () => token }),
      (depth) => ({ toJSON: () => ({ echo: make(depth) }) }),
      (depth) => Object.freeze({ a: make(depth) }),
      (depth) => ({ [Symbol("s")]: token, a: make(depth) }),
      (depth) => Object.assign(new Echo(pick(strings)), { cause: make(depth), callback: () => token }),
      (depth) => Object.assign(new Error(pick(strings)), { code: pick(strings), data: make(depth) }),
      (depth) => JSON.stringify({ nested: pick(strings), b: depth }),
      // A class of any built-in base whose constructor and instances carry a chosen name.
      (depth) => {
        const name = pick(strings);
        const Base = pick([Error, TypeError, RangeError, DOMException]);
        class Named extends Base {}
        Object.defineProperty(Named, "name", { value: pick([name, pick(strings)]) });
        const error = new Named(pick(strings));
        return Object.defineProperty(Object.assign(error, { cause: make(depth) }), "name", {
          value: pick([name, pick(strings), Base.name]),
          configurable: true,
          writable: true,
        });
      },
      // Accessors on the prototype, under chosen names and for the name itself.
      (depth) => {
        const key = pick(strings) || "k";
        const [answer, name] = [make(depth), pick(strings)];
        class Getters extends Error {}
        Object.defineProperty(Getters.prototype, key, { get: () => answer, configurable: true });
        if (next() < 0.5) Object.defineProperty(Getters.prototype, "name", { get: () => name, configurable: true });
        else Object.defineProperty(Getters.prototype, "name", { value: name, configurable: true });
        return new Getters(pick(strings));
      },
      // A credential split below K across an error's name and its neighbour: an own name before
      // its message, a custom field before the name a prototype answers, or a name holding both
      // halves as JSON.
      (depth) => {
        const [first, second] = [token.slice(0, 7), token.slice(7, 14)];
        const Base = pick([Error, TypeError, RangeError, DOMException]);
        class Split extends Base {}
        const shape = pick(["own", "getter", "inherited", "json"] as const);
        if (shape === "getter")
          Object.defineProperty(Split.prototype, "name", { get: () => second, configurable: true });
        if (shape === "inherited")
          Object.defineProperty(Split.prototype, "name", { value: second, configurable: true });
        const error = new Split();
        if (shape === "own")
          Object.defineProperties(error, {
            name: { value: first, enumerable: true, configurable: true },
            message: { value: second, enumerable: true, configurable: true },
          });
        else if (shape === "json")
          Object.defineProperty(error, "name", { value: JSON.stringify([first, second]), configurable: true });
        else Object.defineProperty(error, "prefix", { value: first, enumerable: true });
        return Object.assign(error, { cause: make(depth) });
      },
    ];
    function make(depth: number): unknown {
      return depth > 3 || next() < 0.45 ? pick(leaves)() : pick(containers)(depth + 1);
    }
    for (let round = 0; round < 300; round++) {
      const input = make(0);
      const secrets = new SentSecrets();
      secrets.add(token);
      secrets.arguments({ value }, schema);
      for (const out of [secrets.redact(input), redactAgentOutput(secrets, input)]) {
        expect(nonJson(out), `round ${round}`).toEqual([]);
        // What JSON shows, and every field name and string an in-process read can reach.
        for (const text of [wire(out), everyText(out).join("\n"), everyValue(out).join("")]) {
          expect(text, `round ${round}`).not.toContain(token);
          expect(leakedRun(text, token), `round ${round}`).toBeUndefined();
        }
      }
      const payload = secrets.redact(input);
      expect(holdsValue(wire(payload), value), `round ${round}`).toBe(false);
      expect(holdsValue(everyText(payload).join("\n"), value), `round ${round}`).toBe(false);
    }
  });

});

describe("review round 6", () => {
  it("INV-5: built-in, Connecta and MCP SDK error names are kept whatever was sent; others are checked", () => {
    // "Error" is a short private value, so it matches inside any name that is not on the allowlist.
    const secrets = set("Error");
    const kept: Error[] = [
      new Error("public"),
      new TypeError("public"),
      new RangeError("public"),
      new SyntaxError("public"),
      new ReferenceError("public"),
      new EvalError("public"),
      new URIError("public"),
      new AggregateError([], "public"),
      new DOMException("public"),
      new DOMException("public", "AbortError"),
      new DOMException("public", "TimeoutError"),
      new ConnectorCallError("connector_call_failed", "public"),
      new CallAdmissionError("concurrency", "rate_limited", "public"),
      new ExecutorExecutionError("executor_closed", "public"),
      new UnauthorizedError("public"),
      new ProtocolError(-32602, "public"),
      new SdkError(SdkErrorCode.RequestTimeout, "public"),
      // A subclass that names nothing keeps the name its registered ancestor gives it.
      new (class Narrow extends TypeError {})("public"),
    ];
    for (const error of kept) {
      const copy = secrets.redact(error);
      expect(copy, error.name).not.toBe(error);
      expect([copy.name, Object.getPrototypeOf(copy)], error.name).toEqual([error.name, Object.getPrototypeOf(error)]);
    }
    // The same words on a class not on the allowlist, or a name its class does not give, are text.
    class CustomError extends Error {}
    Object.defineProperty(CustomError.prototype, "name", { value: "CustomError", configurable: true });
    expect(secrets.redact(new CustomError("public")).name).toBe(MARK);
    expect(secrets.redact(Object.assign(new TypeError("public"), { name: "WeirdError" })).name).toBe(MARK);
    expect(secrets.redact(Object.assign(new Error("public"), { name: "Plain" })).name).toBe("Plain");
    // A plain object's name is never an error name.
    expect(secrets.redact({ name: "TypeError" }).name).toBe(`Type${MARK}`);
  });

});

describe("review round 7", () => {
  const credential = "Q8!wZ2?A7@vR4#";
  // DOMException is typed apart from the Error constructors; every base here is an Error at runtime.
  const bases = [Error, TypeError, RangeError, DOMException] as ErrorConstructor[];
  const sent = () => {
    const secrets = new SentSecrets();
    secrets.add(credential);
    return secrets;
  };

  it("INV-5: the reviewer's allowlist probes: hostile names, constructor and toStringTag spoofing", () => {
    for (const Base of bases)
      for (const kind of ["own", "getter", "inherited"] as const)
        for (const name of [credential, btoa(`x${credential}z`), `echo=x+${btoa(credential)}`]) {
          class Spoof extends Base {}
          const error = new Spoof("public");
          // workerd gives a DOMException an own name, which would shadow the prototype's.
          if (kind !== "own") Reflect.deleteProperty(error, "name");
          if (kind === "own")
            Object.defineProperty(error, "name", { value: name, enumerable: true, configurable: true });
          else
            Object.defineProperty(
              Spoof.prototype,
              "name",
              kind === "getter" ? { get: () => name, configurable: true } : { value: name, configurable: true },
            );
          Object.defineProperty(error, "constructor", { value: TypeError });
          Object.defineProperty(error, Symbol.toStringTag, { value: "TypeError" });
          const copy = sent().redact(error);
          expect(copy.name, `${Base.name}/${kind}/${name}`).toBe(MARK);
          expect(Object.getOwnPropertySymbols(copy)).toEqual([]);
        }
    const fake = { name: credential, constructor: TypeError, [Symbol.toStringTag]: "Error" };
    expect(sent().redact(fake).name).toBe(MARK);
  });

});
