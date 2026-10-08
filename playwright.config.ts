import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "test/browser",
  fullyParallel: false,
  workers: process.env.CI ? 2 : undefined,
  expect: { toHaveScreenshot: { animations: "disabled", caret: "hide", scale: "css" } },
  snapshotPathTemplate: "{testDir}/{testFilePath}-snapshots/{arg}-{platform}{ext}",
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: "line",
  use: {
    ...devices["Desktop Chrome"],
    viewport: { width: 1280, height: 900 },
    locale: "en-US",
    timezoneId: "UTC",
    reducedMotion: "reduce",
  },
});
