---
type: added
---

**`Connector.classification`: connectors report facts, the registry
classifies** ([#705](https://github.com/zackbart/connecta/issues/705)). A
connector may carry a reviewed `ToolClassification` as the readonly
`classification` field. `remoteMcp({ classify })` and maintained providers set
it to a deep-frozen copy, and their `listTools` now returns the downstream's
listing unclassified. The registry validates the field when it first reads a
connector, rejects it beside `staticTools`, caches and persists only what
`listTools` returned, and classifies those facts on every read into fresh
objects. It also observes catalog drift for such connectors itself, and
ignores their `catalogDrift()`. A decorator that filters, copies, or annotates a
listing, or mutates tools it listed or was handed, cannot turn a reviewed write
into a read. Wrappers keep the review only by forwarding the field:
`{ ...connector }`, `Object.assign`, and `Object.create` do; a forwarding class
that omits it serves an unreviewed connector, whose downstream annotations fail
closed when absent. Phase 2's deployment-level overrides
([#706](https://github.com/zackbart/connecta/issues/706)) will apply
regardless of wrapping.

Request-scoped catalogs own their definitions and serve deep copies to
discovery and invocation. Each connector dispatch also receives a fresh deep
copy of its definition. Mutating a dispatched definition or a discovery
result cannot change later discovery, schema validation, or write accounting
within the same program.
