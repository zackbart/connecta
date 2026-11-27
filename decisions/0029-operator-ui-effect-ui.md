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
that reaches the transport, and it checks the browser's observed identity and
admission again in the call that invokes `fetch`. `OperatorController` owns the
fenced state and runs its reads on fibers of its own, so a read outlives the
page or Command that asked. Connection writes go to the content root through a
queue and run as its Commands, so they survive navigation; token actions are
forked detached by the Tokens page. Pages are components over projections of
that state. The token rules are now properties of service boundaries:
`test/operator-store.test.ts` drives the real controller and `OperatorApi`
through the production Layer over a fake browser and `fetch`, while Story and
Scene tests check the components over fixtures and fake controllers.

The move was a strangler migration in eight PRs. Unchanged React pages ran as
islands inside the Effect UI shell until each was ported, and the Playwright
suites passed at every step. The only visual change was the Overview's two
baselines, updated in #1514 because text React had split across several text
nodes became one node, shifting kerning by a fraction of a pixel.

The alternatives were to keep React and port only the store to Effect
services, or to keep everything. Keeping React left two architectures and two
state models with a bridge between them, and four UI dependencies to track.
Effect UI was the riskier choice: it is experimental, pre-1.0 and not yet on
npm.

## Consequences

Operators see no change in behavior. Effect UI is a devDependency bundled into the hashed
`/ui/assets` script, so a deployment never installs it, and the bundle resolves
the same Effect copy as core. The bundle is larger: the hashed operator assets
grew from under 283 KB to about 404 KB gzip, and the `./ui` entry from about
351 KB to about 480 KB. Removing React, ReactDOM, Radix and cmdk in the last
steps took back about 80 KB of the peak, when both libraries shipped.

Effect UI is pinned to a pkg.pr.new commit snapshot, the same SHA for both
packages, and each bump is a deliberate PR checked against the exact Effect pin.
Effect upgrades now also wait on Effect UI's peer range. An Effect UI API change
can force a rework of components, which the pin keeps deliberate. Reconsider if
Effect UI stops tracking Effect releases or is abandoned before it publishes.
No secret may enter Effect UI state; uncontrolled inputs and opaque handles keep
bearer tokens, credential candidates and issued agent tokens in the controller.
