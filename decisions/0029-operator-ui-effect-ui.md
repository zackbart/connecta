---
status: accepted
date: 2026-11-27
issues: [1510]
supersedes: []
---

# The operator UI on Effect UI

The operator UI was React 19 with TanStack Router, Radix Dialog and Tabs, and
cmdk, over a hand-written store of about 2,200 lines that owned every request,
identity check and notice. None of it used Effect, while the core is Effect
inside. The store's two rules, that every request carries the current session's
token and that a response from a superseded identity is dropped, were
conventions inside one file, and every page reached them through it.

## Decision

The browser app moved to [Effect UI](https://github.com/Effect-TS/ui), Effect's
frontend library. Each component is an Elm Architecture program: a Schema
Model, messages, a pure `update` and a `view`, with side effects as Commands
and Subscriptions and services provided by Layers. `@effect/ui-kit` supplies
the accessible Dialog, Tabs and Autocomplete.

The store became Effect services in one Layer. `OperatorApi` is the only code
that reaches the transport and checks identity and admission again in the call
that invokes `fetch`. `OperatorController` owns the fenced state and runs reads
and writes on its own fibers, so they outlive the page that asked. Pages are
components over memoised projections of that state, and connection writes go
to the content root through a queue. The token rules are now properties of
service boundaries, which Story and Scene tests drive through the real Layer.

The move was a strangler migration in eight PRs. Unchanged React pages ran as
islands inside the Effect UI shell until each was ported, and the Playwright
suites, visual snapshots included, passed unchanged at every step.

The alternatives were to keep React and port only the store to Effect
services, or to keep everything. Keeping React left two architectures and two
state models with a bridge between them, and four UI dependencies to track.
Effect UI was the riskier choice: it is experimental, pre-1.0 and not yet on
npm.

## Consequences

Deployments see no change. Effect UI is a devDependency bundled into the hashed
`/ui/assets` script, so a deployment never installs it, and the bundle resolves
the same Effect copy as core. The operator assets shrank by about 80 KB gzip
once React, ReactDOM, Radix and cmdk left.

Effect UI is pinned to a pkg.pr.new commit snapshot, the same SHA for both
packages, and each bump is a deliberate PR checked against the exact Effect pin.
Effect upgrades now also wait on Effect UI's peer range. An Effect UI API change
can force a rework of components, which the pin keeps deliberate. Reconsider if
Effect UI stops tracking Effect releases or is abandoned before it publishes.
No secret may enter Effect UI state; uncontrolled inputs and opaque handles keep
bearer tokens, credential candidates and issued agent tokens in the controller.
