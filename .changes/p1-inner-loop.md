---
type: changed
---

Contributors get `npm run check:fast`, a partial inner loop that runs the
static checks concurrently with Vitest suites related to the branch's changes
and the always-on package guards; `npm run check` remains the gate. Pull
requests audit dependencies only when the root `package.json` or lockfile
changes; a nightly workflow and publishing still run `npm audit`. The Chromium
install retry waits for a leftover apt process instead of failing on its lock,
and repository skills for providers, spec features, releases, and CI triage
live in `.claude/skills/` (#705).
