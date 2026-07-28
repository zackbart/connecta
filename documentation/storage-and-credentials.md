# Storage and credentials

> **Stub.** The old manual was retired in the phase-1 docs restructure. This
> document will be rewritten as an agent-facing guide — what the subsystem is
> for, how to work on it, and what it must never do — once the ideas in
> [ethos.md](../ethos.md) settle. The prior text lives in git history as
> `docs/storage-and-credentials.md`.

Proactive credential liveness probing was **removed in 0.9** by ethos decision
([#179](https://github.com/zackbart/connecta/issues/179)). The vault, local
credential-shape drift detection, and operator-triggered credential tests remain.
