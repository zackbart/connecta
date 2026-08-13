# Upgrading an existing deployment

For the agent working *inside* a generated deployment rather than inside this
repository. You did not create this project, you cannot re-run `connecta init`
over it, and the thing you are holding is two files' worth of the owner's
intent wrapped in eight files of template that has moved on without it.

The shape of the job is fixed by two facts. A deployment is
[config-as-code](../ethos.md): `src/index.ts` is the product, everything around
it is scaffolding. And `connecta init` **refuses to merge into an existing
path** — deliberately, because an initializer that overwrites is an initializer
that eventually overwrites a connector set. So an upgrade is not a re-init. It
is: read what you have, bump the pin, reconcile the scaffolding against the
current template with the deployment's own generation as the base, migrate what
the release notes broke, and prove it with `connecta doctor`.

Work on a branch. Every step below is reversible until you delete the old
lockfile, and you want the diff reviewable by whoever owns this deployment.

## Read what you have first

Three questions, in order. Answer all three before editing anything — the
second and third are what stop you from "restoring" a file the owner changed on
purpose.

### 1. What version is it pinned to

```sh
node -p "require('./package.json').dependencies['@zackbart/connecta']"
```

`init` writes that pin as an **exact** version, never a range, because the
generated deployment and the package are separate release units
([operations](./operations.md#deployment-as-a-release-unit)). So the pin is
also a fact about history: it is the version of the CLI that generated this
project, unless someone has bumped it since — which `package-lock.json` will
tell you.

```sh
node -p "require('./package-lock.json').packages['node_modules/@zackbart/connecta'].version"
```

Pin and lockfile agreeing means nobody has touched the dependency by hand. They
disagreeing is the first thing to reconcile, and the lockfile is usually the
truth about what has actually been running.

A deployment with no `@zackbart/connecta` entry at all, or one carrying a range
(`^0.14.0`), was not produced by `connecta init` — treat it as the pre-template
case below.

### 2. Which template generation it came from

The pin answers this, and the file layout corroborates it. Two generations
exist so far:

| Generation | Versions | Layout |
| --- | --- | --- |
| **pre-template** | before 0.10.2 | no `connecta init` existed; hand-written, or copied from the retired `examples/node` |
| **A** | 0.10.2 – 0.15.1 | `.env.example`, `.gitignore`, `AGENTS.md`, `CLAUDE.md`, `README.md`, `package.json`, `src/index.ts`, `tsconfig.json` |
| **B** | 0.16.0 | adds `.dockerignore`, `Dockerfile`, `docker-compose.yml`, and `src/file-activity.ts`; `src/index.ts` grows the four commented operator blocks; `.env.example` ships `CONNECTA_TOKEN=` empty |

Generation A is a decade in template years and identifying it precisely does
not matter, because you are about to reconstruct it exactly rather than guess
at it. What matters is the boundary: a project with no `Dockerfile` is a
generation A project, and the whole container story is a change it has never
seen.

### 3. What this deployment changed

Regenerate the deployment's *own* starting point and diff against it. `init`
pins from the CLI package's version, so an old CLI reproduces its own
generation byte for byte:

```sh
SCRATCH=$(mktemp -d)                                        # keep this shell
(cd "$SCRATCH" && npx @zackbart/connecta@0.15.1 init base)  # ← the pin from step 1
```

`$SCRATCH` is the one scratch path for the whole upgrade — the reconcile step
below generates the current template into it too, and every later command
resolves against it. Run the rest from the deployment root:

```sh
diff -ru "$SCRATCH/base" . --exclude node_modules --exclude package-lock.json
```

Everything that differs is deployment-owned and survives this upgrade
unconditionally. Everything identical is scaffolding you may replace without
asking. Expect the interesting half to be:

- **`src/index.ts`** — the connector set, `auth`, `storage`, `publicUrl`, and
  whichever operator blocks were uncommented. This file is never overwritten,
  only edited.
- **`package.json`** — extra dependencies (`@clerk/backend` if operator
  sign-in is on, provider SDKs the owner added, anything a handler imports)
  and extra scripts.
- **`.env.example` / deployment docs** — variables the owner's connectors read.
- Whole files that are not in any generation: extra `src/*.ts` modules behind
  `api()` handlers, CI workflows, infrastructure.

Write the list down before you touch anything. You will use it twice: once to
know what to preserve, once to know what to re-verify at the end.

## The upgrade

### Bump the pin and install

```sh
npm pkg set dependencies.@zackbart/connecta=0.16.0
npm install
```

Exact, not a range. The reason `init` pins exactly applies just as much on the
way up: a deployment whose connector safety classifications can move under it
during an unrelated `npm install` is not reviewable.

`quickjs-emscripten` is a direct dependency of the generated project and an
optional peer of the package (`^0.32.0`), so npm will tell you if the pin the
template ships has fallen out of range. Match the template's pin rather than
inventing one. If operator sign-in is enabled, `@clerk/backend` (`^3.12.0`) is
the other optional peer — also a direct dependency of the deployment, because
optional peers never install with core.

Do not run the build yet. Reconcile first, so a single typecheck answers for
both the new package and the new scaffolding.

### Reconcile the scaffolding

Generate the *current* template beside the base you already made, into the same
`$SCRATCH`:

```sh
(cd "$SCRATCH" && npx @zackbart/connecta@0.16.0 init current)
```

You now have a three-way merge with a real base: `$SCRATCH/base` is what this
deployment started as, `$SCRATCH/current` is what `init` produces today, and the
deployment is the third leg. For every file:

| base vs current | deployment vs base | Do |
| --- | --- | --- |
| unchanged | unchanged | nothing |
| unchanged | changed | keep the deployment's version |
| changed | unchanged | take `$SCRATCH/current`'s version |
| changed | changed | merge by hand — this is the only file class that needs judgment |

`diff3` or `git merge-file` will do the mechanical part. From the deployment
root, with the deployment's file first, the base second, and the current
template third:

```sh
git merge-file -p src/index.ts "$SCRATCH/base/src/index.ts" \
  "$SCRATCH/current/src/index.ts" > "$SCRATCH/merged-index.ts"
```

New files in `$SCRATCH/current` that exist in neither base nor deployment are
pure additions — copy them in. For generation A that is the entire container story
(`Dockerfile`, `docker-compose.yml`, `.dockerignore`) plus
`src/file-activity.ts`.

Two things are worth knowing before you accept the merge:

- **`.env.example` is not decoration.** The 0.16.0 template ships
  `CONNECTA_TOKEN=` **empty** on purpose: both Compose and `src/index.ts`
  refuse to start until an operator sets it, where the old `replace-me` value
  started a healthy, port-published deployment whose bearer token was a string
  published in a public repository. Take the empty value. Adding the
  deployment's own variables underneath is the merge; restoring a placeholder
  bearer is not.
- **`src/index.ts` is a merge, not a takeover.** What you are adopting from
  `$SCRATCH/current` is the environment reading (`PUBLIC_URL`, `CONNECTA_STATE_FILE`,
  treating empty as unset — that is what lets one source serve both `npm start`
  and the container) and the commented operator blocks. What you are keeping is
  every connector, every credential slot, every handler, and every operator
  block this deployment had already uncommented. If a block is live here and
  commented in the current template, live wins.

`AGENTS.md` (and the `CLAUDE.md` symlink beside it) is the deployment's
instruction file for the next agent. Take the current one, then re-append
whatever the owner added — it is usually the only "template" file with real
local content in it.

### The pre-template case

A deployment older than 0.10.2 has no base to diff against. Do not try to
manufacture one. Instead:

1. `SCRATCH=$(mktemp -d)`, then
   `(cd "$SCRATCH" && npx @zackbart/connecta@0.16.0 init current)` — there is no
   `base` leg here, only the current template to read from.
2. Copy `$SCRATCH/current` into the deployment file by file, **skipping
   `src/index.ts`**.
3. Port the deployment's existing configuration into the new `src/index.ts` by
   hand, one connector at a time, reading each version boundary below as you
   go.

It is more work and it is honest work: a project of that vintage predates the
executor requirement, the seven-tool surface, and the `api()` construction
contract, so it needs a read anyway.

## Version boundaries

Only what breaks an existing deployment is listed. Everything else in
[`CHANGELOG.md`](../CHANGELOG.md) is additive, and a boundary absent from this
list is a boundary you can cross with a version bump. The sections run newest
first, so cross them bottom-up: start at the oldest one still above this
deployment's pin and work back up the page, because each boundary assumes the
older ones are already done.

### 0.15.x → 0.16.0

The largest one, and it fails loudly. Every item here throws at construction or
fails a specific call; none of it degrades quietly.

**`api()` enforces its construction contract.** Every hand-written tool now
needs three things, checked when the connector is built:

- a non-empty `description` — it is what an agent reads to choose the tool;
- an explicit boolean `annotations.readOnlyHint` — `true` for a read, `false`
  for work that must cross `call_destructive_tool`;
- an `inputSchema`, if it ships one, that the validator can actually compile.

The throw names the failing address (`connectorId.toolName`), so this is a
mechanical walk through `src/index.ts`. The one judgment call is the
classification, and the safe answer is written down for you: **a tool that used
to ship unannotated becomes `readOnlyHint: false`**, because unannotated
already routed through `call_destructive_tool`. That is the routing it had.
Writing `true` onto a tool you have not read is not an upgrade, it is a
capability change.

Connecta infers the classification from nothing — not a name, not a verb, not
an HTTP method, not the other annotations. There is no flag that restores the
old forgiving behavior.

**`ApiOptions.strictValidation` is gone.** Delete it. Fail-closed schema
handling is the only behavior left, so the option had nothing to switch. A
schema that only reveals itself as unenforceable on first use — an unresolvable
`$ref`, say — now fails that call as non-retryable `invalid_args` instead of
forwarding raw arguments to the handler. `validateArgs: false` still exists and
still means what it said: opting out of enforcement, not out of the schema
being real.

**`linear()` requires `access`.** Construction throws naming both options.
`access: "read-write"` preserves an existing deployment's behavior exactly;
`"read-only"` binds the connector to Linear's read-only endpoint, whose token
cannot reach the write APIs at all. There is no default because neither guess
is safe — one hands out writes nobody asked for, the other breaks a writing
deployment at Linear, at runtime, where no agent can repair it
([linear](./linear.md)).

**`mixpanel()` declares no call-admission budget.** The old hardcoded 600
calls/hour transcribed a limit Mixpanel meters *per user*, which a per-runtime
counter cannot approximate in either direction. Nothing throws — the ceiling is
simply absent. If this deployment was relying on it, pass `callAdmission`
explicitly ([call admission](./call-admission.md)). The default title also now
carries the region (`Mixpanel (us)`), and an unknown `region` throws.

**Three Cloudflare tools are gone; the connection ships 52.** `set_r2_cors`,
`delete_r2_cors`, and `get_r2_metrics`. Grep the deployment — and any prompt,
skill, or runbook around it — for those names. No capability is lost:
`get_r2_cors` still reads a bucket's policy, CORS writes go through
`cloudflare_api_mutate` at
`PUT`/`DELETE /accounts/{accountId}/r2/buckets/{bucketName}/cors`, and metrics
through `cloudflare_api_get` at `/accounts/{accountId}/r2/metrics`
([cloudflare](./cloudflare.md)).

**`cloudflare()` checks an overridden `baseUrl` at construction.** A
non-loopback plain-http origin, URL-embedded credentials, or a query or
fragment now throws where the option is written rather than on the first call.
A deployment pointing Cloudflare at an http proxy must move it to https or bind
it to loopback. The default base is unaffected, so a deployment that never set
`baseUrl` reads nothing here.

**Cloudflare and Notion refuse redirects and bound their reads.** Both now send
`redirect: "manual"`; a 3xx fails as non-retryable `connector_call_failed`
rather than re-sending the connector's credential to whatever origin `Location`
names. Both also cap the response they will read — 8 MiB for Cloudflare, 4 MiB
for Notion — checked against a declared `Content-Length` and again while the
body streams. Visible only to a deployment that was pulling something enormous
through a tool call, such as a `cloudflare_api_get` on a large R2 object. These
are ceilings on absurdity; anything near them was already past whatever
`maxResultBytes` the deployment set.

**The shipped defaults fail closed.** Covered under `.env.example` above, and
repeated here because it is the item most likely to be "fixed" backwards: an
empty `CONNECTA_TOKEN` that refuses to boot is the intended state of a fresh
`.env.example`, not a regression.

### 0.13.x → 0.14.x

No API breaks. One behavior change worth knowing: vetted annotations on a
prebuilt connection no longer argue with an explicit downstream annotation in
either direction, so a name the downstream explicitly marks `readOnlyHint:
true` that no release has classified is now callable from `execute_code`
instead of failing closed onto the approval path. Silence on an unclassified
name still means not read-only. The one branch that still outranks the
downstream is a name a release reviewed and filed destructive.

### 0.12.x → 0.13.0

No API breaks; text changed under existing deployments. Served tool
descriptions and the MCP `instructions` string were rewritten, and `skills({})`
now summarizes a connector guide from its first body line rather than its
heading — a guide opening `# Acme` that listed as "Acme" now lists as the
sentence beneath it. If this deployment's connectors carry usage guides, read
their first lines ([connector guides](./connector-guides.md)).

### 0.10.x → 0.11.0

The executor boundary. **Every deployment must configure an executor** and
serves exactly seven tools; construction refuses to boot without one. On Node
that is `quickJsExecutor()` from `@zackbart/connecta/quickjs`; on Workers,
`new DynamicWorkerExecutor({ loader: env.LOADER })` from
`@cloudflare/codemode` plus its paid-plan Worker Loader binding.

The top-level `list_connectors`, `describe_tools`, and `batch_call`
registrations are gone. Their equivalents live inside `execute_code` as
`connecta.search`, `connecta.describe`, and `connecta.batch`
([code mode](./code-mode.md)). Anything outside the deployment that called
those three by name — a client config, a prompt, a script — is what actually
breaks here; the deployment file itself only has to gain the executor and drop
`surface`.

### 0.6.x → 0.7.0

Only a pre-template deployment is still down here; every generation A project
was born above this line. Three breaks, and the config one is in the table
below.

**A connector implementing `finishAuth` without `verifyState` can no longer
complete OAuth** (#62). The callback refuses with the same opaque 400 as every
other refusal, exchanges no code, and logs one operator-grade line naming the
connector and the missing hook. `verifyState` is optional in the type system and
required in practice wherever `finishAuth` is present, so nothing throws at
construction — the flow simply stops completing, which is the one item in this
guide you find by reading rather than by building. It reaches hand-written
connectors only: the shipped `remoteMcp` OAuth provider has always implemented
it. The old behavior was exchanging an authorization code with no CSRF guard at
all, so this is not a hook to stub out with `() => true`.

**`/`, `/credentials`, and `/activity` are core-owned routes** (#57). They
previously fell through to connector `handleRequest` and then to a 404, so a
connector that served any of the three is now shadowed without warning. `GET /`
returns the operator shell where 0.6.1 returned 404, and a non-GET on those
routes or on `/ui` returns 405 instead of falling through. Move such a handler
to a path the core does not own: `handleRequest` still runs for everything the
built-in routes miss, so it can add a route and never shadow one
([architecture](./architecture.md)).

### Removed options that throw

These fail at construction with their migration named rather than falling back
to a default, because silently ignoring a removed option is how a deployment
ends up running a policy its config file says it has:

| Option | Removed in | Do |
| --- | --- | --- |
| `toolkits`, `unscoped` | 0.8.1 (#178) | delete; deploy one instance per audience |
| `credentials.health`, `credentialHealth` | 0.8.1 (#179) | delete; credentials fail at use |
| `surface` | 0.11.0 (#273) | delete; there is one seven-tool surface |
| `calls.maxBatchResultBytes` | 0.11.0 (#273) | delete; program batching is bounded by `execute_code`'s own limits |
| flat v0.6 config paths | 0.7.0 | move into their groups — one complete migration error lists them ([operations](./operations.md#configuration)) |

## Verify

In order, and do not skip the last one — the first three prove the package
works, not that this deployment does.

```sh
npm run typecheck                      # ships with the template
CONNECTA_TOKEN=dev-token npm start     # in one shell
CONNECTA_TOKEN=dev-token npm run doctor    # in another
```

`connecta doctor` is the gate. It asserts `/health` reports ok, that
`tools/list` is exactly the seven prescribed names — `authorize_connector`,
`call_destructive_tool`, `call_tool`, `execute_code`, `get_result`,
`search_tools`, `skills` — and that `execute_code` actually runs a program in
the sandbox. It names the executor the deployment reports rather than assuming
one: `QuickJS executed` on the Node template, `DynamicWorkerExecutor executed`
on a Worker. It also *reports* catalog drift without failing on it; drifted
counts here are a maintainer's next task, not a failed upgrade.

Then exercise this deployment's own connectors, which doctor knows nothing
about — it holds a bearer, and a client key does not get to learn a
deployment's configuration topology. One program covers discovery and a call:

```js
// execute_code — an empty query browses the catalog
async () => {
  const page = await connecta.search({ query: "", limit: 100 });
  return {
    total: page.total,
    connectors: [...new Set(page.tools.map((t) => t.address.split(".")[0]))],
  };
};
```

Walk the list from the inventory you wrote down: every connector the owner
configured should appear, every credential slot should still be listed at
`/credentials`, and at least one real read per connector should return data.
A connector whose catalog is empty after an upgrade is usually a credential
that did not survive a state-file path change, not a broken release.

If the container half is now in play, `cp .env.example .env`, set
`CONNECTA_TOKEN`, and `docker compose up -d --build`, then point doctor at it.
Commit the `package-lock.json` that `npm install` wrote on the host — that is
what puts the image build on the reproducible `npm ci` path instead of
resolving the pin again inside a layer.

## What not to do

Five refusals. Each one is somebody's plausible shortcut, and each one produces
a deployment that is quieter and wrong.

- **Do not re-init over the top.** `connecta init` refuses to merge into an
  existing path and that refusal is load-bearing. Working around it — into a
  scratch directory and then `cp -r` over the deployment, or by deleting the
  project and regenerating — is how a connector set becomes a `time` connector.
  Scratch directories are for reading and diffing, never for copying wholesale.
- **Do not weaken a fail-closed default to get green.** `readOnlyHint: true` on
  a tool you have not read, a restored `CONNECTA_TOKEN=replace-me`,
  `validateArgs: false` to silence a schema that will not compile, an
  annotation "corrected" to match what the downstream claims: all of these turn
  a construction error into a running deployment with a wider blast radius than
  it had yesterday. The construction throw is the feature. Fix the input.
- **Do not pin back.** A deployment that boots on 0.15.1 and throws on 0.16.0
  is a deployment telling you which line to fix, with the address in the error
  message. Reverting the pin keeps the same defect and buries the report.
- **Do not copy Connecta internals into the deployment.** If something the
  deployment needs is not exported, that is a package issue to file, not a file
  to vendor. A deployment that carries a copy of a provider cannot be upgraded
  by anyone, including you, next time.
- **Do not add a second project shape.** No alternate entrypoint, no second
  container recipe, no parallel configuration path beside `src/index.ts`. There
  are exactly two deployment shapes — [`templates/node/`](../templates/node/)
  and the Worker example — and a third that is a diff away from one of them is
  a shape this repository has already deleted once.

When something here disagrees with [`ethos.md`](../ethos.md), the ethos wins
and this guide is what needs fixing.
