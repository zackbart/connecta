# Code-first measurement history

This directory is an archive, not an active comparison harness. It originally
measured three serving shapes while connecta was deciding whether code-first
should become the default. The owner made that decision on 2026-07-30, and
[#273](https://github.com/zackbart/connecta/issues/273) subsequently removed
the two comparison shapes: every deployment now requires an executor and serves
the same seven tools.

The runnable harness was retired with that removal because its control and
incremental arms can no longer be constructed. The checked-in files under
[`results/`](./results/) remain unchanged as historical measurements. They
describe the product and harness as they existed when recorded; they are not a
current deployment guide or a benchmark that can be rerun against today's API.

For the evidence and reasoning that led to the code-first design, see the
[code-first exploration](../../documentation/code-first-exploration.md). The
current contract lives in [code mode](../../documentation/code-mode.md), and
[`ethos.md`](../../ethos.md) records the accepted and removed decisions.
