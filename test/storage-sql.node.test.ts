// Node-only: reads storage source files to guard SQL parameter compatibility across Node versions.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

it("storage SQL uses only unnumbered positional parameters on both drivers", () => {
  const files = [
    ...sourceFiles(join(SRC, "storage")),
    ...sourceFiles(SRC).filter((file) =>
      /^(?:sqlite\.ts|d1\.ts|activity[^/\\]*(?:[/\\]|$))/.test(relative(SRC, file))),
  ];
  // Scan all source text so SQL fragments and interpolated statements are covered too.
  const offenders = files.flatMap((file) => readFileSync(file, "utf8").split("\n")
    .flatMap((line, index) => /\?\d/.test(line)
      ? [`${relative(SRC, file)}:${index + 1} ${line.trim()}`]
      : []));
  expect(offenders).toEqual([]);
});
