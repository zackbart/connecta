// Run with: npx tsx scripts/bench-sent-secrets.mjs
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
