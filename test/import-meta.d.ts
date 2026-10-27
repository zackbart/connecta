// Vite transforms these test-only fixture imports; the repository does not
// load vite/client's browser asset declarations into its runtime types.
interface ImportMeta {
  glob<T>(pattern: string, options?: { import?: string; query?: string; eager?: boolean }): Record<string, T>;
}
