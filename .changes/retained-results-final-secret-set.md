---
type: changed
---

A program's retained results now honour the run's complete secret set. A result stored during a run becomes readable from later requests only after its bytes pass the set as it stands when the run ends, including anything registered after the result was stored, and matches are rewritten under the same id. A run pays no extra storage unless the set grew after a stash. An entry that cannot be checked is refused: paging it from a later request answers `result_not_retained` with `retryable: false`, a read told to rerun and a write told not to repeat, and the run's response carries a `note` saying so. Paging inside the run is unchanged, and direct-call stashes keep passing their own request's set when stored.
