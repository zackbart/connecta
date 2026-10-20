// Run with: pnpm exec tsx scripts/bench-sent-secrets.mjs
import { generateKeyPairSync } from "node:crypto";
import { CredentialVault } from "../src/credentials.ts";
import { SentSecrets } from "../src/sent-secrets.ts";
import { memoryStorage } from "../src/storage/memory.ts";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const values = {
  privateKey,
  accessToken: "ghs_benchmark_credential0123456789",
  refreshToken: "refresh_benchmark_credential0123456789",
};
const vault = new CredentialVault(memoryStorage(), btoa(String.fromCharCode(...new Uint8Array(32).fill(7))));
await vault.setAll("benchmark", values, "benchmark");
const secrets = new SentSecrets();
for (const value of Object.values(await vault.getAll("benchmark"))) secrets.add(value);
const rows = Array.from({ length: 10_000 }, (_, id) => ({
  id,
  name: `repository-${id}`,
  description: id % 10 === 0 ? `token ${values.accessToken}` : "Ordinary repository description with no credential",
  owner: "acme",
}));
const started = performance.now();
const result = secrets.redact(rows);
const coldMs = performance.now() - started;
const warmed = performance.now();
secrets.redact(rows);
const warmMs = performance.now() - warmed;
if (result[0].description !== "[redacted]") throw new Error("Benchmark redaction failed");
process.stdout.write(
  `${JSON.stringify({ rows: rows.length, vaultSecrets: Object.keys(values).length, coldMs, warmMs })}\n`,
);

// The output boundary on provider-cap bodies, structured rows, wire text and declared binary
// content, under payload and envelope rules. Medians of three warm runs; no test-time
// deadlines on a shared host. Set BENCH_MODULE to compare another build of sent-secrets.
const { SentSecrets: Boundary } = await import(process.env.BENCH_MODULE ?? "../src/sent-secrets.ts");
const TOKEN = "qL8!mP2#vX6$kN4?rS9@tW3+eZ7=F5/u";
const boundary = new Boundary();
boundary.add(TOKEN);
boundary.arguments(
  { value: "012345678900" },
  { type: "object", properties: { value: { type: "string", writeOnly: true } } },
);
const sentence = "Public notes: the team will meet on Tuesday to confirm the schedule and publish the agenda. ";
const body = (bytes) => sentence.repeat(Math.ceil(bytes / sentence.length)).slice(0, bytes);
function measure(label, value, bytes, run) {
  const before = performance.now();
  const result = run(value);
  const coldMs = performance.now() - before;
  const samples = [];
  for (let repeat = 0; repeat < 3; repeat++) {
    const started = performance.now();
    run(value);
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  const warmMedianMs = samples[1];
  if (JSON.stringify(result).includes(TOKEN)) throw new Error("Boundary benchmark leaked");
  process.stdout.write(
    `${JSON.stringify({ label, bytes, coldMs: Math.round(coldMs), warmMedianMs: Math.round(warmMedianMs), MiBPerSecond: Math.round(bytes / 1_048_576 / (warmMedianMs / 1000)) })}\n`,
  );
}
const payload = (value) => boundary.redact(value);
const envelope = (value) => boundary.redact(value, "envelope");
for (const MiB of [1, 4, 16]) {
  const text = body(MiB * 1_048_576 - 40) + ` echo ${TOKEN}`;
  measure(`${MiB} MiB text, payload`, { text }, text.length, payload);
  measure(`${MiB} MiB text, envelope`, { text }, text.length, envelope);
}
for (const count of [10_000, 100_000]) {
  const rows = Array.from({ length: count }, (_, id) => ({ id, text: sentence, public: "Public title.", ok: true }));
  rows[count - 1].text = `echo ${TOKEN}`;
  measure(`${count} structured rows, payload`, rows, JSON.stringify(rows).length, payload);
}
const wire = JSON.stringify({
  rows: Array.from({ length: 20_000 }, (_, id) => ({ id, text: `${sentence}"quoted"\\path` })),
});
measure("4 MiB-class wire JSON text", wire, wire.length, (value) => boundary.text(value));
const binary = body(1_048_576 - 34) + `x${TOKEN}z`;
measure("1 MiB declared binary (embedded echo)", { format: "base64", content: btoa(binary) }, binary.length, payload);
