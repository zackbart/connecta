---
status: accepted
date: 2026-11-25
issues: [1506]
supersedes: []
---

# Deployment skill sources

A deployment could publish guidance to agents only as a connector's
`usageGuide`, or by proxying a remote MCP server's skills. Neither lets a team
publish a skill of its own, such as how it reviews a pull request, and a
connector guide is a single `SKILL.md` with no supporting files. Teams already
keep Agent Skills in a Git repository, often the directory an agent plugin
ships.

## Decision

`createConnecta({ skills })` takes skill sources. A source has an id and yields
complete Agent Skills: a directory with `SKILL.md` and any supporting files.
`inlineSkills` takes them from deployment code; `githubSkills`, from its own
package subpath, reads them from a directory of a GitHub repository. The source type stays opaque
until a custom-source contract is worth publishing.

The source is declared in code; its content need not be. Goal 4 already holds
that deployment source defines what a deployment serves, and a source is that
kind of configuration: which skills exist, under which id, for which pools.
A repository source names the repository, path and ref in code, and its
content is read from there, so Git stays the place skills are reviewed and
versioned, with one copy.

Skills are guidance and grant no capability. A skill cannot add a connector, a
tool, a grant or a write; everything it describes still passes the same
classification, pool scope and refusals. That is why pool `skills` takes
source ids only, with no per-skill grants, and why source skills carry no
third-party origin label: the deployment chose to serve them.

The trust boundary moves with the content. Whoever can change a source's
content writes guidance agents read as the deployment's own. For inline skills
that is whoever changes deployment code. For a repository source it is whoever
can push to the configured ref, which can be a wider group than the
deployment's maintainers. Operators choose the ref, and the repository's own
protections, with that in mind.

The always-loaded surface stays configuration only. The `skills` tool's
description names each visible source's id and configured description, never a
skill name, revision or other fetched value, so one configuration serves
identical bytes on every request whatever a source's content does.

## Consequences

Deployments gain a `skills` slot and pool `skills`; a pool that omits it sees
no source, so adding a source exposes nothing to existing pools. Frontmatter
is parsed with a strict YAML subset in core rather than a YAML library, which
keeps the root bundle small and refuses what it cannot read exactly. Evidence
that teams need per-skill grants, or skills from somewhere other than code and
GitHub, would reopen the opaque source type and pool grant shape.
