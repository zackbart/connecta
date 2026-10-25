// Run existing contract suites against the proof dispatcher without editing src/.
// pnpm exec vitest run --config scripts/probes/effect-router.vitest.config.mjs --project node <files>
import { defineConfig } from "vitest/config";
import base from "../../vitest.config.ts";
import { candidateSource } from "./effect-core-compatibility.mjs";

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    projects: base.test.projects.map((project) => ({
      ...project,
      plugins: [
        ...(project.plugins ?? []),
        {
          name: "effect-router-proof",
          enforce: "pre",
          transform(source, id) {
            if (id.split("?")[0].endsWith("/src/server.ts")) return candidateSource(source);
          },
        },
      ],
    })),
  },
});
