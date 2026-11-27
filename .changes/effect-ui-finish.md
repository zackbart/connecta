---
type: changed
---

The operator UI now runs entirely on Effect UI (`@effect/ui` and `@effect/ui-kit`, bundled into its assets), and React, ReactDOM, TanStack Router, Radix and cmdk are gone from the bundle and the build. Operators see no change in behavior. The browser bundle is larger than before the move: the hashed operator assets are about 404 KB gzip, up from under 283 KB, and the `./ui` entry a Worker bundles is about 480 KB, up from about 351 KB.
