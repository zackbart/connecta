# Connecta ten-tool token and behavior audit

Date: 2026-07-29 America/New_York

Source: `origin/main` at
`e3c3ac6a0843ca1668cd28ea75a6726710f4f91d`

Tokenizer: `o200k_base` via `js-tiktoken@1.0.21`

Raw results:
[`audit-results-2026-07-29.json`](./audit-results-2026-07-29.json)

## What the token count means

This audit counts the exact `o200k_base` tokens in the JSON serialization of:

1. the ten definitions returned by MCP `tools/list`;
2. every meta-tool call's parameters;
3. every complete MCP tool result.

It does not claim the model's billed total. Model deliberation, the host's
internal prompt, and any host-specific envelope around MCP values are outside
the client-visible surface. A host may also choose to suppress either
`content` or `structuredContent`; this client retained both exactly as
returned.

## One complete audit run

| Surface | Tokens | Share |
| --- | ---: | ---: |
| Ten tool definitions | 2,252 | 19.9% |
| Fourteen call requests | 493 | 4.4% |
| Fourteen call responses | 8,562 | 75.7% |
| **Measured Connecta surface** | **11,307** | **100%** |

MCP connection plus `tools/list` took 35.8 ms. The fourteen tool calls summed
to 566.1 ms. These are client-observed samples from one loopback run; network
and cold QuickJS latency make them evidence, not a latency distribution.

## Tool-by-tool cost and verdict

`Total` assigns each tool its definition once, then adds every audited request
and response for that tool. The four-token `tools/list` array wrapper is not
assigned to an individual tool.

| Tool | Job exercised | Schema | Calls | Request | Response | Total | Avg latency | Verdict |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `skills` | List available guides; fetch the routing guide | 151 | 2 | 20 | 802 | 973 | 3.7 ms | Pass; the 713-token routing guide dominates |
| `list_connectors` | Fast inventory and live status probe | 106 | 2 | 26 | 2,051 | 2,183 | 4.2 ms | Pass; `probe: false` saved 373 response tokens |
| `search_tools` | Focused discovery with compact schemas | 201 | 1 | 28 | 1,794 | 2,023 | 3.9 ms | Pass, but noisy: nine of twelve tools returned |
| `describe_tools` | Full JSON schemas for seven addresses | 168 | 1 | 47 | 1,638 | 1,853 | 3.6 ms | Pass; expensive as expected, so use only on demand |
| `call_tool` | Live read, safety refusal, truncation setup | 263 | 3 | 108 | 727 | 1,098 | 75.6 ms | Pass; refused the write with the correct typed error |
| `call_destructive_tool` | Approved isolated in-memory write | 221 | 1 | 32 | 183 | 436 | 9.8 ms | Pass; only this route changed the counter |
| `authorize_connector` | Start an OAuth-shaped recovery flow | 112 | 1 | 14 | 236 | 362 | 4.9 ms | Pass; returned URL and operator instructions |
| `get_result` | Read the first 700-byte UTF-8 page | 219 | 1 | 41 | 459 | 719 | 5.1 ms | Pass; exact offset and next offset returned |
| `batch_call` | Run two live independent reads in parallel | 341 | 1 | 88 | 496 | 925 | 205.3 ms | Pass; 199 ms wall vs 248 ms summed children |
| `execute_code` | Fetch and reduce 120 records in QuickJS | 466 | 1 | 89 | 176 | 731 | 91.0 ms | Pass; smallest useful data response in the audit |

All ten tools completed their intended job. The only failed downstream outcome
was deliberate: `call_tool` rejected an unsafe address with
`destructive_tool_requires_approval`, after which
`call_destructive_tool` executed it successfully.

## Static schema cost

| Tool | Definition tokens |
| --- | ---: |
| `execute_code` | 466 |
| `batch_call` | 341 |
| `call_tool` | 263 |
| `call_destructive_tool` | 221 |
| `get_result` | 219 |
| `search_tools` | 201 |
| `describe_tools` | 168 |
| `skills` | 151 |
| `authorize_connector` | 112 |
| `list_connectors` | 106 |

`execute_code`, `batch_call`, and `call_tool` account for 1,070 tokens, or
47.5% of the always-loaded schema surface. The earlier reduction comparison
showed that `execute_code` cut one result path by 94%, so its 466-token
definition has concrete evidence behind it when reduction is needed.

## Where the tokens went

The four discovery/orientation tools (`skills`, `list_connectors`,
`search_tools`, and `describe_tools`) produced 6,285 response tokens: 73.4% of
all response tokens in this workflow. That does not mean they are intrinsically
too large—the audit intentionally called all of them—but it shows that
discovery policy matters more than request syntax.

Twelve cases returned the same logical value through both pretty JSON text in
`content` and a JSON value in `structuredContent`. Counting the smaller
representation in each pair gives a conservative duplicate lower bound of
2,825 tokens, 33.0% of all response tokens. Whether those tokens reach a model
depends on the host, so the next cross-host audit should record the prompt
actually sent by each host.

The focused search query returned nine tools across four connectors from a
twelve-tool sandbox. Its 1,794-token result remained the largest single
response. This reproduces the earlier finding that partial search is useful
but broad.

## Behavioral audit

- **Routing:** the usage guide correctly separated single, parallel,
  destructive, paging, OAuth, and code-mode paths.
- **Inventory:** `probe: false` returned cached/local state with 839 response
  tokens; `probe: true` surfaced the OAuth fixture as `auth_required` with
  1,212.
- **Safety:** `call_tool` failed closed for an explicitly non-read-only tool.
- **Approval boundary:** `call_destructive_tool` successfully performed the
  same isolated write.
- **Parallelism:** the batch finished in roughly the slowest child's time, not
  the sum of both children.
- **Paging:** `get_result` returned exactly 700 UTF-8 bytes and the correct next
  offset.
- **OAuth:** `authorize_connector` returned an authorization URL and clear
  operator instructions.
- **Code mode:** QuickJS exposed only the read-only record tool and returned a
  compact aggregate.
- **Activity:** the sandbox retained the existing payload-free activity
  configuration; arguments, results, and generated code still had no field in
  the event schema.

## Audit limitations and next measurements

1. Run the same audit repeatedly and report cold/warm p50 and p95 latency.
2. Capture authoritative model-SDK input/output token counters alongside this
   deterministic surface count.
3. Compare hosts that forward both result representations with hosts that
   select one.
4. Add a real OAuth provider run; this audit intentionally used an isolated
   OAuth-shaped fixture so it could not modify an external account.
5. Keep the static-credential dead-end from the first baseline as a separate
   finding: OAuth recovery passed here, but static credentials still require a
   different operator path.
