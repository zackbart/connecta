import { readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { build, transform } from "esbuild";
import { compile } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generatedPath = resolve(root, "src/operator-ui/generated.ts");
const pageStylesPath = resolve(root, "src/page-styles.ts");
const checkOnly = process.argv.includes("--check");
const cssDirectory = resolve(root, "src/operator-ui");
const compiler = await compile(await readFile(resolve(cssDirectory, "browser.css"), "utf8"), {
  base: cssDirectory,
  onDependency() {},
});
const scanner = new Scanner({
  sources: [{ base: resolve(cssDirectory, "app"), pattern: "**/*.{ts,tsx}", negated: false }],
});
let css = compiler.build(scanner.scan());
const fontPaths = {
  "@fontsource-variable/geist/files/geist-latin-wght-normal.woff2": fileURLToPath(
    import.meta.resolve("@fontsource-variable/geist/files/geist-latin-wght-normal.woff2"),
  ),
  "@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2": fileURLToPath(
    import.meta.resolve("@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2"),
  ),
};
for (const [specifier, path] of Object.entries(fontPaths)) css = css.replace(specifier, path);
const result = await build({
  absWorkingDir: root,
  bundle: true,
  charset: "utf8",
  entryNames: "[name]-[hash]",
  assetNames: "[name]-[hash]",
  entryPoints: {
    script: "src/operator-ui/app/main.tsx",
    // Blocking in <head>: applies the saved color scheme before first paint.
    scheme: "src/operator-ui/app/scheme-init.ts",
    styles: "operator:styles",
  },
  plugins: [
    {
      name: "operator-styles",
      setup(context) {
        context.onResolve({ filter: /^operator:styles$/ }, () => ({ path: "styles", namespace: "operator" }));
        context.onLoad({ filter: /.*/, namespace: "operator" }, () => ({
          contents: css,
          loader: "css",
          resolveDir: cssDirectory,
        }));
      },
    },
  ],
  format: "iife",
  jsx: "automatic",
  jsxImportSource: "react",
  define: { "process.env.NODE_ENV": '"production"' },
  legalComments: "eof",
  metafile: true,
  logLevel: "silent",
  minify: true,
  loader: { ".woff2": "file" },
  publicPath: "/ui/assets",
  outdir: "operator-ui-build",
  platform: "browser",
  target: "es2022",
  treeShaking: true,
  write: false,
});
const assets = Object.fromEntries(
  result.outputFiles.map((file) => {
    const name = basename(file.path);
    const binary = name.endsWith(".woff2");
    const type = binary
      ? "font/woff2"
      : name.endsWith(".css")
        ? "text/css; charset=utf-8"
        : "text/javascript; charset=utf-8";
    return [
      `/ui/assets/${name}`,
      { type, body: binary ? Buffer.from(file.contents).toString("base64") : file.text, binary },
    ];
  }),
);
// Carry the notices with the shipped browser bundle, including both Geist OFL notices.
const packages = new Set(
  Object.keys(result.metafile.inputs).flatMap((input) => {
    const match = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(input);
    return match ? [match[1]] : [];
  }),
);
packages.add("@fontsource-variable/geist");
packages.add("@fontsource-variable/geist-mono");
/** Each package's heading beside its verbatim license text. */
const notices = [];
for (const name of [...packages].sort()) {
  const directory = resolve(root, "node_modules", name);
  const license = (await readdir(directory)).find((file) => /^licen[cs]e(?:\.|$)/i.test(file));
  if (license) {
    notices.push({ heading: name, text: await readFile(resolve(directory, license), "utf8") });
  } else {
    const metadata = JSON.parse(await readFile(resolve(directory, "package.json"), "utf8"));
    // Some npm tarballs omit their LICENSE. Preserve their declared attribution
    // and license alongside the MIT grant shipped by this repository.
    if (metadata.license !== "MIT") throw new Error(`Missing license text for ${name}`);
    const mit = (await readFile(resolve(root, "LICENSE"), "utf8")).split("Permission is hereby granted")[1];
    notices.push({
      heading: `${name} ${metadata.version}\nAuthor: ${typeof metadata.author === "string" ? metadata.author : (metadata.author?.name ?? "see upstream")}\nLicense: MIT\nRepository: ${typeof metadata.repository === "string" ? metadata.repository : (metadata.repository?.url ?? "see package metadata")}`,
      text: `Permission is hereby granted${mit}`,
    });
  }
}
// Packages that ship the same license text byte for byte (one vendor's
// monorepo, usually) share one copy, listed under every package's name.
// Nothing is reworded or dropped; most of the file was repeats.
const byText = new Map();
for (const { heading, text } of notices) byText.set(text, [...(byText.get(text) ?? []), heading]);
const noticeBody = [...byText]
  .map(([text, headings]) => `${headings.join("\n")}\n\n${text}`)
  .join("\n\n----------------------------------------\n\n");
const noticeHash = createHash("sha256").update(noticeBody).digest("hex").slice(0, 16);
const noticePath = `/ui/assets/notices-${noticeHash}.txt`;
assets[noticePath] = { type: "text/plain; charset=utf-8", body: noticeBody, binary: false };
const scriptPath = Object.keys(assets).find((path) => /\/script-.*\.js$/.test(path));
const schemePath = Object.keys(assets).find((path) => /\/scheme-.*\.js$/.test(path));
const stylePath = Object.keys(assets).find((path) => /\/styles-.*\.css$/.test(path));
if (!scriptPath || !schemePath || !stylePath) throw new Error("Operator build is missing script, scheme or styles");
const generated = `// Generated by scripts/build-operator-ui.mjs. Untracked; build before importing ./ui.
export const OPERATOR_UI_SCRIPT_PATH: string = ${JSON.stringify(scriptPath)};
export const OPERATOR_UI_SCHEME_PATH: string = ${JSON.stringify(schemePath)};
export const OPERATOR_UI_NOTICES_PATH: string = ${JSON.stringify(noticePath)};
export const OPERATOR_UI_STYLE_PATH: string = ${JSON.stringify(stylePath)};
export const OPERATOR_UI_ASSETS: Readonly<Record<string, { type: string; body: string; binary: boolean }>> = ${JSON.stringify(assets)};
`;
async function minifiedCss(path) {
  const { code } = await transform(await readFile(resolve(root, path), "utf8"), {
    charset: "utf8",
    legalComments: "none",
    loader: "css",
    minify: true,
  });
  if (/<\/style/i.test(code)) throw new Error(`${path} contains a closing style tag`);
  return code.trim();
}
const pageStyles = `// Generated by scripts/build-operator-ui.mjs. Do not edit.
// Source: src/operator-ui/tokens.css and src/operator-ui/page.css.

/** Custom properties and both palettes; styles no element. */
export const TOKENS_CSS: string = ${JSON.stringify(await minifiedCss("src/operator-ui/tokens.css"))};
/** Base typography, the shell, masthead, buttons, badges, and messages. */
export const PAGE_CSS: string = ${JSON.stringify(await minifiedCss("src/operator-ui/page.css"))};
`;
for (const [path, contents] of [
  [generatedPath, generated],
  [pageStylesPath, pageStyles],
]) {
  let current;
  try {
    current = await readFile(path, "utf8");
  } catch {
    /* clean checkout */
  }
  // Bootstrap the ignored manifest on clean checkouts; an existing manifest
  // must match a deterministic rebuild. Shared core styles stay tracked.
  if (checkOnly && (current !== undefined || path !== generatedPath)) {
    if (current !== contents) {
      console.error(`${relative(root, path)} is stale; run npm run build:operator-ui`);
      process.exitCode = 1;
    }
  } else await writeFile(path, contents);
}
