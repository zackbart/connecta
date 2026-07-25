import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const work = await mkdtemp(join(tmpdir(), "connecta-package-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function run(command, args, cwd) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
}

try {
  const packed = JSON.parse(
    run(
      npm,
      ["pack", "--json", "--ignore-scripts", "--pack-destination", work],
      root,
    ),
  )[0];
  const archive = join(work, packed.filename);
  const paths = new Set(packed.files.map((file) => file.path));

  for (const required of [
    "README.md",
    "LICENSE",
    "assets/connecta-clay-hero.png",
    "dist/index.js",
    "dist/index.d.ts",
    "dist/json-schema.js",
    "dist/json-schema.d.ts",
    "src/index.ts",
  ]) {
    if (!paths.has(required)) {
      throw new Error(`Packed artifact is missing ${required}`);
    }
  }
  for (const path of paths) {
    if (
      path.includes("connectors/cloudflare") ||
      path.includes("storage/cloudflare")
    ) {
      throw new Error(`Platform-specific implementation leaked into ${path}`);
    }
  }

  await writeFile(
    join(work, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  await writeFile(
    join(work, "smoke.mjs"),
    `
const core = await import("@zackbart/connecta");
if (typeof core.createConnecta !== "function") throw new Error("missing core");
if (typeof core.validateToolInput !== "function") {
  throw new Error("missing validateToolInput");
}
const jsonSchema = await import("@zackbart/connecta/json-schema");
if (typeof jsonSchema.Validator !== "function") {
  throw new Error("missing Validator re-export");
}
for (const name of [
  "clerkAuth",
  "cloudflareApi",
  "cloudflareKvStorage",
  "d1ActivityStore",
  "quickJsExecutor",
]) {
  if (name in core) throw new Error(name + " leaked into the core entry");
}
`,
  );
  await writeFile(
    join(work, "optional.mjs"),
    `
const clerk = await import("@zackbart/connecta/auth/clerk");
const quickjs = await import("@zackbart/connecta/quickjs");
if (typeof clerk.clerkAuth !== "function") throw new Error("missing Clerk adapter");
if (typeof quickjs.quickJsExecutor !== "function") throw new Error("missing QuickJS adapter");
`,
  );
  run(
    npm,
    ["install", "--ignore-scripts", "--omit=optional", archive],
    work,
  );
  for (const dependency of ["@clerk/backend", "quickjs-emscripten"]) {
    if (existsSync(join(work, "node_modules", dependency))) {
      throw new Error(`Optional peer ${dependency} was installed with core`);
    }
  }
  run(process.execPath, ["smoke.mjs"], work);

  run(
    npm,
    [
      "install",
      "--ignore-scripts",
      "@clerk/backend@^3.12.0",
      "quickjs-emscripten@^0.32.0",
    ],
    work,
  );
  run(process.execPath, ["optional.mjs"], work);

  console.log(
    `package smoke passed (${packed.entryCount} files, ${packed.size} bytes)`,
  );
} finally {
  await rm(work, { recursive: true, force: true });
}
