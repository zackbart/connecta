// Additional real-workerd routing contracts against unmodified production.
// No source transform, alternate runner or test-only production implementation.
import { defineConfig } from "vitest/config";
import base from "../../vitest.config.ts";

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    projects: base.test.projects.map((project) =>
      project.test.name === "workers"
        ? {
            ...project,
            test: {
              ...project.test,
              include: [
                ...project.test.include,
                "test/downstream-auth-best-practice.test.ts",
                "test/server-route-contracts.test.ts",
                "test/oauth-connect.test.ts",
                "test/oauth-callback-fencing.test.ts",
              ],
            },
          }
        : project,
    ),
  },
});
