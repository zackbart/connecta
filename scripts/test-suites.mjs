// Both Vitest projects and the repository guard use this collection boundary.
export const TEST_DIRECTORY = "test";
export const TEST_INCLUDE = [`${TEST_DIRECTORY}/**/*.test.ts`, "src/providers/**/*.test.ts"];
export const NODE_ONLY_EXCLUDE = ["**/*.node.test.ts"];
