/** Local cold/warm characterization, no model calls or real Google traffic. */
import { spawnSync } from "node:child_process";
import { FakeGoogle, GOOGLE_PRODUCTS, ALICE, installGoogleKitTransport } from "./fakes/google.js";
import { Ledger } from "./fakes/service.js";
import { memoryStorage } from "../src/storage/memory.js";
import { performance } from "node:perf_hooks";

const selected = process.argv[2];
if (!selected) {
  const rows = GOOGLE_PRODUCTS.map((product) => {
    const child = spawnSync(process.execPath, ["--import", "tsx", import.meta.filename, product], { encoding: "utf8" });
    if (child.status !== 0) throw new Error(child.stderr);
    return JSON.parse(child.stdout);
  });
  console.log(JSON.stringify({ node: process.version, rows }, null, 2));
} else {
  const product = GOOGLE_PRODUCTS.find((p) => p === selected);
  if (!product) throw new Error("Unknown Google product");
  const ledger = new Ledger(),
    world = new FakeGoogle(ledger, { product, task: 1 });
  await world.start();
  const importStart = performance.now();
  const module = await import(`../src/providers/${product}/index.ts`);
  const importMs = performance.now() - importStart;
  const factoryStart = performance.now();
  const connector = module[product](product, {
    purpose: "Review records",
    serviceAccount: world.serviceAccount,
    subject: ALICE,
  });
  const factoryMs = performance.now() - factoryStart;
  const [tool, args] = (
    {
      gmail: ["list_labels", {}],
      drive: ["get_file", { fileId: "pdf1" }],
      docs: ["get_document", { documentId: "docs1", maxChars: 0 }],
      sheets: ["get_spreadsheet", { spreadsheetId: "sheets1" }],
      slides: ["get_presentation", { presentationId: "slides1", limit: 1, maxCharsPerSlide: 10 }],
      forms: ["get_form", { formId: "forms1" }],
    } as const
  )[product];
  const context = {
    storage: memoryStorage(),
    baseUrl: "https://connecta.example",
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  };
  const forward = globalThis.fetch;
  let firstSend: number | undefined;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== "oauth2.googleapis.com" && firstSend === undefined) firstSend = performance.now();
    return forward(input, init);
  };
  installGoogleKitTransport();
  const rows = [];
  try {
    for (const temperature of ["cold", "warm"]) {
      firstSend = undefined;
      const mints = world.state.mints.length,
        start = performance.now();
      await connector.callTool(tool, args, context);
      rows.push({
        temperature,
        callToFirstSendMs: firstSend === undefined ? null : firstSend - start,
        totalMs: performance.now() - start,
        tokenMints: world.state.mints.length - mints,
      });
    }
    console.log(JSON.stringify({ product, importMs, factoryMs, calls: rows }));
  } finally {
    globalThis.fetch = forward;
    await world.stop();
  }
}
