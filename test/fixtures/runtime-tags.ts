// Vitest applies the tag definitions from each runtime project. Node runs
// both tags; workerd skips broad logic tagged NODE in mixed boundary suites.
export const NODE = { tags: "node" } as const;
export const WORKERS = { tags: "workers" } as const;
