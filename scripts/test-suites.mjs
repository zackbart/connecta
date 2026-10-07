// Both Vitest projects and the repository guard use this collection boundary.
export const TEST_DIRECTORY = "test";
export const TEST_INCLUDE = [`${TEST_DIRECTORY}/**/*.test.ts`];
export const NODE_ONLY_EXCLUDE = [`${TEST_DIRECTORY}/**/*.node.test.ts`];
