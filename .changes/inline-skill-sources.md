---
type: added
---

A deployment can serve Agent Skills of its own with `createConnecta({ skills: [inlineSkills(id, skills, { description? })] })` (#1506). Each skill is a directory of files in deployment code, `SKILL.md` included, served at `skill://connecta/skills/<source>/<skill>/` with a complete manifest of SHA-256 digests and sizes on native `skills/list`, `skills/get` and byte-exact `resources/read`, and named `<source>:<skill>` (or a bare name exactly one visible source serves) on the `skills` tool and `connecta.skill`. The new `file` argument, `skills({ name, file })` and `connecta.skill(name, { file })`, reads one supporting file a skill lists. Maintainers and an open deployment see every source; a pool sees the sources its new `skills` option lists, and anything outside that view answers as an unknown skill. The `skills` tool's description names each visible source's id and configured description, and nothing a source contains.
