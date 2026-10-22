// Fix round 2 of the redact-before-cut work: the output boundary's projection, its K-unit
// fragment guarantee, and the provider sites it cannot cover. Every check decodes the output
// itself (`leakedRun`) rather than trusting redaction's own list of forms.
import { afterEach, describe, expect, it, vi } from "vitest";
import "../src/connectors/remote-mcp.js";
import { ConnectorCallError } from "../src/errors.js";
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
import { planningCenter } from "../src/providers/planning-center/index.js";
import { slides } from "../src/providers/slides/index.js";
import { tithely } from "../src/providers/tithely/index.js";
import { vercel } from "../src/providers/vercel/index.js";
import {
  encodeForAgent,
  redactAgentOutput,
  requestSentSecrets,
  SentSecrets,
  sentSecretsFor,
} from "../src/sent-secrets.js";
import type { Connector, ConnectorContext } from "../src/types.js";
import { connectorContext } from "./fixtures/misc.js";
import { makeRegistry, silentLogger } from "./helpers.js";
import { caller, stubGoogle, workspaceOptions } from "./helpers/google-echo.js";
import { echoForms, holdsValue, leakedRun, SECRET } from "./helpers/secret-echoes.js";

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

describe("the output boundary's projection", () => {
  it.each(echoForms(SECRET))(
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

  it.each(echoForms(SECRET))(
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

  it("INV-5: object keys holding a K-unit run are renamed; framing keys and keys only partly a short value are kept", () => {
    const secrets = set(TOKEN);
    const out = redactAgentOutput(secrets, { [`x${TOKEN.slice(4, 4 + K)}`]: 1, content: [], type: "text" });
    expect(Object.keys(out)).toEqual([`x${MARK}`, "content", "type"]);
    const short = set("pin");
    expect(short.redact({ pin: 1, pinCode: 2 })).toEqual({ [MARK]: 1, pinCode: 2 });
  });

  it("INV-5: a normalized number holding a K-unit run is withheld; a tiny private value matches only a whole number", () => {
    expect(redactAgentOutput(set("012345678900"), { size: 12345678900, count: 3 })).toEqual({ size: MARK, count: 3 });
    expect(set("012345678900").redact({ notice: "A file of 12345678900 bytes." }).notice).toBe(
      `A file of ${MARK} bytes.`,
    );
    expect(set("5").redact({ id: 5, count: 15, label: "page 5" })).toEqual({ id: MARK, count: 15, label: "page 5" });
    // Digits split across a string and a number are one run.
    expect(redactAgentOutput(set("ab12345678cd"), { a: "ab", n: 12345678, b: "cd" })).toEqual({
      a: MARK,
      n: MARK,
      b: MARK,
    });
  });

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

  it("INV-5: serialized JSON whose tokens together hold a run of a value is withheld whole", () => {
    const secrets = set('12345678,"next":"allowed');
    const raw = JSON.stringify({ id: "needed-id", numeric: 12345678, next: "allowed" });
    expect(secrets.text(raw)).toBe(MARK);
    const clean = JSON.stringify({ id: "needed-id", count: 4, label: "denied" });
    expect(secrets.text(clean)).toBe(clean);
  });

  it("INV-5: only exact Connecta-minted state is framing; vendor state and appended payload are still matched", () => {
    const secrets = set("zq7x");
    const minted = secrets.mintedState("v1.authenticated-zq7x-state");
    expect(secrets.redact({ requestState: minted })).toEqual({ requestState: minted });
    expect(JSON.parse(secrets.redact(JSON.stringify({ requestState: minted })))).toEqual({ requestState: minted });
    expect(secrets.redact({ requestState: "vendor-zq7x-state" })).toEqual({ requestState: `vendor-${MARK}-state` });
    expect(secrets.redact({ requestState: `${minted}zq7x` }).requestState).not.toContain("zq7x-state");
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

  it("INV-5: Slides raw text runs split below K with style between them leave no piece", async () => {
    const value = "Q8!wZ2?";
    stubGoogle(() => ({
      objectId: "s1",
      revisionId: "r1",
      pageElements: [
        {
          objectId: "shape",
          shape: {
            text: {
              textElements: Array.from(value, (unit) => ({
                textRun: { content: unit, style: { fontFamily: "PublicFont" } },
              })),
            },
          },
        },
      ],
    }));
    const result = await slides("decks", await workspaceOptions()).callTool(
      "get_page",
      { presentationId: "p1", pageObjectId: "s1", raw: true },
      context(value),
    );
    const text = shown(result);
    expect(text).toContain(MARK);
    for (const unit of value) expect(text).not.toContain(`"content":"${unit}"`);
    expect(text).toContain("PublicFont");
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

  it("INV-5: Drive checks downloaded bytes at any alignment and size strings before normalizing them", async () => {
    for (const binary of [true, false]) {
      const body = `x${SECRET}z`;
      const size = binary ? String(body.length) : "012345678900";
      stubGoogle((url) =>
        url.searchParams.get("alt") === "media"
          ? new Response(body)
          : { id: "f1", name: "data.bin", mimeType: "application/octet-stream", size },
      );
      const result = (await drive("files", await workspaceOptions()).callTool(
        "get_file_content",
        { fileId: "f1" },
        context(size),
      )) as { size?: number; format: string; content: string };
      expect(result.size).toBeUndefined();
      expect(result.format).toBe("base64");
      expect(atob(result.content)).toBe(MARK);
      expect(shown(result)).not.toContain("12345678900");
      expect(leakedRun(shown(result), SECRET)).toBeUndefined();
    }
  });
});

describe("review round 3", () => {
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

  it("INV-5: a Drive cursor carries Drive's page token only redacted, so decoding it reveals no sent value", async () => {
    stubGoogle((url) =>
      url.pathname.endsWith("/files")
        ? { files: [{ id: "f1", name: "Notes", mimeType: "text/plain" }], nextPageToken: `tok-${TOKEN}-next` }
        : {},
    );
    const result = (await drive("files", await workspaceOptions()).callTool(
      "search_files",
      { query: "notes" },
      context(TOKEN),
    )) as { page: { hasMore: boolean; nextCursor: string } };
    expect(result.page.hasMore).toBe(true);
    const claims = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(atob(result.page.nextCursor.replace(/-/g, "+").replace(/_/g, "/")), (unit) =>
          unit.charCodeAt(0),
        ),
      ),
    ) as unknown[];
    expect(claims[0]).toBe(`tok-${MARK}-next`);
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
  /** The claims a base64url cursor holds. */
  const claimsOf = (cursor: string): Record<string, unknown> =>
    JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(atob(cursor.replace(/-/g, "+").replace(/_/g, "/")), (unit) => unit.charCodeAt(0)),
      ),
    ) as Record<string, unknown>;

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

  it("INV-5: Slides cursors carry a slide's and its notes page's ids only redacted", async () => {
    const long = "Ordinary public content ".repeat(30);
    const shape = (objectId: string) => ({
      objectId,
      shape: { text: { textElements: [{ textRun: { content: long } }] } },
    });
    stubGoogle(() => ({
      presentationId: "deck",
      title: "Public deck",
      revisionId: "rev1",
      slides: [
        {
          objectId: "s0-pin42-id",
          slideProperties: {
            notesPage: {
              objectId: "n0-pin42-id",
              notesProperties: { speakerNotesObjectId: "notes" },
              pageElements: [shape("notes")],
            },
          },
          pageElements: [shape("shape1")],
        },
      ],
    }));
    const result = (await slides("decks", await workspaceOptions()).callTool(
      "get_presentation",
      { presentationId: "deck", maxCharsPerSlide: 20 },
      context("pin42"),
    )) as { slides: { elements: { textCursor: string }[]; notesCursor: string }[] };
    const [slide] = result.slides;
    expect(claimsOf(slide!.elements[0]!.textCursor)).toMatchObject({ k: "page", p: "deck", g: `s0-${MARK}-id` });
    expect(claimsOf(slide!.notesCursor)).toMatchObject({ k: "page", p: "deck", g: `n0-${MARK}-id` });
    expect(holdsValue(shown(result), "pin42")).toBe(false);
  });

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
  /** Every unit as a lowercase percent escape. */
  const percentAll = (text: string) =>
    Array.from(text, (unit) => `%${unit.charCodeAt(0).toString(16).padStart(2, "0")}`).join("");

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

  it("INV-5: object keys go through the whole lattice: base64 in a key, raw or under any text view, renames it", () => {
    const value = "pin42";
    const secrets = set(value);
    const run = btoa(`x${value}z`);
    for (const key of [
      run,
      `id:${run}`,
      encodeURIComponent(run),
      escapeAll(run),
      percentAll(run),
      `a+${btoa(`x${value}`)}`,
    ]) {
      const out = secrets.redact({ [key]: "public", kept: "okay" });
      expect(Object.keys(out), key).toEqual([MARK, "kept"]);
      expect(holdsValue(shown(out), value), key).toBe(false);
    }
    // The review's key, and keys inside a nested JSON string and on an error.
    expect(secrets.redact({ "eHBpbjQyeg==": "public" })).toEqual({ [MARK]: "public" });
    expect(holdsValue(shown(secrets.redact({ body: JSON.stringify({ [run]: "public" }) })), value)).toBe(false);
    const error = secrets.redact(Object.assign(new Error("public"), { [run]: "public" }));
    expect(Object.getOwnPropertyNames(error)).not.toContain(run);
    // A credential under the boundary's rules too, its base64 at every alignment.
    const credential = new SentSecrets();
    credential.add(TOKEN);
    for (let prefix = 0; prefix < 3; prefix++) {
      const echo = encoded(`${"x".repeat(prefix)}${TOKEN}z`);
      const out = redactAgentOutput(credential, { [echo]: 1, [`k ${echo}`]: 2, [encodeURIComponent(echo)]: 3 });
      expect(Object.keys(out)).not.toContain(echo);
      expect(leakedRun(shown(out), TOKEN), String(prefix)).toBeUndefined();
    }
    // Ordinary keys are decoded, found clean and kept.
    const plain = { createdAt: 1, description: "public", nextPageToken: "abc" };
    expect(secrets.redact(plain)).toBe(plain);
  });

  it("INV-5: functions are withheld, so no serializer they carry runs at an exit, and an error copy holds no callable toJSON", async () => {
    const secrets = new SentSecrets();
    secrets.add(TOKEN);
    const fn = Object.assign(() => "public", { toJSON: () => ({ echo: TOKEN }) });
    expect(secrets.redact({ value: fn })).toEqual({ value: MARK });
    expect(secrets.redact(fn)).toBe(MARK);
    expect(secrets.redact([fn, "public"])).toEqual([MARK, "public"]);
    expect(secrets.redact({ value: { toJSON: () => fn } })).toEqual({ value: MARK });
    expect(secrets.redact({ value: Symbol(TOKEN) })).toEqual({ value: MARK });
    // The review's error: a class getter answering toJSON with a function is never read.
    let calls = 0;
    class Serializing extends Error {
      get toJSON() {
        calls++;
        return () => ({ echo: TOKEN });
      }
    }
    const copy = secrets.redact(new Serializing("public"));
    expect(copy).toBeInstanceOf(Serializing);
    expect(Object.getOwnPropertyDescriptor(copy, "toJSON")).toMatchObject({ value: undefined });
    expect(JSON.stringify(copy)).not.toContain(TOKEN);
    expect(calls).toBe(0);
    // An own function field and a class accessor answering with a function are withheld too.
    class Retrying extends Error {
      get retry() {
        return () => TOKEN;
      }
    }
    const retrying = secrets.redact(Object.assign(new Retrying("public"), { callback: () => TOKEN }));
    expect([retrying.retry, retrying.callback]).toEqual([MARK, MARK]);
    expect(nonJson({ copy, retrying })).toEqual([]);
    // Through the guest bridge, as a program's connecta.call receives it.
    const value = await bridged(echoing(TOKEN, () => ({ value: fn, fail: new Serializing("public") }), false));
    expect(nonJson(value)).toEqual([]);
    expect(JSON.stringify(value)).not.toContain(TOKEN);
    expect(leakedRun(JSON.stringify(value), TOKEN)).toBeUndefined();
  });

  it("INV-5: typed binary leaves only as a fresh Uint8Array of its checked bytes, with no subclass or serializer", async () => {
    const secrets = new SentSecrets();
    secrets.add(TOKEN);
    class Bytes extends Uint8Array {
      toJSON() {
        return { echo: TOKEN };
      }
    }
    class Buffer extends ArrayBuffer {
      toJSON() {
        return { echo: TOKEN };
      }
    }
    class Lying extends Uint8Array {
      override get byteLength() {
        return 0;
      }
    }
    const inputs: [unknown, number[]][] = [
      [new Bytes([1, 2, 3]), [1, 2, 3]],
      [new Buffer(3), [0, 0, 0]],
      [new DataView(Uint8Array.of(4, 5).buffer), [4, 5]],
      [new Uint16Array([1, 258]), [1, 0, 2, 1]],
      [new Float32Array([1]), [0, 0, 128, 63]],
      [new Lying([6, 7]), [6, 7]],
      [Uint8Array.of(8).subarray(0, 1), [8]],
    ];
    for (const [input, bytes] of inputs) {
      const out = secrets.redact({ value: input }).value;
      expect(out).not.toBe(input);
      expect(Object.getPrototypeOf(out)).toBe(Uint8Array.prototype);
      expect([...(out as Uint8Array)]).toEqual(bytes);
      expect(nonJson(out)).toEqual([]);
      expect(JSON.stringify(out)).not.toContain(TOKEN);
    }
    // The bytes are checked as before.
    expect(secrets.redact({ value: new Bytes(new TextEncoder().encode(`x${TOKEN}z`)) })).toEqual({ value: MARK });
    // Through the guest bridge, the review's two subclasses arrive as plain bytes.
    for (const reply of [() => ({ value: new Bytes([1, 2, 3]) }), () => ({ value: new Buffer(3) })]) {
      const value = (await bridged(echoing(TOKEN, reply, false))) as { data: { value: unknown } };
      expect(Object.getPrototypeOf(value.data.value)).toBe(Uint8Array.prototype);
      expect(JSON.stringify(value)).not.toContain(TOKEN);
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

  it("INV-5: a toJSON result whose fields are copied is replaced by its copy, never put back as the original", () => {
    const secrets = new SentSecrets();
    secrets.add(TOKEN);
    class Holder {
      constructor(readonly v: string) {}
    }
    // Found by the property test below; the round-4 head returned the original Holder here.
    const inputs = [
      { wrap: { toJSON: () => ({ echo: new Holder(TOKEN) }) } },
      [{ toJSON: () => ({ map: new Map([["k", 1]]), echo: new Holder(TOKEN) }) }],
      { wrap: { toJSON: () => ({ echo: { toJSON: () => ({ echo: new Holder(`x ${TOKEN}`) }) } }) } },
    ];
    for (const input of inputs) {
      const out = secrets.redact(input);
      expect(JSON.stringify(out)).not.toContain(TOKEN);
      expect(JSON.stringify(out)).toContain(MARK);
      expect(nonJson(out)).toEqual([]);
    }
  });

  it("INV-5: structural fields are refused through the same lattice: base64 of a sent value in a URL or host", () => {
    const secrets = new SentSecrets();
    secrets.add(TOKEN);
    const echo = encoded(`x${TOKEN}z`);
    expect(secrets.contains(`https://example.com/cb?s=${echo}`)).toBe(true);
    expect(secrets.contains(`https://example.com/cb?s=${encodeURIComponent(echo)}`)).toBe(true);
    expect(secrets.containsUrl(`https://example.com/cb?s=${echo}`)).toBe(true);
    expect(secrets.contains(`${TOKEN.slice(0, K).toLowerCase()}.example.com`, true)).toBe(true);
    expect(secrets.contains("https://example.com/cb?s=public-state")).toBe(false);
  });
});

describe("review round 6", () => {
  const credential = "Q8!wZ2?A7@vR4#";

  it("INV-5: materialized error accessor names pass through the whole lattice", () => {
    const secrets = new SentSecrets();
    secrets.add(credential);
    secrets.arguments({ value: "pin42" }, schema);
    for (const key of [credential, btoa(`x${credential}z`), btoa("xpin42z"), `echo=x+${btoa("xpin42")}`]) {
      class Getter extends Error {}
      Object.defineProperty(Getter.prototype, key, { get: () => "answer", configurable: true });
      const out = secrets.redact(new Getter("public"));
      expect(Object.hasOwn(out, key), key).toBe(false);
      // The renamed accessor's answer is still a checked field of the copy.
      const names = Object.getOwnPropertyNames(out);
      expect(names.filter((name) => Object.getOwnPropertyDescriptor(out, name)!.value === "answer").length, key).toBe(
        1,
      );
      expect(holdsValue(everyText(out).join("\n"), "pin42"), key).toBe(false);
      expect(leakedRun(everyText(out).join("\n"), credential), key).toBeUndefined();
    }
    // Two accessors renamed alike keep the first; neither leaves its own name behind.
    class Twice extends Error {
      get [credential]() {
        return "first";
      }
      get [`${credential}!`]() {
        return "second";
      }
    }
    const twice = secrets.redact(new Twice("public"));
    expect(Object.getOwnPropertyNames(twice).filter((name) => name.includes(credential))).toEqual([]);
    expect(everyText(twice).join("\n")).not.toContain(credential);
    // An error's toJSON shadow keeps its name whatever is registered, so it still shadows.
    const json = new SentSecrets();
    json.arguments({ value: "JSON" }, schema);
    class Serializing extends Error {
      toJSON() {
        return { echo: credential };
      }
    }
    const own = Object.defineProperty(new Serializing("public"), "toJSON", {
      value: () => ({ echo: credential }),
      configurable: true,
      writable: true,
    });
    for (const error of [new Serializing("public"), own]) {
      const shadowed = json.redact(error);
      expect(Object.getOwnPropertyDescriptor(shadowed, "toJSON")).toMatchObject({ value: undefined });
      expect(JSON.stringify(shadowed)).not.toContain(credential);
    }
  });
});

describe("review round 7", () => {
  const credential = "Q8!wZ2?A7@vR4#";
  // DOMException is typed apart from the Error constructors; every base here is an Error at runtime.
  const bases = [Error, TypeError, RangeError, DOMException] as ErrorConstructor[];
  const [head, tail] = [credential.slice(0, 7), credential.slice(7)];
  const sent = () => {
    const secrets = new SentSecrets();
    secrets.add(credential);
    return secrets;
  };
  /** Every leaf an in-process read reaches, in property order and without names, so adjacent
   * leaves concatenate as the projection joins them. */
  const joined = (value: unknown): string => everyValue(value).join("");

  it("INV-5: an error name off the allowlist joins the projection, so a credential split across it and a neighbour is withheld", () => {
    for (const Base of bases) {
      // Own name, then message.
      class Own extends Base {}
      const own = new Own();
      delete own.stack;
      Object.defineProperties(own, {
        name: { value: head, enumerable: true, configurable: true },
        message: { value: tail, enumerable: true, configurable: true },
      });
      // A custom field, then the name a prototype answers, as an accessor or a data field. On a
      // DOMException the message and code its prototype answers come between them.
      class Getter extends Base {
        override get name() {
          return tail;
        }
      }
      class Inherited extends Base {}
      Object.defineProperty(Inherited.prototype, "name", { value: tail, configurable: true });
      const after = [new Getter("public"), new Inherited("public")].map((error) => {
        delete error.stack;
        return Object.defineProperty(error, "prefix", { value: head, enumerable: true });
      });
      // A name holding both halves as JSON, adjacent inside it.
      class Nested extends Base {}
      const nested = Object.defineProperty(new Nested("public"), "name", {
        value: JSON.stringify([head, tail]),
        configurable: true,
      });
      delete nested.stack;
      for (const error of [own, ...(Base === (DOMException as unknown) ? [] : after), nested]) {
        const label = `${Base.name}/${Object.getPrototypeOf(error).constructor.name}`;
        const copy = sent().redact(error);
        // Any part of the name changed withholds it whole; the copy keeps its class.
        expect(copy.name, label).toBe(MARK);
        expect(Object.getPrototypeOf(copy) === Object.getPrototypeOf(error), label).toBe(true);
        expect(joined(copy), label).not.toContain(head);
        expect(joined(copy), label).not.toContain(tail);
        expect(JSON.stringify(copy), label).not.toContain(head);
      }
    }
  });

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
