import { SCHEME_KEY } from "./scheme.js";

/**
 * The operator HTML loads this blocking, before its stylesheet, so a saved
 * scheme holds from the first paint on every page: the sign-in gate, the
 * member page and the maintainer pages. A deployment's pin, already on the
 * element from the server, wins. The Appearance control writes the key and
 * moves the attribute live after this.
 */
try {
  const root = document.documentElement;
  const saved = localStorage.getItem(SCHEME_KEY);
  if (!root.dataset.scheme && (saved === "light" || saved === "dark")) root.dataset.scheme = saved;
} catch {
  /* private browsing */
}
