---
type: changed
---

Run the Tithe.ly provider on the internal HTTP provider kit, with its tools, credential probe, failures and hatches unchanged for agents. On Node, its writes now need the owned transport that `listen` from `@zackbart/connecta/node` installs, as every kit write does; a blank `title` is refused at construction like every other provider's.
