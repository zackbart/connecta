---
type: changed
---

Develop the repository with pnpm instead of npm: `pnpm-lock.yaml` replaces `package-lock.json`, `pnpm-workspace.yaml` allows only the esbuild and workerd build scripts, CI installs with `pnpm install --frozen-lockfile`, and `check:security` runs `pnpm audit`. The published package, its install instructions, and the Node template still use npm, and releases still publish through `npm publish` with trusted publishing.
