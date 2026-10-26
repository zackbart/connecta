# Frozen Google Discovery evidence

[manifest.json](./manifest.json) records the upstream URLs, revisions, SHA-256,
method counts and capture measurements reviewed for the shared Google step-2
prerequisite. The exact official bytes have one owner:
`src/providers/<name>/evidence/discovery.document.json`, pinned by each product's
`discovery.json`. Original documents never enter runtime imports or the package.

The measurement script and frozen inventory test validate those bytes against
this manifest before normalizing. Keep these historical digests frozen when
moving a provider pin: a mismatch must fail rather than silently change the
measurement baseline. Historical originals remain recoverable from Git history.
The shared compiler derives deterministic OpenAPI in memory, separately from
original evidence and reviewed execution admission.

Measure candidate indexes without installing them in a product:

```sh
pnpm exec tsx scripts/measure-google-index.mjs
```

Pass a prepared base checkout directory to include like-for-like standalone
and all-six bundle measurements. The synthetic index bundle is a measurement,
not shipped product code. `pnpm exec tsx eval/measure-google.ts` characterizes
source imports and cold/warm fake-provider reads on the current Node runtime;
it makes no model calls or real Google requests and changes no deadlines.
