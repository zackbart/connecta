// Enumerate non-JSON success media without moving a provider's pin.
// Usage: node scripts/audit-provider-media.mjs <provider> <exact-pin-document>
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const [provider, file] = process.argv.slice(2);
if (!/^[a-z-]+$/.test(provider ?? "") || !file) throw Error("Supply a provider and its exact pinned document.");
const pin = JSON.parse(readFileSync(new URL(`../src/providers/${provider}/evidence/openapi.json`, import.meta.url)));
const bytes = readFileSync(file);
if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== pin.digest) throw Error("Wrong pin.");
const document = JSON.parse(bytes);
const resolve = (value) =>
  value?.$ref
    ? resolve(
        value.$ref
          .slice(2)
          .split("/")
          .reduce((object, key) => object[key.replace(/~1/g, "/").replace(/~0/g, "~")], document),
      )
    : value;
const media = {};
for (const [path, item] of Object.entries(document.paths)) {
  for (const [method, raw] of Object.entries(resolve(item))) {
    if (!/^(get|head|post|put|patch|delete)$/.test(method)) continue;
    for (const [status, response] of Object.entries(resolve(raw).responses ?? {})) {
      if (!/^2(?:\d\d|XX)$/.test(status)) continue;
      for (const type of Object.keys(resolve(response)?.content ?? {})) {
        if (/^application\/(?:json|[^/]+\+json)$/i.test(type) && type !== "application/stream+json") continue;
        const key = `${method.toUpperCase()} ${path}`;
        media[key] = [...new Set([...(media[key] ?? []), type])];
      }
    }
  }
}
console.log(JSON.stringify(media, null, 2));
