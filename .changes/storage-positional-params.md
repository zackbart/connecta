---
type: fixed
---

Use plain positional SQL parameters with values bound in statement order on
both storage drivers. Node's SQLite driver prepares the shared SQL unchanged,
without rewriting quoted text, on every supported Node version (#705).
