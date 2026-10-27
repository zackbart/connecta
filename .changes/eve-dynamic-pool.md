---
type: added
---

Let `@zackbart/connecta-eve` choose a pool at runtime with a selector on connections and instructions. Dynamic connections identify the selected pool for Eve's approval replay checks; instructions keep guidance, cache TTLs and failure backoff per endpoint. Instruction requests also accept a custom `clientName`.
