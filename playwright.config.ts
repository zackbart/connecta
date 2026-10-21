import { defineConfig, devices } from "@playwright/test";

const visual = "operator-visual.spec.ts";

export default defineConfig({
  testDir: "test/browser",
  fullyParallel: false,
  workers: process.env.CI ? 2 : undefined,
  expect: { toHaveScreenshot: { animations: "disabled", caret: "hide", scale: "css" } },
  snapshotPathTemplate: "{testDir}/{testFilePath}-snapshots/{arg}-{platform}{ext}",
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  // CI keeps an HTML report; the browser job uploads it with test-results/.
  reporter: process.env.CI ? [["line"], ["html", { open: "never" }]] : "line",
  use: {
    ...devices["Desktop Chrome"],
    viewport: { width: 1280, height: 900 },
    locale: "en-US",
    timezoneId: "UTC",
    reducedMotion: "reduce",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "behavior", testIgnore: visual },
    // A pixel comparison is deterministic: a retry repeats the same mismatch.
    // With no retry to trace, keep the failed attempt's trace.
    { name: "visual", testMatch: visual, retries: 0, use: { trace: "retain-on-failure" } },
  ],
});
