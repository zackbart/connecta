import { spawnSync } from "node:child_process";

if (process.platform !== "linux") {
  console.error(
    "Operator snapshots must be updated on Linux Chromium. Use the Operator snapshots workflow; see documentation/operator-tests.md.",
  );
  process.exit(1);
}
const result = spawnSync(
  process.execPath,
  ["node_modules/@playwright/test/cli.js", "test", "test/browser/operator-visual.spec.ts", "--update-snapshots"],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);
