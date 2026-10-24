/** Frozen Workspace universe. Only owned in-memory routes; never a real Google account. */
import { generateKeyPairSync, randomBytes, verify } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { configureGuardedTransport } from "../../src/guarded-transport.js";
import type { ConnectorSpec } from "./world.js";
import type { Ledger, CallRecord } from "./service.js";

export const GOOGLE_PRODUCTS = ["gmail", "drive", "docs", "sheets", "slides", "forms"] as const;
export type GoogleProduct = (typeof GOOGLE_PRODUCTS)[number];
type Row = Record<string, any>;
export const ALICE = "alice@example.com",
  BOB = "bob@example.com";
export const DOC_PARAGRAPHS = 600;
export const ATTACHMENT = Buffer.from([0, 1, 2, 3, 128, 255, 13, 10]);
const SCOPES: Record<GoogleProduct, string[]> = {
  gmail: ["gmail.readonly", "gmail.compose"],
  drive: ["drive"],
  docs: ["documents"],
  sheets: ["spreadsheets"],
  slides: ["presentations"],
  forms: ["forms.body", "forms.responses.readonly"],
};
const HOSTS = new Set([
  "gmail.googleapis.com",
  "www.googleapis.com",
  "docs.googleapis.com",
  "sheets.googleapis.com",
  "slides.googleapis.com",
  "forms.googleapis.com",
  "oauth2.googleapis.com",
]);
export interface GoogleOptions {
  product: GoogleProduct;
  task: number;
  fault?: "500" | "network" | "body";
  boundary?: "split" | "base64" | "binary" | "cursor" | "decision";
}

function paragraph(text: string, startIndex = 1): Row {
  return {
    startIndex,
    endIndex: startIndex + text.length,
    paragraph: {
      elements: [
        { startIndex, endIndex: startIndex + text.length, textRun: { content: text, textStyle: { bold: false } } },
      ],
    },
  };
}
function textOf(doc: Row): string {
  return doc.tabs
    .flatMap((t: Row) =>
      t.documentTab.body.content.map(
        (p: Row) => p.paragraph?.elements.map((e: Row) => e.textRun?.content ?? "").join("") ?? "",
      ),
    )
    .join("");
}

function maskedUpdate(target: Row, value: Row, mask: string): void {
  if (mask === "*") {
    Object.assign(target, structuredClone(value));
    return;
  }
  for (const field of mask.split(",")) {
    const parts = field.split(".");
    let destination = target,
      source: Row | undefined = value;
    for (const key of parts.slice(0, -1)) {
      destination = destination[key] ??= {};
      source = source?.[key];
    }
    const key = parts.at(-1)!;
    if (source?.[key] === undefined) delete destination[key];
    else destination[key] = structuredClone(source[key]);
  }
}

function pageLeaves(elements: Row[]): Row[] {
  return elements.flatMap((element) => (element.elementGroup ? pageLeaves(element.elementGroup.children) : [element]));
}

function documentStyle(document: Row, request: Row): void {
  const range = request.range;
  for (const tab of document.tabs ?? []) {
    if (range.tabId && tab.tabProperties.tabId !== range.tabId) continue;
    for (const block of tab.documentTab.body.content)
      if (block.paragraph) {
        block.paragraph.elements = block.paragraph.elements.flatMap((element: Row) => {
          if (!element.textRun) return [element];
          const start = Math.max(range.startIndex, element.startIndex),
            end = Math.min(range.endIndex, element.endIndex);
          if (start >= end) return [element];
          const boundaries = [element.startIndex, start, end, element.endIndex].filter(
            (value, index, array) => index === 0 || value !== array[index - 1],
          );
          return boundaries.slice(0, -1).map((from, index) => ({
            startIndex: from,
            endIndex: boundaries[index + 1],
            textRun: {
              content: element.textRun.content.slice(
                from - element.startIndex,
                boundaries[index + 1] - element.startIndex,
              ),
              textStyle: { ...element.textRun.textStyle, ...(from >= start && from < end ? request.textStyle : {}) },
            },
          }));
        });
      }
  }
}
function message(n: number, attachment = false): Row {
  return {
    id: `m${n}`,
    threadId: n < 3 ? "t1" : "t2",
    labelIds: n % 2 ? ["INBOX", "UNREAD"] : ["INBOX"],
    internalDate: "1790812800000",
    historyId: "100",
    snippet: `Budget ${n}`,
    payload: {
      mimeType: "multipart/mixed",
      headers: [
        { name: "Subject", value: `Budget ${n}` },
        { name: "From", value: ALICE },
        { name: "To", value: "reviewer@example.com" },
        { name: "Message-ID", value: `<m${n}@example.com>` },
        { name: "References", value: "<root@example.com>" },
        { name: "X-Review-Stage", value: "approved" },
      ],
      parts: [
        {
          partId: "0",
          mimeType: "text/plain",
          filename: "",
          body: { size: 15, data: Buffer.from(`Budget body ${n}.`).toString("base64url") },
        },
        ...(attachment
          ? [
              {
                partId: "1",
                mimeType: "application/octet-stream",
                filename: "evidence.bin",
                body: { size: ATTACHMENT.length, attachmentId: "a1" },
              },
            ]
          : []),
      ],
    },
  };
}
interface GoogleAccount {
  files: Row[];
  permissions: Row[];
  revisions: Row[];
  messages: Row[];
  drafts: Row[];
  document: Row;
  spreadsheet: Row;
  presentation: Row;
  form: Row;
  responses: Row[];
  values: any[][];
  created: Row[];
  uploads: Row[];
  mutations: Row[];
}
/** Selectors use slash, dotted or nested field-mask spelling. */
function selectsField(mask: string | undefined, field: string): boolean {
  return mask === undefined || mask === "*" || new RegExp(`(?:^|[/,(.])${field}(?:[/(),.]|$)`).test(mask);
}

function valuesForSheet(a: GoogleAccount, title: string): any[][] {
  return title === "People"
    ? [
        ["record1", "Alice"],
        ["record2", "Bob"],
      ]
    : a.values;
}

/** The exact grid view served by the fake and reused by equivalent-read controls. */
export function googleSpreadsheet(a: GoogleAccount, includeGrid: boolean, ranges: readonly string[] = []): Row {
  const requested = ranges.map((range) => {
    const named = a.spreadsheet.namedRanges.find((entry: Row) => entry.name === range);
    if (named) return named.range;
    const title = range.includes("!") ? range.slice(0, range.lastIndexOf("!")) : undefined;
    const unquoted = title?.startsWith("'") ? title.slice(1, -1).replaceAll("''", "'") : title;
    const sheet =
      a.spreadsheet.sheets.find((entry: Row) => entry.properties.title === (unquoted ?? range)) ??
      (unquoted === undefined ? a.spreadsheet.sheets[0] : undefined);
    const a1 = range.includes("!") ? range.slice(range.lastIndexOf("!") + 1) : range;
    const match = /^\$?([A-Z]+)([0-9]*)(?::\$?([A-Z]+)([0-9]*))?$/.exec(a1);
    const column = (letters: string) => [...letters].reduce((n, char) => n * 26 + char.charCodeAt(0) - 64, 0) - 1;
    return {
      sheetId: sheet?.properties.sheetId,
      ...(match
        ? {
            startRowIndex: match[2] ? Number(match[2]) - 1 : 0,
            ...(match[4] ? { endRowIndex: Number(match[4]) } : {}),
            startColumnIndex: column(match[1]!),
            endColumnIndex: column(match[3] ?? match[1]!) + 1,
          }
        : {}),
    };
  });
  return {
    ...a.spreadsheet,
    sheets: a.spreadsheet.sheets
      .filter((sheet: Row) => !requested.length || requested.some((r) => r.sheetId === sheet.properties.sheetId))
      .map((sheet: Row) =>
        !includeGrid
          ? sheet
          : {
              ...sheet,
              data: (requested.length ? requested.filter((r) => r.sheetId === sheet.properties.sheetId) : [{}]).map(
                (range: Row) => {
                  const startRow = range.startRowIndex ?? 0,
                    startColumn = range.startColumnIndex ?? 0;
                  return {
                    startRow,
                    startColumn,
                    rowData: valuesForSheet(a, sheet.properties.title)
                      .slice(startRow, range.endRowIndex)
                      .map((row, rowIndex) => ({
                        values: row.slice(startColumn, range.endColumnIndex).map((value, columnIndex) => ({
                          ...sheet.data?.[0]?.rowData?.[startRow + rowIndex]?.values?.[startColumn + columnIndex],
                          userEnteredValue: typeof value === "number" ? { numberValue: value } : { stringValue: value },
                        })),
                      })),
                  };
                },
              ),
            },
      ),
  };
}

export function googleState() {
  const account = (owner: string): GoogleAccount => {
    let position = 1;
    const content = Array.from({ length: DOC_PARAGRAPHS }, (_, i) => {
      const text = `Budget paragraph ${i + 1}: ${i === 2 ? "😀 " : ""}${"review ".repeat(45)}\n`;
      const row = paragraph(text, position);
      position += text.length;
      return row;
    });
    const result: GoogleAccount = {
      files: [
        {
          id: "folder1",
          name: "Review folder",
          mimeType: "application/vnd.google-apps.folder",
          parents: ["root"],
          driveId: "shared1",
        },
        ...GOOGLE_PRODUCTS.filter((p) => !["gmail", "drive"].includes(p)).map((p) => ({
          id: `${p}1`,
          name: `${p} review`,
          mimeType: `application/vnd.google-apps.${({ docs: "document", sheets: "spreadsheet", slides: "presentation", forms: "form" } as Row)[p]}`,
          parents: ["folder1"],
          driveId: "shared1",
        })),
        ...Array.from({ length: 6 }, (_, i) => ({
          id: `pdf${i + 1}`,
          name: `Report ${i + 1}.pdf`,
          mimeType: "application/pdf",
          parents: ["folder1"],
          modifiedTime: "2026-10-01T12:00:00Z",
          trashed: false,
        })),
      ].map((f) => ({
        ...f,
        trashed: false,
        owners: [{ emailAddress: owner }],
        capabilities: { canEdit: true, canShare: true },
      })),
      permissions: [
        {
          id: "perm1",
          type: "user",
          emailAddress: "reviewer@example.com",
          role: "reader",
          permissionDetails: [{ inherited: false, permissionType: "file", role: "reader" }],
        },
        {
          id: "perm2",
          type: "user",
          emailAddress: owner,
          role: "organizer",
          permissionDetails: [
            { inherited: true, inheritedFrom: "shared1", permissionType: "member", role: "organizer" },
          ],
        },
      ],
      revisions: [
        { id: "rv1", modifiedTime: "2026-10-01T12:00:00Z" },
        { id: "rv2", modifiedTime: "2026-10-02T12:00:00Z" },
      ],
      messages: Array.from({ length: 8 }, (_, i) => message(i + 1, i === 0)),
      drafts: [
        { id: "draft1", message: { ...message(9), id: "dm1", threadId: "t1" } },
        { id: "draft-inline", message: { ...message(10, true), id: "dm2", threadId: "t1" } },
      ],
      document: {
        documentId: "docs1",
        title: "docs review",
        revisionId: "r1",
        suggestionsViewMode: "SUGGESTIONS_INLINE",
        namedRanges: {
          Review: {
            namedRanges: [
              { namedRangeId: "nr1", name: "Review", ranges: [{ tabId: "tab1", startIndex: 1, endIndex: 7 }] },
            ],
          },
        },
        tabs: [
          {
            tabProperties: { tabId: "tab1", title: "Review", index: 0 },
            documentTab: { body: { content }, headers: { h1: { content: [paragraph("Review header\n")] } } },
          },
          {
            tabProperties: { tabId: "tab2", title: "Other", index: 1 },
            documentTab: { body: { content: [paragraph("Other tab text\n")] } },
          },
        ],
      },
      spreadsheet: {
        spreadsheetId: "sheets1",
        properties: { title: "sheets review", locale: "en_US", timeZone: "UTC" },
        namedRanges: [
          {
            namedRangeId: "nr1",
            name: "Amounts",
            range: { sheetId: 0, startRowIndex: 0, endRowIndex: 7, startColumnIndex: 0, endColumnIndex: 4 },
          },
        ],
        sheets: [
          {
            properties: { sheetId: 0, title: "Alice's costs", gridProperties: { rowCount: 100, columnCount: 12 } },
            conditionalFormats: [
              {
                ranges: [{ sheetId: 0 }],
                booleanRule: {
                  condition: { type: "NUMBER_GREATER", values: [{ userEnteredValue: "10" }] },
                  format: { textFormat: { bold: true } },
                },
              },
            ],
            protectedRanges: [{ protectedRangeId: 1, range: { sheetId: 0 }, warningOnly: true }],
          },
          { properties: { sheetId: 1, title: "People", gridProperties: { rowCount: 100, columnCount: 4 } } },
        ],
        developerMetadata: [
          {
            metadataId: 7,
            metadataKey: "review",
            metadataValue: "approved",
            visibility: "DOCUMENT",
            location: { spreadsheet: true },
          },
        ],
      },
      values: [
        ["id", "date", "category", "amount"],
        ...Array.from({ length: 6 }, (_, i) => [
          `record${i + 1}`,
          "2026-10-01",
          i % 2 ? "travel" : "office",
          (i + 1) * 10,
        ]),
      ],
      presentation: {
        presentationId: "slides1",
        comments: [],
        commentsViewMode: "COMMENTS_VIEW_MODE_INCLUDED",
        title: "slides review",
        revisionId: "r1",
        layouts: [
          {
            objectId: "layout1",
            layoutProperties: { displayName: "Title", name: "TITLE" },
            pageElements: [{ objectId: "placeholder1", shape: { placeholder: { type: "TITLE", index: 0 } } }],
          },
        ],
        masters: [],
        slides: Array.from({ length: 4 }, (_, i) => ({
          objectId: `slide${i + 1}`,
          pageType: "SLIDE",
          pageElements: [
            {
              objectId: `text${i + 1}`,
              transform: { scaleX: 1, scaleY: 1, translateX: 0, translateY: 0, unit: "PT" },
              shape: {
                shapeType: "TEXT_BOX",
                text: { textElements: [{ textRun: { content: `Review slide ${i + 1}\n`, style: { bold: false } } }] },
              },
            },
          ],
          slideProperties: {
            layoutObjectId: "layout1",
            notesPage: {
              objectId: `notes${i + 1}`,
              notesProperties: { speakerNotesObjectId: `notesText${i + 1}` },
              pageElements: [
                {
                  objectId: `notesText${i + 1}`,
                  shape: {
                    text: {
                      textElements: [{ textRun: { content: `Budget notes ${i + 1}: ${"review ".repeat(400)}` } }],
                    },
                  },
                },
              ],
            },
          },
        })),
      },
      form: {
        formId: "forms1",
        revisionId: "r1",
        info: { title: "forms review", documentTitle: "forms review", description: "Review answers" },
        settings: { quizSettings: { isQuiz: true } },
        linkedSheetId: "sheets1",
        items: [
          {
            itemId: "item1",
            title: "Approved?",
            questionItem: {
              question: {
                questionId: "q1",
                required: true,
                choiceQuestion: {
                  type: "RADIO",
                  options: [{ value: "yes", goToAction: "SUBMIT_FORM" }, { value: "no" }],
                },
                grading: { pointValue: 1, correctAnswers: { answers: [{ value: "yes" }] } },
              },
            },
          },
          {
            itemId: "item2",
            title: "Comment",
            questionItem: { question: { questionId: "q2", textQuestion: { paragraph: true } } },
          },
        ],
      },
      responses: Array.from({ length: 6 }, (_, i) => ({
        responseId: `response${i + 1}`,
        createTime: `2026-10-0${i + 1}T12:00:00Z`,
        lastSubmittedTime: `2026-10-0${i + 1}T12:00:00Z`,
        answers: {
          q1: { questionId: "q1", textAnswers: { answers: [{ value: i % 2 ? "no" : "yes" }] } },
          q2: { questionId: "q2", textAnswers: { answers: [{ value: `Comment ${i + 1}: ${"detail ".repeat(100)}` }] } },
        },
      })),
      created: [] as Row[],
      uploads: [] as Row[],
      mutations: [] as Row[],
    };
    result.presentation.slides[3].pageElements.push({
      objectId: "group1",
      elementGroup: {
        children: [
          {
            objectId: "group2",
            elementGroup: {
              children: [
                {
                  objectId: "nested1",
                  shape: {
                    shapeType: "TEXT_BOX",
                    text: { textElements: [{ textRun: { content: "Grouped review text", style: { bold: false } } }] },
                  },
                },
              ],
            },
          },
        ],
      },
    });
    return result;
  };
  return {
    accounts: { [ALICE]: account(ALICE), [BOB]: account(BOB) },
    mints: [] as { subject: string; scopes: string[] }[],
    faulted: false,
    stale: false,
  };
}
export type GoogleState = ReturnType<typeof googleState>;

const issuers = new Map<string, FakeGoogle>();
const tokens = new Map<string, { world: FakeGoogle; subject: string; scopes: string[] }>();
let originalFetch: typeof fetch | undefined;
let previousTransport: ReturnType<typeof configureGuardedTransport>;

export function installGoogleKitTransport(): void {
  const previous = configureGuardedTransport({ send: (url, init) => globalThis.fetch(url, init) });
  if (!previousTransport) previousTransport = previous;
}

export class FakeGoogle {
  readonly state = googleState();
  readonly boundaryTokens: string[] = [];
  serviceAccount!: { clientEmail: string; privateKey: string };
  private publicKey!: ReturnType<typeof generateKeyPairSync>["publicKey"];
  private catalogBytes = "";
  constructor(
    readonly ledger: Ledger,
    readonly options: GoogleOptions,
  ) {
    if (options.task === 3 && options.product === "gmail")
      for (const a of Object.values(this.state.accounts)) {
        a.messages = Array.from({ length: 100 }, (_, i) => {
          const m = message(i + 1, i === 0);
          const text = `Budget body ${i + 1}: ${"review ".repeat(700)}`;
          m.payload.parts[0].body = { size: Buffer.byteLength(text), data: Buffer.from(text).toString("base64url") };
          return m;
        });
      }
    if (options.task === 3 && options.product === "forms")
      for (const a of Object.values(this.state.accounts)) {
        for (let index = 3; index <= 62; index++) {
          const questionId = `q${index}`;
          a.form.items.push({
            itemId: `item${index}`,
            title: `Review detail ${index}`,
            questionItem: { question: { questionId, textQuestion: { paragraph: true } } },
          });
          for (const response of a.responses)
            response.answers[questionId] = { questionId, textAnswers: { answers: [{ value: "detail ".repeat(315) }] } };
        }
      }
    if (options.task === 3 && options.product === "sheets")
      for (const a of Object.values(this.state.accounts))
        a.values.at(-1)!.push(...Array.from({ length: 8 }, (_, i) => `wide${i + 1}`));
    if (options.task === 3 && options.product === "drive")
      for (const a of Object.values(this.state.accounts)) {
        for (let i = 7; i <= 146; i++)
          a.files.push({ ...a.files.find((f) => f.id === "pdf1")!, id: `pdf${i}`, name: `Report ${i}.pdf` });
        for (const f of a.files) f.name += ` ${"review".repeat(200)}`;
      }
  }

  async start() {
    const key = generateKeyPairSync("rsa", { modulusLength: 2048 });
    this.publicKey = key.publicKey;
    this.serviceAccount = {
      clientEmail: `${randomBytes(12).toString("hex")}@fixture.iam.gserviceaccount.com`,
      privateKey: key.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    };
    const corpus = (directory: URL): string =>
      readdirSync(directory, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((entry) => {
          const file = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
          return entry.isDirectory()
            ? corpus(file)
            : /\.(?:ts|mjs|md)$/i.test(entry.name)
              ? readFileSync(file, "utf8")
              : "";
        })
        .join("\n");
    this.catalogBytes = [...GOOGLE_PRODUCTS, "_shared/google"]
      .map((p) => corpus(new URL(`../../src/providers/${p}/`, import.meta.url)))
      .join("\n");
    issuers.set(this.serviceAccount.clientEmail, this);
    if (!originalFetch) {
      originalFetch = globalThis.fetch;
      const forward = originalFetch;
      globalThis.fetch = async (input, init) => {
        const request = new Request(input, init),
          url = new URL(request.url);
        if (!HOSTS.has(url.hostname)) {
          if (["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return forward(request);
          throw new Error("Unregistered Google fake destination");
        }
        if (url.protocol !== "https:" || url.port) throw new Error("Unregistered Google fake origin");
        if (url.href === "https://oauth2.googleapis.com/token") {
          const parameters = new URLSearchParams(await request.text());
          if (
            request.method !== "POST" ||
            parameters.get("grant_type") !== "urn:ietf:params:oauth:grant-type:jwt-bearer"
          )
            throw new Error("Unregistered Google token method or grant");
          const assertion = parameters.get("assertion") ?? "";
          let claims: Row;
          try {
            claims = JSON.parse(Buffer.from(assertion.split(".")[1] ?? "", "base64url").toString());
          } catch {
            throw new Error("Unregistered Google assertion");
          }
          const world = issuers.get(claims.iss);
          if (!world) throw new Error("Unregistered Google issuer");
          return world.mint(assertion, claims);
        }
        const bearer = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
        const grant = tokens.get(bearer);
        if (!grant) throw new Error("Unregistered Google bearer identity");
        return grant.world.handle(request, grant.subject, grant.scopes);
      };
    }
  }

  private mint(assertion: string, claims: Row): Response {
    const [head, payload, signature] = assertion.split(".");
    const scopes = String(claims.scope ?? "")
      .split(" ")
      .sort();
    const allowed = Object.values(SCOPES).some(
      (set) => JSON.stringify(set.map((s) => `https://www.googleapis.com/auth/${s}`).sort()) === JSON.stringify(scopes),
    );
    if (
      !head ||
      !payload ||
      !signature ||
      !verify("RSA-SHA256", Buffer.from(`${head}.${payload}`), this.publicKey, Buffer.from(signature, "base64url")) ||
      !allowed ||
      ![ALICE, BOB].includes(claims.sub) ||
      claims.aud !== "https://oauth2.googleapis.com/token" ||
      claims.exp <= Date.now() / 1000
    )
      throw new Error("Invalid delegated Google identity, signature or scopes");
    let token: string;
    do {
      token = randomBytes(32).toString("base64url");
    } while (
      Array.from({ length: token.length - 7 }, (_, i) => token.slice(i, i + 8)).some((part) =>
        this.catalogBytes.includes(part),
      )
    );
    tokens.set(token, { world: this, subject: claims.sub, scopes });
    this.state.mints.push({ subject: claims.sub, scopes });
    return Response.json({ access_token: token, expires_in: 3599, token_type: "Bearer" });
  }

  specs(): ConnectorSpec[] {
    return GOOGLE_PRODUCTS.map((product) => ({
      id: product,
      title: product,
      description: `Review ${product} records as the configured Workspace owner`,
      url: "https://unused.example",
      google: { product, serviceAccount: this.serviceAccount, subject: "mapped" },
    }));
  }

  async stop() {
    issuers.delete(this.serviceAccount.clientEmail);
    for (const [key, grant] of tokens) if (grant.world === this) tokens.delete(key);
    if (!issuers.size && originalFetch) {
      globalThis.fetch = originalFetch;
      originalFetch = undefined;
      configureGuardedTransport(previousTransport);
      previousTransport = undefined;
    }
  }

  async handle(request: Request, subject: string, scopes: string[]): Promise<Response> {
    const url = new URL(request.url);
    const product = url.hostname === "www.googleapis.com" ? "drive" : (url.hostname.split(".")[0] as GoogleProduct);
    if (
      !GOOGLE_PRODUCTS.includes(product) ||
      !SCOPES[product].every((s) => scopes.includes(`https://www.googleapis.com/auth/${s}`))
    )
      throw new Error("Google fake refused destination/scope mismatch");
    const prefix = {
      gmail: "/gmail/v1/users/me",
      drive: url.pathname.startsWith("/upload/") ? "/upload/drive/v3" : "/drive/v3",
      docs: "/v1",
      sheets: "/v4",
      slides: "/v1",
      forms: "/v1",
    }[product];
    if (!url.pathname.startsWith(`${prefix}/`)) throw new Error("Google fake refused destination path");
    const path = decodeURIComponent(url.pathname.slice(prefix.length));
    const read =
      request.method === "GET" ||
      [":batchGetByDataFilter", ":getByDataFilter", "/developerMetadata:search"].some((s) => path.endsWith(s));
    const wire = Buffer.from(await request.arrayBuffer());
    const raw = wire.toString("latin1");
    let body: Row = {};
    if (raw && request.headers.get("content-type")?.includes("application/json"))
      body = JSON.parse(wire.toString("utf8"));
    const query: Row = Object.fromEntries(
      [...new Set(url.searchParams.keys())].map((key) => [
        key,
        url.searchParams.getAll(key).length > 1 ? url.searchParams.getAll(key) : url.searchParams.get(key),
      ]),
    );
    let upload: Row | undefined;
    const boundary = /boundary=([^;]+)/.exec(request.headers.get("content-type") ?? "")?.[1];
    if (boundary) {
      const parts = raw.split(`--${boundary}`);
      body = JSON.parse(parts[1]!.split("\r\n\r\n")[1]!.trim());
      const media = parts[2]!.slice(parts[2]!.indexOf("\r\n\r\n") + 4).replace(/\r\n$/, "");
      upload = { base64: Buffer.from(media, "latin1").toString("base64"), mimeType: body.mimeType };
    }
    const call: CallRecord = {
      seq: this.ledger.next(),
      at: Date.now(),
      service: product,
      tool: `${request.method} ${path}`,
      args: {
        method: request.method,
        path,
        query,
        body,
        subject,
        ...(upload ? { upload } : {}),
        contentType: request.headers.get("content-type"),
        returned: [],
      },
      kind: read ? "read" : "write",
      outcome: "ok",
      resultBytes: 0,
    };
    this.ledger.calls.push(call);
    const account = this.state.accounts[subject as typeof ALICE]!;
    if (this.options.boundary) {
      const token = request.headers.get("authorization")!.slice(7);
      this.boundaryTokens.push(token);
      if (this.options.boundary === "split" && product === "docs") {
        const pieces = Array.from({ length: Math.ceil(token.length / 4) }, (_, i) => token.slice(i * 4, i * 4 + 4));
        account.document.tabs[0].documentTab.body.content = [
          {
            startIndex: 1,
            endIndex: 5001 + token.length,
            paragraph: {
              elements: [
                { textRun: { content: "review ".repeat(700) } },
                ...pieces.map((content) => ({ textRun: { content } })),
              ],
            },
          },
        ];
      }
      if (this.options.boundary === "base64" && product === "gmail")
        account.messages[0]!.payload.parts[0].body = {
          size: token.length,
          data: Buffer.from(token).toString("base64url"),
        };
      if (this.options.boundary === "decision" && product === "drive")
        account.files.find((f) => f.id === "pdf1")!.mimeType = token;
      if (this.options.boundary === "binary" && product === "drive" && query.alt === "media") {
        const bytes = Buffer.concat([ATTACHMENT, Buffer.from(token), ATTACHMENT]);
        call.resultBytes = bytes.length;
        return new Response(bytes, { headers: { "content-type": "application/octet-stream" } });
      }
    }
    try {
      const result = this.route(product, request.method, path, query, body, account, call);
      if (result instanceof Response) {
        call.outcome = result.ok ? "ok" : "tool_error";
        return result;
      }
      if (this.options.boundary === "cursor" && product === "forms" && path === "/forms/forms1/responses")
        (result as Row).nextPageToken = request.headers.get("authorization")!.slice(7);
      const serialized = JSON.stringify(result);
      call.resultBytes = serialized.length;
      call.args.returned = structuredClone(result);
      if (!read && this.options.product === product && this.options.task === 6 && !this.state.faulted) {
        this.state.faulted = true;
        call.outcome = "fault";
        call.error = "HTTP 500";
        if (this.options.fault === "network") throw new Error("Injected post-commit network failure");
        if (this.options.fault === "body")
          return new Response(
            new ReadableStream({
              start(c) {
                c.error(new Error("Injected incomplete body"));
              },
            }),
            { headers: { "content-type": "application/json" } },
          );
        return Response.json(
          { error: { code: 500, status: "INTERNAL", message: "Injected post-commit failure" } },
          { status: 500 },
        );
      }
      return Response.json(result);
    } catch (error) {
      call.outcome = "fault";
      call.error = String(error);
      throw error;
    }
  }

  private route(
    product: GoogleProduct,
    method: string,
    path: string,
    query: Row,
    body: Row,
    a: GoogleState["accounts"][typeof ALICE],
    call: CallRecord,
  ): unknown {
    const page = (rows: Row[], key: string) => {
      const token = query.pageToken;
      const size = Math.min(
        this.options.product === "drive" && this.options.task === 3 ? 100 : 2,
        Number(query.maxResults ?? query.pageSize ?? 2),
      );
      const offset = token === "empty" ? size : token ? Number(String(token).slice(1)) : 0;
      if (token === "empty") return { [key]: [], nextPageToken: `p${size}` };
      const slice = rows.slice(offset, offset + size);
      return {
        [key]: slice,
        ...(offset + size < rows.length ? { nextPageToken: offset === 0 ? "empty" : `p${offset + size}` } : {}),
      };
    };
    const bump = (obj: Row) => {
      obj.revisionId = `r${Number(String(obj.revisionId ?? "r1").slice(1)) + 1}`;
    };
    const mutate = () => a.mutations.push({ product, method, path, body: structuredClone(body) });
    if (product === "gmail") {
      if (method === "GET") {
        if (path === "/labels")
          return {
            labels: [
              { id: "INBOX", name: "Inbox", type: "system" },
              { id: "UNREAD", name: "Unread", type: "system" },
            ],
          };
        if (path === "/profile") return { emailAddress: call.args.subject, messagesTotal: a.messages.length };
        if (path === "/threads")
          return page(
            [
              { id: "t1", snippet: "Budget" },
              { id: "t2", snippet: "Budget" },
            ],
            "threads",
          );
        if (path === "/messages")
          return page(
            a.messages
              .filter((m) => !query.q?.includes("is:unread") || m.labelIds.includes("UNREAD"))
              .map(({ id, threadId }) => ({ id, threadId })),
            "messages",
          );
        if (path === "/drafts") return page(a.drafts, "drafts");
        if (path.startsWith("/threads/"))
          return {
            id: path.split("/")[2],
            historyId: "100",
            messages: a.messages.filter((m) => m.threadId === path.split("/")[2]),
          };
        if (/\/attachments\//.test(path)) return { size: ATTACHMENT.length, data: ATTACHMENT.toString("base64url") };
        if (path.startsWith("/messages/")) return a.messages.find((m) => m.id === path.split("/")[2]) ?? {};
        if (path.startsWith("/drafts/")) return a.drafts.find((d) => d.id === path.split("/")[2]) ?? {};
      }
      if ((method === "POST" && path === "/drafts") || (method === "PUT" && path === "/drafts/draft1")) {
        mutate();
        const mime = Buffer.from(body.message.raw, "base64url").toString();
        const [headerText, ...mimeBody] = mime.split("\r\n\r\n");
        const encoded = mimeBody.join("\r\n\r\n").trim();
        const decoded = /Content-Transfer-Encoding: base64/i.test(headerText ?? "")
          ? Buffer.from(encoded, "base64").toString()
          : encoded;
        const headers = (headerText ?? "")
          .replace(/\r\n[ \t]+/g, " ")
          .split("\r\n")
          .filter((line) => line.includes(":"))
          .map((line) => ({ name: line.slice(0, line.indexOf(":")), value: line.slice(line.indexOf(":") + 1).trim() }));
        const saved = {
          id: method === "POST" ? "draft-new" : "draft1",
          message: {
            ...message(9),
            ...body.message,
            id: "dm1",
            payload: {
              mimeType: "text/plain",
              headers,
              body: { data: Buffer.from(decoded).toString("base64url"), size: Buffer.byteLength(decoded) },
            },
          },
        };
        const existing = a.drafts.findIndex((d) => d.id === saved.id);
        if (existing < 0) a.drafts.push(saved);
        else a.drafts[existing] = saved;
        return saved;
      }
    }
    if (product === "drive") {
      if (method === "GET") {
        if (path === "/drives") return { drives: [{ id: "shared1", name: "Review shared drive" }] };
        if (path === "/drives/shared1") return { id: "shared1", name: "Review shared drive" };
        if (path === "/files") {
          const name = /name\s*=\s*'([^']+)'/.exec(query.q ?? "")?.[1];
          return page(
            a.files
              .filter((f) => !name || f.name === name)
              .filter((f) => !query.q?.includes("application/pdf") || f.mimeType === "application/pdf")
              .filter((f) => !query.q?.includes("'folder1' in parents") || f.parents?.includes("folder1")),
            "files",
          );
        }
        if (path.endsWith("/permissions")) return page(a.permissions, "permissions");
        if (/\/permissions\/perm/.test(path)) return a.permissions.find((p) => p.id === path.split("/").at(-1));
        if (path.endsWith("/revisions")) return page(a.revisions, "revisions");
        if (/^\/files\/[^/]+$/.test(path)) {
          const file = a.files.find((f) => f.id === path.split("/")[2]) ?? {};
          return query.fields !== undefined && selectsField(query.fields, "permissions")
            ? { ...file, permissions: a.permissions }
            : file;
        }
      }
      if (method === "POST" && path === "/files") {
        mutate();
        const file = {
          id: "upload1",
          name: body.name ?? "evidence.bin",
          mimeType: body.mimeType ?? "application/octet-stream",
          parents: body.parents ?? ["folder1"],
        };
        a.created.push(file);
        a.uploads.push({ ...(call.args.upload as Row), contentType: call.args.contentType, file });
        a.files.push(file as any);
        return file;
      }
      if (method === "PATCH" && path === "/files/pdf1") {
        mutate();
        Object.assign(
          a.files.find((f) => f.id === "pdf1")!,
          body,
        );
        return a.files.find((f) => f.id === "pdf1");
      }
      if (method === "PATCH" && path.endsWith("/permissions/perm1")) {
        mutate();
        Object.assign(a.permissions[0]!, body);
        return a.permissions[0];
      }
    }
    if (product === "docs") {
      if (method === "GET" && path === "/documents/docs1") return a.document;
      if (method === "GET" && path.startsWith("/documents/new-doc"))
        return a.created.find((d) => d.documentId === "new-doc");
      if (method === "POST" && path === "/documents") {
        mutate();
        const doc = { documentId: "new-doc", title: body.title, revisionId: "r1", body: { content: [] } };
        a.created.push(doc);
        a.files.push({
          id: doc.documentId,
          name: doc.title,
          mimeType: "application/vnd.google-apps.document",
          parents: ["root"],
          trashed: false,
        });
        return doc;
      }
      if (method === "POST" && path.endsWith(":batchUpdate")) {
        if (this.options.task === 7 && path.includes("new-doc") && !this.state.faulted) {
          this.state.faulted = true;
          call.outcome = "tool_error";
          return Response.json(
            { error: { code: 400, status: "INVALID_ARGUMENT", message: "Initial text refused" } },
            { status: 400 },
          );
        }
        const target = path.includes("new-doc") ? a.created.find((d) => d.documentId === "new-doc")! : a.document;
        if (body.writeControl?.requiredRevisionId && body.writeControl.requiredRevisionId !== target.revisionId) {
          call.outcome = "tool_error";
          return Response.json({ error: { code: 400, status: "FAILED_PRECONDITION" } }, { status: 400 });
        }
        mutate();
        for (const r of body.requests ?? [])
          if (r.insertText) {
            if (path.includes("new-doc")) {
              const doc = a.created.find((d) => d.documentId === "new-doc")!;
              doc.body.content.push(paragraph(r.insertText.text));
            } else
              a.document.tabs[0].documentTab.body.content.push(
                paragraph(r.insertText.text, textOf(a.document).length + 1),
              );
          } else if (r.updateTextStyle) documentStyle(target, r.updateTextStyle);
        bump(target);
        return {
          documentId: path.split("/")[2]?.split(":")[0],
          replies: (body.requests ?? []).map(() => ({})),
          writeControl: { requiredRevisionId: target.revisionId },
        };
      }
    }
    if (product === "sheets") {
      const spreadsheet = (includeGrid: boolean) =>
        googleSpreadsheet(
          a,
          includeGrid,
          query.ranges ? (Array.isArray(query.ranges) ? query.ranges : [query.ranges]) : [],
        );
      if (method === "GET" && path === "/spreadsheets/sheets1") {
        const result = spreadsheet(
          query.includeGridData === "true" || (query.fields !== undefined && selectsField(query.fields, "data")),
        );
        if (!selectsField(query.fields, "developerMetadata")) delete result.developerMetadata;
        return result;
      }
      if ((method === "GET" && path.includes("/values")) || path.endsWith(":batchGetByDataFilter")) {
        const ranges =
          body.dataFilters?.map((d: Row) => d.a1Range) ??
          (query.ranges
            ? Array.isArray(query.ranges)
              ? query.ranges
              : [query.ranges]
            : [path.split("/values/")[1] ?? "'Alice''s costs'!A1:D7"]);
        const values = ranges.map((range: string) => {
          const table: unknown[][] = valuesForSheet(a, range.includes("People") ? "People" : "Alice's costs");
          const selected = /!\$?([A-Z]+)([0-9]*)?(?::\$?([A-Z]+)([0-9]*)?)?$/.exec(range);
          const column = (letters: string) =>
            [...letters].reduce((total, char) => total * 26 + char.charCodeAt(0) - 64, 0) - 1;
          const from = selected?.[2] ? Number(selected[2]) - 1 : 0,
            to = selected?.[4] ? Number(selected[4]) : range === "Amounts" ? 7 : table.length;
          const left = selected ? column(selected[1]!) : 0,
            right = selected ? column(selected[3] ?? selected[1]!) + 1 : 4;
          return { range, majorDimension: "ROWS", values: table.slice(from, to).map((row) => row.slice(left, right)) };
        });
        return method === "POST"
          ? {
              spreadsheetId: "sheets1",
              valueRanges: values.map((valueRange: Row) => ({ valueRange, dataFilters: body.dataFilters })),
            }
          : path.includes(":batchGet")
            ? { spreadsheetId: "sheets1", valueRanges: values }
            : values[0];
      }
      if (path.endsWith(":getByDataFilter")) return spreadsheet(body.includeGridData === true);
      if (path.endsWith("/developerMetadata:search"))
        return {
          matchedDeveloperMetadata: a.spreadsheet.developerMetadata.map((developerMetadata: Row) => ({
            developerMetadata,
          })),
        };
      if (path.endsWith(":append") && method === "POST") {
        mutate();
        a.values.push(...body.values);
        return {
          spreadsheetId: "sheets1",
          tableRange: "'Alice''s costs'!A1:D7",
          updates: {
            updatedRange: "'Alice''s costs'!A8:D8",
            updatedRows: body.values.length,
            updatedColumns: 4,
            updatedCells: body.values.length * 4,
          },
        };
      }
      if (method === "PUT" && path.includes("/values/")) {
        mutate();
        a.values.splice(1, body.values.length, ...body.values);
        return {
          spreadsheetId: "sheets1",
          updatedRows: body.values.length,
          updatedCells: 4,
          updatedRange: path.split("/values/")[1],
        };
      }
      if (method === "POST" && path.endsWith(":batchUpdate")) {
        mutate();
        for (const request of body.requests ?? [])
          if (request.repeatCell) {
            const change = request.repeatCell,
              sheet = a.spreadsheet.sheets.find((entry: Row) => entry.properties.sheetId === change.range.sheetId);
            sheet.data = [
              {
                startRow: change.range.startRowIndex ?? 0,
                startColumn: change.range.startColumnIndex ?? 0,
                rowData: Array.from(
                  { length: (change.range.endRowIndex ?? 1) - (change.range.startRowIndex ?? 0) },
                  () => ({
                    values: Array.from(
                      { length: (change.range.endColumnIndex ?? 4) - (change.range.startColumnIndex ?? 0) },
                      () => structuredClone(change.cell),
                    ),
                  }),
                ),
              },
            ];
          }
        return { spreadsheetId: "sheets1", replies: (body.requests ?? []).map(() => ({})) };
      }
    }
    if (product === "slides") {
      if (method === "GET" && path === "/presentations/slides1") return a.presentation;
      if (method === "GET" && path.includes("/pages/"))
        return [...a.presentation.slides, ...a.presentation.layouts]
          .flatMap((s: Row) => [s, s.slideProperties?.notesPage])
          .filter(Boolean)
          .find((s: Row) => s.objectId === path.split("/").at(-1));
      if (method === "POST" && path.endsWith(":batchUpdate")) {
        if (
          body.writeControl?.requiredRevisionId &&
          body.writeControl.requiredRevisionId !== a.presentation.revisionId
        ) {
          call.outcome = "tool_error";
          return Response.json({ error: { code: 400, status: "FAILED_PRECONDITION" } }, { status: 400 });
        }
        mutate();
        const replies = (body.requests ?? []).map((r: Row) => {
          if (r.updateTextStyle)
            for (const slide of a.presentation.slides)
              for (const leaf of pageLeaves(slide.pageElements))
                if (leaf.objectId === r.updateTextStyle.objectId)
                  for (const element of leaf.shape?.text?.textElements ?? [])
                    if (element.textRun)
                      element.textRun.style = { ...element.textRun.style, ...r.updateTextStyle.style };
          if (r.createSlide) {
            a.presentation.slides.splice(r.createSlide.insertionIndex ?? a.presentation.slides.length, 0, {
              objectId: r.createSlide.objectId,
              pageElements: [],
              slideProperties: { layoutObjectId: "layout1" },
            });
            return { createSlide: { objectId: r.createSlide.objectId } };
          }
          if (r.replaceAllText) {
            for (const slide of a.presentation.slides)
              for (const el of pageLeaves(slide.pageElements))
                for (const text of el.shape?.text?.textElements ?? [])
                  if (text.textRun)
                    text.textRun.content = text.textRun.content.replaceAll(
                      r.replaceAllText.containsText.text,
                      r.replaceAllText.replaceText,
                    );
            return { replaceAllText: { occurrencesChanged: 4 } };
          }
          return {};
        });
        bump(a.presentation);
        return {
          presentationId: "slides1",
          replies,
          writeControl: { requiredRevisionId: a.presentation.revisionId },
          ...(this.options.task === 7 ? { commentUpdateState: "COMMENT_UPDATE_STATE_UNSPECIFIED" } : {}),
        };
      }
    }
    if (product === "forms") {
      if (method === "GET" && path === "/forms/forms1") return a.form;
      if (method === "GET" && path === "/forms/forms1/responses")
        return page(
          a.responses.filter(
            (r) =>
              !query.filter ||
              r.lastSubmittedTime >
                String(query.filter)
                  .replace(/^timestamp\s*>\s*/, "")
                  .replaceAll('"', ""),
          ),
          "responses",
        );
      if (method === "GET" && path.startsWith("/forms/forms1/responses/"))
        return a.responses.find((r) => r.responseId === path.split("/").at(-1));
      if (method === "POST" && path.endsWith(":batchUpdate")) {
        if (this.options.task === 7 && !this.state.stale) {
          this.state.stale = true;
          bump(a.form);
          call.outcome = "tool_error";
          return Response.json(
            { error: { code: 400, status: "FAILED_PRECONDITION", message: "Concurrent revision" } },
            { status: 400 },
          );
        }
        if (body.writeControl?.requiredRevisionId && body.writeControl.requiredRevisionId !== a.form.revisionId) {
          call.outcome = "tool_error";
          return Response.json({ error: { code: 400, status: "FAILED_PRECONDITION" } }, { status: 400 });
        }
        mutate();
        const replies = (body.requests ?? []).map((r: Row) => {
          if (r.updateFormInfo) maskedUpdate(a.form.info, r.updateFormInfo.info, r.updateFormInfo.updateMask);
          if (r.updateItem)
            maskedUpdate(a.form.items[r.updateItem.location.index]!, r.updateItem.item, r.updateItem.updateMask);
          if (r.createItem) {
            const item = { ...r.createItem.item, itemId: "item-new" };
            if (item.questionItem) item.questionItem.question.questionId = "q-new";
            a.form.items.splice(r.createItem.location.index, 0, item);
            return { createItem: { itemId: "item-new", questionId: ["q-new"] } };
          }
          return {};
        });
        bump(a.form);
        return { replies, writeControl: { requiredRevisionId: a.form.revisionId } };
      }
    }
    throw new Error(`Unregistered Google fake route: ${product} ${method} ${path}`);
  }
}
