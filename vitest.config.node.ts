import { defineConfig } from "vitest/config";
import config from "./vitest.config.js";

// Run every Node suite through the same project without a CLI project filter.
const node = config.test?.projects?.[0];
if (typeof node !== "object" || !("test" in node) || node.test?.name !== "node") {
  throw new Error("The first Vitest project must be the complete Node project");
}
export default defineConfig({ ...config, test: { ...config.test, projects: [node] } });
