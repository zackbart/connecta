---
type: changed
---

Contributors: a maintained provider keeps its eval fake, tasks and deployment wiring in its own unshipped `src/providers/<name>/eval/` folder, and `providers:generate` registers it with the eval harness and appends a `documentation/providers.md` setup skeleton for a provider without one. Granola moved to this layout; adding a provider now needs no shared eval, Vitest or task-list edit. No published API or package content changes.
