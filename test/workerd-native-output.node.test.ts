// Node-only: runs the sink suite in workerd through a child Vitest and reads workerd's native stdout and stderr.
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

// workerd writes some diagnostics natively, below every console and logger a
// test inside the Worker can spy on: calling `.text()` on a body whose
// Content-Type is not text prints that Content-Type, so a downstream could
// write into the deployment's log (#695). This runs the sink suite in workerd
// and reads what workerd itself printed.
describe("workerd's native output", () => {
  it("INV-6: carries no planted downstream text while the sink and Clerk auth suites run in workerd", async () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const vitest = fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url));
    // CI forces colour; plain output keeps the summary match literal.
    const env: NodeJS.ProcessEnv = { ...process.env, CI: "1", NO_COLOR: "1" };
    delete env.FORCE_COLOR;
    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      [
        vitest,
        "run",
        "--project",
        "workers",
        "test/operator-sinks.test.ts",
        "test/clerk-operator-output.test.ts",
        "test/byte-read-response.test.ts",
      ],
      { cwd: root, timeout: 120_000, maxBuffer: 16 * 1024 * 1024, env },
    );
    const output = `${stdout}\n${stderr}`;
    expect(output).toMatch(/Tests\s+\d+ passed/);
    expect(output).not.toMatch(/planted-[a-z0-9-]+-7f3a9c/);
    expect(output).not.toContain("does not appear to be text");
  }, 150_000);
});
