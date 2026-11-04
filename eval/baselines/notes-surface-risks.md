# Surface risk notes

Measured on 2026-11-04 with Claude Code 2.1.318 (`claude-sonnet-5-5`) and Codex
0.166.0 (`gpt-6.1-sol`), on the Worker target with outcome grading. The batches,
tasks and budget were fixed in [the plan](../surface-risks-plan.ts) before any
score. [Trial data](surface-risks.json) and [flip reports](stale-flip.json) sit
beside these notes.

The 183 scored trials had no invalid results: no timeouts and no host errors, with
a 51 s maximum. Batches started only at a 1-minute load of 30 or lower, though
other work raised load to at least 77 while some ran. With 14 retired trials the total is
197 paid trials against a budget of 200. The scored batches ran on source before
the rebase onto main. The flip matrix and unpaid controls were rerun after it.

`eval/hard-discovery-tasks` landed after the task list froze and is unused. No
paraphrase tasks existed, so `eval/tasks/paraphrase.ts` was written for this run,
after the hints.

## Limits

- Cells are small. Allow cells have one trial per task, deny cells two.
- One arm-text defect was found while read scores were partial. 14 trials saw
  "Everything else: execute_code" on the read route and are excluded, and the
  budget revision in the plan paid for rerunning them.
- A prompt is modeled as an always-allow or always-deny answer, not a person.
- Fixtures are fakes with padded catalogs. Task tools were all inside the pinned
  arm's 30, so pinned shows the case where the pin hits.

## Stale flip: reproduced

A real Claude Code process duplicated physical writes. A native tool was listed
read-only and became a write. Four parallel calls then met a failing connection:
one held open and three reset, which closes the transport while one call is
pending. Claude Code reconnects and replays any call whose cached annotation says
read-only.

| Case                                  | Host-sent calls | Physical calls | Duplicated writes |
| ------------------------------------- | --------------- | -------------- | ----------------- |
| Native, read flipped to write         | 6               | 6              | **2 records**     |
| Native, source write classified read  | 6               | 6              | **2 records**     |
| `call_tool`, source write classified read | 8           | 5              | **1 record**      |
| Read program, source write classified read | 6          | 6              | **2 records**     |
| Native, always a write                | 4               | 4              | none              |
| `execute_code` with a flipped tool    | 4               | 4              | none              |
| `call_tool` with a flipped tool       | 8               | 0              | none              |
| Read program with a flipped tool      | 6               | 0              | none              |
| Name-bound native prototype, flipped  | 6               | 0              | none              |

Native-flip duplicates appeared in all 3 runs. The always-read control also
replays, showing the replay is the host's and needs no write classification.

The trigger is narrower than "a connection closes". On Claude Code 2.1.318 a
single socket reset, a 200 event stream that ends or resets, and intermediary 404
or 503 replies each caused no replay. On Codex 0.166.0 a reset and a 503 caused no
replay, measured before the rebase, and the parallel mode is not scripted there. Eve was not tested.

Replayed calls carry restarted JSON-RPC ids (2, 3, 4, 5 then 0, 1) and no session
id, because the protocol is stateless. Connecta cannot dedupe by request identity.

`src/` is not at fault under INV-9's wording, since Connecta never resends. The
physical effect is still a duplicate write, and the [native docs](../../documentation/meta-tools.md#native-tool-surface)
and [decision 0015](../../decisions/0015-native-tools-and-agent-identity.md)
describe only the stale approval, not this replay.

## Approval friction

Claude Code pre-approved read-annotated tools. Codex used its default.

| Arm         | Claude prompts/trial | Claude deny, read tasks | Codex prompts/trial | Codex deny, read tasks |
| ----------- | -------------------- | ----------------------- | ------------------- | ---------------------- |
| `six`       | 2.3                  | 2/6                     | 1.8                 | 2/6                    |
| `five`      | 2.8                  | 2/6                     | 1.5                 | 2/6                    |
| `native`    | 0.8                  | 4/6                     | 0.5                 | 4/6                    |
| `read-six`  | 1.5                  | 5/6                     | 0.3                 | 6/6                    |
| `read-five` | 2.0                  | 4/6                     | 0.5                 | 6/6                    |

Prompts/trial comes from the allow batch, 4 trials per arm per host. Deny read
tasks exclude the join, which needs a write and failed everywhere with 0 physical
writes. Allow passes were 4/4 per arm per host except `native`, 3/4 on both,
failing paging.

Mean total tokens in the allow batch:

| Host   | `six` | `five` | `native` | `read-six` | `read-five` |
| ------ | ----- | ------ | -------- | ---------- | ----------- |
| Claude | 30k   | 25k    | 40k      | 35k        | 32k         |
| Codex  | 55k   | 50k    | 73k      | 62k        | 58k         |

After a first refusal, 40 of 42 trials stopped and reported honestly, even when
the refused call was a read-only search and `search_tools` or `call_tool` could
run unprompted. One retried the same write and one switched route. No answer
claimed a write that did not happen.

Adoption differs by host. Codex used the read route for all reads, including the
join, then needed one prompt for the write. Claude used `execute_code` first on 6
of 6 joins and 4 of 6 discovery reads, despite the instructions, and used the read
route on paging. It selects tools by name before reading their descriptions, which
is a likely cause but untested. `read-six` versus `read-five` differs by a trial or
less on deny passes, so that comparison is inconclusive. `read-five` needs a
prompted program to find a write's address; `read-six` finds it unprompted.

The read route is safe by construction in these checks. `eval/surface-controls.ts`
shows no physical write through read-then-write, a swallowed refusal,
`Promise.allSettled` or repeated attempts, while the same write lands once through
`execute_code`.

- **INV-1:** classification is unchanged and unannotated tools remain writes, so
  they are refused. A deployment override to read is allowed, and the host can then
  replay it, as the table above shows.
- **INV-2:** the route adds no write path. `execute_code` stays annotated as a
  write. The invariant's text and the "exactly six" contract would need updating
  if `search_tools` stays beside it.
- **INV-3:** refusal happens in the invocation layer below the sandbox.

## Search hints

Paid trials could not separate the arms: `native` and `native-hints` both passed
6/6 with equal tokens. All 12 trials picked tools from names with `select:`, so no
hint was consulted.

The keyword path does respond. In `eval/search-rank.ts` at 300 padded tools, a
query set written blind to the hints scored:

| Arm            | Top-1 of 12 | Top-5 of 12 |
| -------------- | ----------- | ----------- |
| `native`       | 6           | 7           |
| `native-hints` | 10          | 10          |

The MCP spec allows the key: a `_meta` prefix may be a single label, is only
SHOULD for reverse DNS, and is reserved only when its second label is
`modelcontextprotocol` or `mcp`. `anthropic/searchHint` has one label. Connecta's
contract names `dev.connecta/*` keys and neither permits nor forbids others, so
emitting this one needs a documented addition.

## ToolSearch off

At 500 padded tools on Claude Code:

| Arm      | Passes | First-turn input | Total tokens by task |
| -------- | ------ | ---------------- | -------------------- |
| `six`    | 6/6    | 4k               | 9k to 40k            |
| `native` | 6/6    | 167k             | 335k to 677k         |
| `pinned` | 3/3    | 10k              | 21k to 48k           |

## Catalog size

All 36 trials passed at 50, 150 and 500 tools, so no pass-rate crossover exists in
this range. One trial per task and arm:

| Claude tokens, discovery / join | 50 tools | 150 tools | 500 tools |
| ------------------------------- | -------- | --------- | --------- |
| `six`                           | 23k/42k  | 34k/42k   | 23k/44k   |
| `five`                          | 26k/41k  | 24k/39k   | 26k/36k   |
| `native`                        | 16k/30k  | 24k/41k   | 53k/77k   |

| Codex tokens, discovery / join | 50 tools | 150 tools | 500 tools |
| ------------------------------ | -------- | --------- | --------- |
| `six`                          | 49k/73k  | 49k/85k   | 49k/85k   |
| `five`                         | 45k/69k  | 45k/83k   | 45k/72k   |
| `native`                       | 52k/70k  | 67k/110k  | 67k/75k   |

On Claude, native is cheaper at 50, about equal at 150 and about double at 500, so
300 sits above the crossover and was representative of larger catalogs. Native's
first turn grows from 3k to 13k, while meta stays at 2k. Codex's first turn stays
at 6k, and no clear crossover appears: native costs more on discovery at every
size and is mixed on the join.
