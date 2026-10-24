import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
const bytes = readFileSync(process.argv[2]);
if (
  createHash("sha256").update(bytes).digest("hex") !==
  "4a06e85c284876c709f791b05b27e56f2a612d4eb7edc95edea6cc14f0d94b9a"
)
  throw Error("Wrong pin");
const doc = JSON.parse(bytes);
const resolve = (x) =>
  x?.$ref
    ? resolve(
        x.$ref
          .slice(2)
          .split("/")
          .reduce((o, k) => o[k.replace(/~1/g, "/").replace(/~0/g, "~")], doc),
      )
    : x;
const methods = new Set(["get", "post", "put", "patch", "delete", "head", "options", "trace"]);
let count = 0,
  deprecated = 0;
const rows = [];
for (const [path, p] of Object.entries(doc.paths))
  for (const [method, raw] of Object.entries(resolve(p))) {
    if (!methods.has(method)) continue;
    const op = resolve(raw);
    count++;
    if (op.deprecated) deprecated++;
    for (const [status, r] of Object.entries(op.responses ?? {}))
      if (/^2\d\d$/.test(status) || status === "2XX") {
        const media = Object.keys(resolve(r).content ?? {});
        const nonJSON = media.filter(
          (m) => m === "application/stream+json" || !/^application\/(?:json|[^/]+\+json)$/i.test(m),
        );
        if (nonJSON.length)
          rows.push({ operation: method.toUpperCase() + " " + path, status, media, deprecated: !!op.deprecated });
      }
  }
console.log(JSON.stringify({ count, deprecated, rows }, null, 2));
