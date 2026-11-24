---
type: changed
---

A program read up to 1 MiB now reaches the program from the run's memory, with no result storage and no per-page access recheck, instead of being stashed, paged back and reclaimed (#1499). A run holds at most 4 MiB of such reads at once and releases each when its last page is served and all of them when the run ends; past that bound a read takes the stash as before. Writes, handles over 1 MiB, and the `calls[].resultId` retention of a failed run are unchanged. On the `eval:perf` 600 KiB cell a program's two reads drop from 644 storage round trips to the same 14 as a program with small reads.
