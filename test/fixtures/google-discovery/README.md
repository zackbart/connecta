# Frozen Google Discovery evidence

These are the exact official bytes reviewed for the shared Google step-2
prerequisite. [manifest.json](./manifest.json) records each upstream URL,
revision, SHA-256, method count and capture measurements. The revision string
alone does not pin content. Tests check the archived byte digest before
normalizing; the original documents never enter runtime imports or the package.

Product migrations copy the appropriate bytes into their own supplemental
`evidence/discovery.document.json` and pin them in `discovery.json`. The shared
compiler does not change any product's agent surface or execution allowlist.
`normalizeDiscovery` retains complete inventory and source mappings; its
deterministic conversion is separate from original evidence and from admission.

Measure candidate indexes without installing them in a product:

```sh
pnpm exec tsx scripts/measure-google-index.mjs
```

Pass a prepared base checkout directory to include like-for-like standalone
and all-six bundle measurements. The synthetic index bundle is a measurement,
not shipped product code. `pnpm exec tsx eval/measure-google.ts` characterizes
source imports and cold/warm fake-provider reads on the current Node runtime;
it makes no model calls or real Google requests and changes no deadlines.
