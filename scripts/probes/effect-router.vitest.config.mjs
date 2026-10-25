// Run existing contract suites against the proof dispatcher without editing src/.
// pnpm exec vitest run --config scripts/probes/effect-router.vitest.config.mjs --project node <files>
import { defineConfig } from "vitest/config";
import base from "../../vitest.config.ts";
import { vitestCandidate } from "./effect-router-transform.mjs";

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    projects: base.test.projects.map((project) => ({
      ...project,
      test: {
        ...project.test,
        setupFiles: [...project.test.setupFiles, "./test/fixtures/effect-proof/require-transform.ts"],
        ...(project.test.name === "workers"
          ? { include: [...project.test.include, "test/downstream-auth-best-practice.test.ts"] }
          : {}),
      },
      plugins: [
        ...(project.plugins ?? []),
        // Deliberate filter-miss mutation must fail in require-transform setup.
        vitestCandidate({ miss: process.env.CONNECTA_PROOF_MUTATION === "miss-server" }),
      ],
    })),
  },
});
