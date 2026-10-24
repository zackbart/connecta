---
{
  "name": "vercel",
  "instructionsHeading": "Account instructions"
}
---

## Projects, deployments and domains

Resolve a team by slug, a project by name, and deployments by the observed
project id. Team ids start with `team_`, project ids with `prj_`, and deployment
ids with `dpl_`. A deployment hostname and a deployment id identify the same
deployment; an alias can later point to a different deployment.

Some project paths accept a project name, but a deployment list's projectId
filter requires the observed `prj_` id. Resolve the name before listing its
deployments; an empty result for a guessed name does not prove absence.
Complete each identifier lookup before starting the reads that depend on it.

The configured team is a routing default, not a restriction. Explicit teamId
or slug selects another team the token can reach; teamId: null selects personal
scope. Vercel token permissions determine access. Prefer an explicit team when
joining resources across several calls.

Read deployment state before its build events. Runtime logs diagnose requests
after a deployment built; build logs explain a failed build. Narrow time windows
before raising collection limits. Generic reads refuse live follow streams;
use the bounded build/runtime readers. Deployment timestamps are milliseconds.

Project domains and deployment aliases are different joins: a project domain
belongs to the project, while an alias identifies its assigned deployment.
Read a pending domain's verification instructions before changing DNS.

## Environment changes

Resolve environment-variable ids using metadata, including target, branch and
custom environment. A key can have distinct production and preview values.
Existing values cannot be retrieved. Supply new values only when the task asks
for a change; confirm the returned id and metadata.

Environment changes apply to future deployments. A new deployment is a separate
write. Promoting an existing deployment does not rebuild it or update embedded
environment values. After an uncertain update, reconcile observable metadata
such as id, targets and comment; reading metadata cannot verify a secret value.

## Explicit files and credentials

Deployment files can reference previously uploaded digests. File uploads accept
explicit bytes and never read a path on the agent's machine. Decrypted-value,
credential-minting, protection-bypass-link, signing and domain move-out operations
are refused; use Vercel's dashboard for those workflows.
