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
    { name: "visual", testMatch: visual, grepInvert: /@unstable/, retries: 0, use: { trace: "retain-on-failure" } },
    // Comparisons that flaked on CI with no cause found keep the retry budget
    // and trace their first attempt, so the uploaded report shows the failure.
    { name: "visual-unstable", testMatch: visual, grep: /@unstable/, use: { trace: "retain-on-failure" } },
  ],
});
