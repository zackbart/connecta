---
status: proposed
date: 2026-10-08
issues: [765, 703, 672, 709, 771]
supersedes: []
---

# The code-mode agent surface

The 0.29 surface lists six tools, and most of it repeats what a program already
does. `call_tool` is `connecta.call` and `search_tools` is `connecta.search`.
`call_destructive_tool` exists only so writes in a `read-only` pool can leave
the program and reach a per-call host prompt. `authorize_connector` hands off a
sign-in that URL elicitation already delivers to capable hosts. [#765](https://github.com/zackbart/connecta/issues/765)
asks whether to collapse the surface into code mode, as Executor v2 did, and
whether that prompted write path protects anything. This record answers with
the 0.29 baselines ([notes](../eval/baselines/notes-0.29.md)) and local
transcripts. It proposes the change; nothing here has shipped.

## Evidence

### Which top-level tools agents used

These are the [Sonnet 5.5](../eval/baselines/sonnet-5-5-0.29.json) and
[GPT-6-Luna](../eval/baselines/gpt-6-luna-0.29.json) baselines: 19 tasks, two
repeats each, and 34 and 38 graded trials.

| Tool                    | Sonnet calls (trials) | Luna calls (trials) |
| ----------------------- | --------------------- | ------------------- |
| `execute_code`          | 61 (25)               | 109 (36)            |
| `call_tool`             | 38 (18)               | 5 (5)               |
| `call_destructive_tool` | 20 (10)               | 20 (10)             |
| `search_tools`          | 10 (10)               | 9 (7)               |
| `authorize_connector`   | 6 (6)                 | 4 (4)               |
| `skills`                | 4 (4)                 | 1 (1)               |
| Total                   | 139                   | 148                 |

Programs made up 44% of Sonnet's top-level calls and 74% of Luna's. Of Luna's
109 programs, 55 called `connecta.search`, 7 `connecta.describe`, and 5 each
`connecta.skill`, `connecta.emit` and `connecta.result`. Every top-level
`search_tools` call was either a catalog lookup or a search for a write address
to send to `call_destructive_tool` (3 of Sonnet's, 6 of Luna's).
For trend context, the 0.24.4 baseline ([notes](../eval/baselines/notes-main.txt))
had `execute_code` at 146 of 502 calls (29%) and `search_tools` at 126. Its
tools, models and tasks differ, so it is not directly comparable.

### Failures caused by having several tools

Thirteen trials failed: 4 for Sonnet and 9 for Luna. In eight of them the
answer or outcome was correct, and the trial failed because of the choice
between top-level tools:

- **Luna, `p5-known-read-routing`, 2 of 2.** Each trial used one `execute_code`
  program with one downstream read and gave the correct answer. Both failed only
  because the grader requires `call_tool`.
- **Luna, `p5-read-only-program-refusal`, 2 of 2.** Both used
  `call_destructive_tool` instead of testing a program write.
- **Luna, `p5-direct-rich-output`, 2 of 2.** Both re-emitted the downstream text
  and `image/png` blocks from a program with `connecta.emit`. The
  `execute_code` results carry the exact blocks the grader checks for, but its
  `image-delivered` check accepts only `call_tool`.
- **Sonnet, `p5-auth-url-capable`, 2 of 2.** The first `call_tool` read
  succeeded after the URL elicitation. Claude Code showed it as
  `{"format":"json"}`, the agent read that as an empty result, and it called
  `authorize_connector`, which raised the second sign-in that fails the task.
  This explains [#771](https://github.com/zackbart/connecta/issues/771).

The five other failures are unrelated to the surface. Two come from an
ambiguous prompt (`cross-connector-join`, Luna). Two are discovery misses
(`p5-absent-github`, Sonnet). One is a grader that cannot bind a value-mode
result id (`p5-result-paging`, Luna). Grading on outcome alone, without the
route checks, would pass Luna's four known-read and rich-output trials, for
33/38 instead of 29/38. The refusal and auth trials still fail their outcome
checks, so Sonnet stays at 30/34.

### `call_tool` does not work well on Claude Code

In MCP result mode, `call_tool` and `call_destructive_tool` put the downstream
data in `content` and set `structuredContent` to `{ format }` alone
(`src/meta-tools.ts`, the MCP branch of call processing). Claude Code 2.1.292
shows the model `structuredContent` when it is present. As a result:

- 16 of Sonnet's 38 `call_tool` results and 18 of its 20 `call_destructive_tool`
  results reached the model as `{"format":"json"}` and nothing else. This
  happened in 12 of the 19 tasks.
- 19 of Sonnet's 21 duplicate downstream reads were in trials with such a
  result. The agent retried in `resultMode: "value"`.
- On `p5-known-read-routing`, Sonnet needed two `call_tool` calls and three
  model turns per trial. Luna answered with one program call.

A local check against the eval fakes (`chat.list_channels`) shows the same
thing. The default `call_tool` result has 17 bytes of `structuredContent`
beside 424 bytes of `content`. Program results put the full value in
`structuredContent`, so programs are not affected.

### What a single read costs

| Route                                                                                     | Arguments | Result | Server p50 / p90 |
| ----------------------------------------------------------------------------------------- | --------- | ------ | ---------------- |
| `call_tool` (default)                                                                     | 42 B      | 424 B  | 5.6 / 8.0 ms     |
| `call_tool`, `resultMode: "value"`                                                        | 63 B      | 487 B  | 5.4 / 17.7 ms    |
| `execute_code` running `async () => (await connecta.call("chat.list_channels", {})).data` | 77 B      | 501 B  | 10.7 / 34.6 ms   |

For one read, a one-line program sends and receives 14 more bytes than value
mode. It adds about 5 ms of executor time at p50, which is small next to a
model turn of several seconds. The definitions are a bigger
cost. In model-visible bytes (description plus input schema, measured with
one connector), `call_tool` is 725 B and the four tools this record removes
total 2,930 of the surface's 5,195 B. The routing sentences in the 941-byte
server instructions mostly go too. Every request carries those bytes.

### How often a write prompt was refused

The eval cannot measure refusals. Its hosts approve every listed tool unless a
task configures a denial: 71 of 73 gated calls were approved, and the other two
were the refusal task's configured denials. Connecta cannot measure them either, because a host denial
never reaches the server.

Local transcripts are the only real-world evidence. They cover the owner's
machine only, and those deployments still served the pre-0.29 surface:

- Claude Code made 26 `call_destructive_tool` calls to BePresent and One&Many
  in 9 sessions between 2026-09-08 and 2026-10-06. All 26 ran under
  `bypassPermissions`, so no prompt was shown, and none were denied.
- Codex had 27 sessions that call `call_destructive_tool` between 2026-08-01
  and 2026-09-27. Every one ran with `approval_policy: "never"`. None contains
  "user rejected MCP tool call".

No observed write prompt reached a person, which matches #765's rubber-stamp
claim. The [#703](https://github.com/zackbart/connecta/issues/703) forensics
(~6,800 calls) found that code mode works and that no evidence supported
approval pauses or more meta-tools.

### Prior art

Executor v2 (`UsefulSoftwareCo/executor`, `v2` at `76d4ef36d8db`) lists
`execute` and `skills`, plus `resume` except in its native elicitation mode.
Search and schema reads happen inside the program (`tools.search`,
`tools.search.describe`). Its scoped connections offer an "all", "read-only" or
"picked" tool set, and both "all" and "read-only" include tools added later.
Executor approves per tool by pausing the program in memory. Connecta rejected
that design in [#672](https://github.com/zackbart/connecta/issues/672), because
a Worker cannot keep a program in memory across requests. So the prior art
supports the shape of the tool list but not its approval model.

## Decision

**Adopt, in phases.** `tools/list` becomes two tools, `execute_code` and
`skills`. Remove `call_tool`, `call_destructive_tool`, `search_tools` and
`authorize_connector`, but only after each capability below is reachable from
a program. The phases, not this record, carry the removals.

### Answers to the issue's questions

- **Does a `read-only` pool still mean anything?** Yes. It is a fail-closed
  classification filter, not a grant list. Grants name connectors and tools.
  Trust follows each tool's stored verdict, so it covers tools that appear
  later and unannotated tools, which grants cannot do. That matches Executor's
  "read-only" scope. What changes is that a read-only pool now has no write
  path at all:
  - A program write is refused with a terminal `pool_read_only` error. It is
    not retryable, carries no `nextAction`, and says the operator can expose a
    trusted pool.
  - Discovery still lists writes with `classification: "write"`, so an agent
    can say the endpoint cannot write instead of claiming no tool exists.
  - `execute_code` stays annotated read-only, so hosts can auto-approve it.
  - The `trust: "read-only" | "trusted"` configuration is unchanged.
- **Does `call_tool` pay for itself?** No:
  - Compared with a one-line program, it saves 14 bytes each way per read but
    costs 725 B of definitions on every request.
  - In the baselines, choosing between it and a program caused two route-only
    failures, and its `{ format }`-only structured result caused Sonnet's
    retries and its auth-elicitation failure.
  - An agent that only knows code mode does a known read in one program, as
    Luna did.
- **Which tools survive?** `execute_code`, plus `skills`:
  - `skills` stays because the usage skill teaches program syntax, and guidance
    for writing programs cannot require writing a program. In the 0.24.4
    baseline, Haiku's first programs often failed on `require` or a bare body.
    The tool costs 244 B. Executor keeps the same tool.
  - `authorize_connector` goes:
    - Hosts that declare `elicitation.url` already get the sign-in from
      programs.
    - For other hosts, the program's auth error carries the handoff directly:
      `authorizationUrl`, or `operatorUrl` with the credential fields. It is
      minted only when the admitted identity may manage the connector. Minting
      is stateless (`src/oauth-handoff.ts`), so INV-10 holds.
    - `connecta.authorize(connector, { force? })` covers an explicit connect or
      restart. The host mints the link, as `authorize_connector` does today,
      so INV-3 holds.
- **How does host approval attach?** To the `execute_code` call:
  - On a trusted pool, `execute_code` is annotated
    `destructiveHint: true` and the host shows its `code`. The approved request
    is exactly what runs. P1's syntactic recovery is the only normalization,
    and auth retries already bind the code digest.
  - `execute_code` gains `call_destructive_tool`'s optional `reason` (at most
    500 characters, shown to the host, dropped before the run).
  - Hosts approve per tool, so a trusted pool prompts for read programs too.
    That is already true in 0.29.
- **What do per-call prompt deployments need?** See [Migration](#migration).
- **Rich output.** See the `call_tool` rows below. Re-emitting text, image and
  audio already works (Luna, 2 of 2 trials). Passing through other block types
  needs Phase 1.
- **Eval impact.** See [Eval](#eval).

### Where each removed capability goes

| Removed capability                                                             | In-program replacement                                                                                                     | Today   |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | ------- |
| `call_tool`: one known read                                                    | `connecta.call(address, args)`                                                                                             | yes     |
| `call_tool`: `resultMode: "value"`, `timeoutMs`, `diagnostics`                 | `{ data, format }`, `connecta.call(…, { timeoutMs })`, `execute_code({ diagnostics })`                                     | yes     |
| `call_tool`: downstream text, image or audio blocks                            | `connecta.emit(block)`                                                                                                     | yes     |
| `call_tool`: `resource_link`, embedded resources, annotations, `_meta`         | `connecta.emit({ ref })` emits a host-issued call result's native blocks verbatim. Guest-authored blocks keep M1's limits. | Phase 1 |
| Direct results over the inline cap, paged with `connecta.result`               | The full value inside the program, up to L6. Over L6, the call returns a stash handle instead of failing.                  | Phase 2 |
| Downstream `input_required` relay (direct calls only)                          | Programs restart under the auth-recovery rule                                                                              | Phase 4 |
| `Mcp-Param-Address` header                                                     | None. Activity still records each address.                                                                                 | dropped |
| `call_destructive_tool` on a trusted pool                                      | A program write, with W9 accounting and the W10 budget                                                                     | yes     |
| `call_destructive_tool` on a read-only pool                                    | None by design. Use a trusted pool.                                                                                        | Phase 6 |
| `call_destructive_tool`: `reason`                                              | `execute_code`'s `reason`                                                                                                  | Phase 6 |
| `call_destructive_tool`: large write results, `write_outcome_unknown`          | Phase 2's handle; `writes` and `uncertainCalls` on the run                                                                 | Phase 2 |
| `search_tools`, including `safety`, schema formats, absence and catalog errors | `connecta.search`, with identical arguments and page                                                                       | yes     |
| `authorize_connector` on hosts with URL elicitation                            | Program URL elicitation                                                                                                    | yes     |
| `authorize_connector` on other hosts, including `force` and `operator_config`  | The handoff in the auth error, and `connecta.authorize(id, { force? })`                                                    | Phase 3 |

Alternatives considered:

- **Keep `call_tool` as a cheap read path.** The numbers above rule it out.
- **Approve each write with an in-program elicitation.** This is #672's replay
  journal again, because MRTR is stateless.
- **Two execute tools, one read-only and one that writes.** This brings back
  the asymmetry #765 removes.
- **Require `execute_code` to declare its write addresses**, with Connecta
  enforcing the list so the prompt is concrete. Deferred. No evidence yet shows
  that anyone reads approval prompts. Reconsider if hosts render such a field.

## Migration

The change would ship as a breaking 0.30 release.

- **Deployments that rely on per-call write prompts.** Choose one per endpoint:
  - Make the pool `trusted`. The host prompts once per program, read programs
    included.
  - Keep the root `read-only` and add a named `trusted` pool for writes. Mount
    it as a second MCP server and let the host auto-approve the read-only one.
    This is closest to the current behavior: one prompt per write program.
  - Accept read-only, with no writes.
- **BePresent and One&Many** already plan `trust: "trusted"` for their root
  endpoints ([#709](https://github.com/zackbart/connecta/issues/709#issuecomment-6051001475)).
  Confirm with the owner at deploy time.
- **Configuration.** No keys are removed. `calls.maxResultBytes` and
  per-connector `maxResultBytes` now size Phase 2's pages.
- **Machine clients and scripts.**
  - Replace `call_tool({ address, args })` with
    `execute_code({ code: "async () => (await connecta.call(<address>, <args>)).data" })`.
    The result becomes `{ result, hostCalls }`.
  - Replace `search_tools(args)` with `connecta.search(args)` inside a program.
  - Replace `authorize_connector` with the auth error's handoff or
    `connecta.authorize`.
  - Gateways that read `Mcp-Param-Address` lose it.
- **Records.** Activity readers keep rendering historical `call_tool` and
  `call_destructive_tool` sources. Doctor, the template, README, the usage
  skill, provider guides (8 name `call_destructive_tool`, 15 `call_tool`), the
  server instructions and `spec/coverage.json` describe the two-tool surface.
  PRINCIPLES goal 1 and INV-2 drop the direct-call route. INV-2 becomes: a
  write leaves a program only in a trusted pool, and a read-only pool has no
  write path.

## Eval

The tasks below change meaning. Their outcome checks stay the same; only the
route checks change.

| Task                                                                          | New meaning                                                                                     |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `p5-known-read-routing`                                                       | One `execute_code` call and one `ci.get_run` read                                               |
| `p5-read-only-program-refusal`                                                | A refused program write. The `call_destructive_tool` clause and its configured denial go.       |
| `p5-direct-rich-output`                                                       | The program route with native passthrough. Phase 1 adds a `resource_link` block to the fixture. |
| `p5-result-paging`, `truncated-read-paging`                                   | Reduce a large read inside a program. A log over L6 must be paged through Phase 2's handle.     |
| `truncated-write-export`                                                      | Export once in a program and reduce before returning. `export-once` stays required.             |
| `stale-close-and-summarize`, `cross-connector-join`, `auth-required-recovery` | Run on a trusted deployment, because a read-only root cannot write                              |
| `auth-required-recovery`, `p5-auth-connect-incapable`                         | The handoff comes from the program's auth error or `connecta.authorize`                         |

**Showing no worse correctness than 0.29.** Use the same runners, models and
CLI versions, two repeats, and the same 19 tasks:

- Run `v0.29.0` and the new surface in the same batch as an A/B, with no
  stale comparison.
- The comparator is 0.29 graded on outcome alone: Sonnet 30/34, Luna 33/38.
- **Pass bar:** each runner scores at least its comparator, no task loses more
  than one trial without a written triage, there are zero duplicate writes, and
  `export-once` holds.
- Paid runs need owner approval, as #709's did.

## Phases

Each phase is one PR.

0. **Fix direct-call `structuredContent`, independent of adoption.**
   - Problem: MCP-mode results whose structured content holds only `format` are
     shown empty by hosts that prefer `structuredContent`.
   - Accept when: MCP-mode `structuredContent` carries the result and still
     conforms to the output schema, and a one-trial `p5-known-read-routing`
     run on Claude Code makes one call.
1. **Native content passthrough.**
   - Change: `connecta.call` results from MCP connectors carry a request-local
     `ref`. `connecta.emit({ ref })` emits those exact downstream blocks, under
     the M3 and M5 budgets and agent redaction.
   - Accept when: a guest-made or foreign `ref` is refused, a downstream
     `resource_link` and annotations arrive byte-exact, and a program run of
     the rich task passes on the fakes.
2. **Results over the bridge bound.**
   - Change: a host-call result over L6 is stashed with the identity bindings of
     direct calls. The call resolves to `{ truncated, resultId, totalBytes }`.
     On trusted pools this includes writes. When the run wrote, R2's
     truncation hint says not to run it again.
   - Accept when: a 300 KiB write result on QuickJS pages through
     `connecta.result` with one write, Workers behaves the same, and a
     read-only pool cannot page a write stash.
3. **Auth handoff in programs.**
   - Change: the handoff goes into the auth error envelope, and
     `connecta.authorize(connector, { force? })` is added.
   - Accept when: an incapable host passes the auth tasks with no
     `authorize_connector` call, management permission is enforced, and
     discovery mints nothing.
4. **Downstream input in programs.**
   - Change: a program may relay downstream `input_required` when every call it
     entered before the pending one is a fresh read. Sealed state binds the
     code digest and the pending address and arguments. The nonce is
     single-use.
   - Accept when: the direct-call relay tests pass on the program route, and
     each of these is refused: an earlier write, changed arguments, and replay.
5. **Route-neutral eval.**
   - Change: graders accept the program route, and the 0.29 baselines get an
     outcome-only regrade. Fakes only.
   - Accept when: `eval:selftest` passes, and the regrade reproduces 30/34 and
     33/38.
6. **Read-only becomes terminal; remove `call_destructive_tool`.**
   - Change: `pool_read_only` replaces `destructive_tool_requires_approval`.
     `execute_code` gains `reason`. INV-2 is rewritten.
   - Accept when: `tools/list` has five tools, write tasks pass on trusted
     deployments with the fakes, and `npm run check` passes.
7. **Two tools.**
   - Change: remove `call_tool`, `search_tools` and `authorize_connector`, plus
     the address header, and rewrite the instructions and docs.
   - Accept when: doctor verifies `execute_code` and `skills`, all migration
     notes ship as `.changes/` fragments, and `release:check` passes.
8. **Paid A/B baseline.**
   - Change: run the protocol in [Eval](#eval) and commit both result files and
     notes.
   - Accept when: the pass bar holds. This record then becomes `accepted`, or
     the removals are reverted before release.

## Consequences and risks

- Review moves from `{ address, args }` to program text, and long programs are
  harder to approve. Use `reason`, and keep writes in short programs when a
  person reviews them.
- One endpoint can no longer combine auto-approved reads with prompted writes.
  Two pools cover that case.
- Weaker models must write a valid program for every operation. `skills` and
  P1's recovery reduce the risk. Phase 8 measures only mid-tier models.
- Restarting a program for downstream input refuses programs whose arguments
  change between runs. That is safe but loses the input.
- Claude Code 2.1.292's stream output drops emitted text when
  `structuredContent` is present, so programs should return facts as values
  and emit only media.
- The evidence has limits. There are two repeats per task, the eval hosts
  approve everything, and the refusal data comes from one machine.

Reconsider if:

- a host shows approval prompts that people actually deny;
- Phase 8 misses the pass bar;
- a supported host cannot run `execute_code` but can call a direct tool.
