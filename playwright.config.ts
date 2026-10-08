import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "test/browser",
  fullyParallel: false,
  snapshotPathTemplate: "{testDir}/{testFilePath}-snapshots/{arg}{ext}",
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: "line",
  use: {
    ...devices["Desktop Chrome"],
  },
});
