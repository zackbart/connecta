// Fix round 2 of the redact-before-cut work: the output boundary's projection, its K-unit
// fragment guarantee, and the provider sites it cannot cover. Every check decodes the output
// itself (`leakedRun`) rather than trusting redaction's own list of forms.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agentOutputOperations,
  redactAgentOutput,
  redactBoundedRead,
  requestSentSecrets,
  sentSecretsForRequest,
  SentSecrets,
} from "../src/sent-secrets.js";
import { ConnectorCallError } from "../src/errors.js";
import { docs } from "../src/providers/docs/index.js";
import { drive } from "../src/providers/drive/index.js";
import { notion } from "../src/providers/notion/index.js";
import { slides } from "../src/providers/slides/index.js";
import { planningCenter } from "../src/providers/planning-center/index.js";
import { tithely } from "../src/providers/tithely/index.js";
import type { ConnectorContext } from "../src/types.js";
import { caller, stubGoogle, workspaceOptions } from "./helpers/google-echo.js";
import { decodedViews, echoForms, leakedRun, SECRET } from "./helpers/secret-echoes.js";
import { connectorContext } from "./fixtures/misc.js";

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

  it("INV-5: K is exact: runs of K-1 units survive away from a cut, and a value shorter than K matches only whole", () => {
    const secrets = set(TOKEN);
    for (let start = 0; start + K - 1 <= TOKEN.length; start++) {
      const run = TOKEN.slice(start, start + K - 1);
      expect(redactAgentOutput(secrets, { a: `x ${run} y` }).a, run).toBe(`x ${run} y`);
    }
    expect(redactAgentOutput(secrets, { a: `x ${TOKEN.slice(0, K)} y` }).a).toBe(`x ${MARK} y`);
    // At a cut, an unfinished form of any length is withheld instead.
    expect(secrets.redactOpenTail(`public ${TOKEN.slice(0, 1)}`)).toBe(`public ${MARK}`);
    const short = set("Q8!wZ2?");
    expect(short.redact({ a: "Q8!", b: "wZ2?" })).toEqual({ a: MARK, b: MARK });
    expect(short.redact("public Q8!wZ2? suffix")).toBe(`public ${MARK} suffix`);
    expect(short.redact("public Q8!wZ suffix")).toBe("public Q8!wZ suffix");
  });

  it("INV-5: object keys holding a K-unit run are renamed; framing keys and keys only partly a short value are kept", () => {
    const secrets = set(TOKEN);
    const out = redactAgentOutput(secrets, { [`x${TOKEN.slice(4, 4 + K)}`]: 1, content: [], type: "text" });
    expect(Object.keys(out)).toEqual([`x${MARK}`, "content", "type"]);
    const short = set("pin");
    expect(short.redact({ pin: 1, pinCode: 2 })).toEqual({ [MARK]: 1, pinCode: 2 });
  });

  it("INV-5: a normalized number holding a K-unit run is withheld; a short private value matches only a whole number", () => {
    expect(redactAgentOutput(set("012345678900"), { size: 12345678900, count: 3 })).toEqual({ size: MARK, count: 3 });
    expect(set("012345678900").redact({ notice: "A file of 12345678900 bytes." }).notice).toBe(
      `A file of ${MARK} bytes.`,
    );
    expect(set("5").redact({ id: 5, count: 15, label: "page 5" })).toEqual({
      id: MARK,
      count: 15,
      label: `page ${MARK}`,
    });
    // Digits split across a string and a number are one run.
    expect(redactAgentOutput(set("ab12345678cd"), { a: "ab", n: 12345678, b: "cd" })).toEqual({
      a: MARK,
      n: MARK,
      b: MARK,
    });
  });

  it("INV-5: the envelope pass leaves Connecta's identifiers and counts to the payload pass", () => {
    const secrets = set("5");
    const envelope = { jsonrpc: "2.0", id: 5, result: { resultId: "r-5", totalChars: 1500, hasMore: true } };
    expect(redactAgentOutput(secrets, envelope)).toBe(envelope);
    expect(secrets.redact(envelope)).not.toBe(envelope);
  });

  it.each(["drive", "resource", "image", "audio"])(
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

  it("INV-5: operation-table successes and rejections share the boundary, and future operations inherit it", async () => {
    const scope = {};
    const secrets = requestSentSecrets(context());
    const operations = agentOutputOperations(
      () => ({
        async read() {
          sentSecretsForRequest(scope).include(secrets);
          return { a: SECRET.slice(0, 5), b: SECRET.slice(5) };
        },
        async future() {
          sentSecretsForRequest(scope).include(secrets);
          throw Object.assign(new Error("Public diagnostic."), { a: SECRET.slice(0, 5), b: SECRET.slice(5) });
        },
      }),
      scope,
    );
    expect(await operations.read()).toEqual({ a: MARK, b: MARK });
    await expect(operations.future()).rejects.toMatchObject({ a: MARK, b: MARK });
  });

  it("INV-5: only exact Connecta-minted state is framing; vendor state and appended payload are still matched", () => {
    const secrets = set("z");
    const minted = secrets.mintedState("v1.authenticated-z-state");
    expect(secrets.redact({ requestState: minted })).toEqual({ requestState: minted });
    expect(JSON.parse(secrets.redact(JSON.stringify({ requestState: minted })))).toEqual({ requestState: minted });
    expect(secrets.redact({ requestState: "vendor-z-state" })).toEqual({ requestState: `vendor-${MARK}-state` });
    expect(secrets.redact({ requestState: `${minted}z` }).requestState).not.toContain("z");
  });

  it("INV-5: identifiers are matched whole only; a Basic username is one only beside a registrable password", () => {
    const secrets = new SentSecrets();
    secrets.identifier("registered-client-0042");
    const consent = "https://auth.example/register?client_id=registered-client-0042";
    expect(secrets.redact(consent)).toBe(`https://auth.example/register?client_id=${MARK}`);
    expect(secrets.redact("https://auth.example/registered-client")).toBe("https://auth.example/registered-client");
    expect(secrets.contains("https://auth.example/registered-client")).toBe(false);
    const paired = new SentSecrets();
    paired.header(`Basic ${btoa(`service-account-7:${TOKEN}`)}`);
    expect(paired.redact("service-account-7")).toBe(MARK);
    expect(paired.redact("service-account")).toBe("service-account");
    expect(paired.redact(TOKEN.slice(2, 2 + K))).toBe(MARK);
    const keyOnly = new SentSecrets();
    keyOnly.header(`Basic ${btoa(`${TOKEN}:x`)}`);
    expect(keyOnly.redact(TOKEN.slice(2, 2 + K))).toBe(MARK);
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

  it("INV-5: public text genuinely sharing a K-unit run with a secret is suppressed, in text and in decoded binary", () => {
    const secrets = set("credentialé-token");
    expect(secrets.redact("ordinarialé-token")).toBe(`ordinar${MARK}`);
    const file = { format: "base64", content: btoa(String.fromCharCode(...new TextEncoder().encode("xyzialé-token"))) };
    expect(atob(secrets.redact(file).content)).toBe(MARK);
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

  it("INV-5: a projection of a million entries is matched whole, with no per-node cap withholding it", () => {
    const secrets = set(TOKEN);
    const rows = Array.from({ length: 200_000 }, (_, id) => ({ id, name: `row-${id}`, ok: true }));
    rows[123_456]!.name = `echo ${TOKEN}`;
    const result = redactAgentOutput(secrets, rows);
    expect(result[123_456]!.name).toBe(`echo ${MARK}`);
    expect(result[199_999]).toBe(rows[199_999]);
  });
});

describe("open tails and nested escapes", () => {
  it.each([1, 2, 3, 4])(
    "INV-5: an incomplete escape revealed by decoding layer %i keeps only the checked public prefix",
    (depth) => {
      const value = "private-credential-value-0123456789";
      const secrets = set(value);
      let tail = "private-credential-v\\u";
      for (let layer = 0; layer < depth; layer++) tail = JSON.stringify(tail).slice(1, -1);
      expect(secrets.redactOpenTail(`intro ${tail}`)).toBe(`intro ${MARK}`);
    },
  );

  it("INV-5: a Drive read cut at maxChars inside nested escapes shows no prefix of the private value", async () => {
    const value = "private-credential-value-0123456789";
    const body = "private-credential-v" + "\\\\u".repeat(100);
    stubGoogle((url) =>
      url.searchParams.get("alt") === "media"
        ? new Response(body, { headers: { "content-type": "text/plain" } })
        : { id: "f1", name: "notes.txt", mimeType: "text/plain", size: String(body.length) },
    );
    const result = (await drive("files", await workspaceOptions()).callTool(
      "get_file_content",
      { fileId: "f1", maxChars: 20 },
      context(value),
    )) as { content: string };
    expect(result.content.startsWith(MARK)).toBe(true);
    for (const view of decodedViews(shown(result))) expect(view).not.toContain("private-cre");
    expect(leakedRun(shown(result), value)).toBeUndefined();
  });

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

  it("INV-5: forty Notion titles cut by Notion keep their checked public runs and drop only the uncertain tail", async () => {
    const properties = Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [
        `Name${index}`,
        {
          type: "title",
          has_more: true,
          title: [
            {
              type: "text",
              plain_text: `Public heading ${index}. `,
              text: { content: `Public heading ${index}. `, link: { url: "https://example.com/notes" } },
              annotations: { bold: true, color: "blue" },
            },
            { type: "text", plain_text: "Ending a", text: { content: "Ending a" }, annotations: { italic: true } },
          ],
        },
      ]),
    );
    vi.stubGlobal("fetch", async () => Response.json({ object: "page", id: "p1", properties }));
    const connector = notion("notes", { purpose: "Notes", auth: { type: "token" } });
    const result = (await connector.callTool("integration_get_page", { page_id: "p1", raw: true }, keyed(TOKEN))) as {
      properties: Record<string, { title: unknown[] }>;
    };
    for (let index = 0; index < 40; index++) {
      const runs = result.properties[`Name${index}`]!.title;
      expect(runs[0]).toEqual((properties[`Name${index}`] as { title: unknown[] }).title[0]);
      expect(runs[1]).toMatchObject({
        plain_text: `Ending ${MARK}`,
        text: { content: `Ending ${MARK}` },
        annotations: { italic: true },
      });
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

describe("mutation checks", () => {
  it("INV-5: without the fragment index, the K-unit checks above find a surviving run", () => {
    const index = (set(TOKEN) as unknown as { fragments(): object })["fragments"]();
    const Empty = index.constructor as new (forms: []) => object;
    vi.spyOn(SentSecrets.prototype as unknown as { fragments(): object }, "fragments").mockReturnValue(new Empty([]));
    const out = set(TOKEN).redact({ a: `public ${TOKEN.slice(3, 3 + K)} suffix` }).a;
    expect(leakedRun(out, TOKEN)).toBe(TOKEN.slice(3, 3 + K));
  });

  it("INV-5: without the nested open-tail check, a nested incomplete escape keeps its prefix", () => {
    const value = "private-credential-value-0123456789";
    vi.spyOn(SentSecrets.prototype as unknown as { openSpans(): void }, "openSpans").mockImplementation(() => {});
    const tail = JSON.stringify(JSON.stringify("private-credential-v\\u").slice(1, -1)).slice(1, -1);
    expect(set(value).redactOpenTail(`intro ${tail}`)).not.toBe(`intro ${MARK}`);
  });

  it("INV-5: without the provider lanes, Notion runs below K survive the boundary", async () => {
    const value = "Q8!wZ2?";
    vi.spyOn(SentSecrets.prototype, "parts").mockImplementation((parts) => parts);
    vi.stubGlobal("fetch", async () =>
      Response.json({
        object: "page",
        id: "p1",
        properties: {
          Notes: {
            type: "rich_text",
            rich_text: Array.from(value, (unit) => ({
              type: "text",
              plain_text: unit,
              text: { content: unit },
              annotations: { bold: false },
            })),
          },
        },
      }),
    );
    const result = await notion("notes", { purpose: "Notes", auth: { type: "token" } }).callTool(
      "integration_get_page",
      { page_id: "p1", raw: true },
      { ...context(value), credential: keyed(TOKEN).credential! },
    );
    expect(shown(result)).toContain('"plain_text":"Q"');
  });
});
