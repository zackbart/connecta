// Rewrite the characterization goldens under test/goldens/ from current
// behavior. Never part of `check`, which only compares. Name providers to
// rewrite only theirs: `pnpm run goldens:update tithely breeze`.
import { spawnSync } from "node:child_process";

const only = process.argv.slice(2).filter((arg) => arg !== "--");
const result = spawnSync(
  process.execPath,
  ["node_modules/vitest/vitest.mjs", "run", "--project", "node", "test/goldens.test.ts"],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      CONNECTA_GOLDENS_UPDATE: "1",
      ...(only.length ? { CONNECTA_GOLDENS_ONLY: only.join(",") } : {}),
    },
  },
);
process.exit(result.status ?? 1);
