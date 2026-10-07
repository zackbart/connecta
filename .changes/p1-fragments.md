---
type: changed
---

Contributors add changelog fragments in `.changes/`; release authors assemble
them with a hand-written narrative using `npm run changelog:assemble`.
Vitest runs every suite on Node and excludes `*.node.test.ts` from Workers,
with each Node-only reason recorded in the file instead of shared suite lists (#705).
