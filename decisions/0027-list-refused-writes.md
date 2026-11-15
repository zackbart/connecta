---
status: accepted
date: 2026-11-15
issues: [1469, 820, 1434]
supersedes: []
---

# Read-only scopes list their refused writes

#820 made a read-only endpoint omit write tools from search and describe, and
INV-2 recorded it. A connector's `readOnly` and a read-only pool's unnamed
writes followed the same rule. The omission was meant to keep agents away from
tools they cannot use. It also hides the fact the person needs: the change they
asked for exists and this endpoint refuses it.

The evidence:

- **Agents guess and conclude the tool is missing.** In the W5.1 decision run
  (#1465), Sonnet failed the read-only refusal task in 5 of 5 trials on the
  six-tool surface. Each trial guessed a write name such as
  `tracker.update_issue` and got `unknown_tool`, or searched and found no
  write. None tried the real `close_issue`, so none was refused. Several told
  the person the tool did not exist.
- **The #1434 note did not fix it.** Since #1434, an `unknown_tool` on a
  read-only scope says that search omits refused writes and that a write's
  exact address returns `read_only_endpoint`. That run already included the
  note and still failed 5 of 5 times. An agent with no address has nothing to
  retry.
- **`execute_read_code` already does this.** [0022](./0022-read-program-route.md)
  lists writes in a read program's discovery with `callable: false`, because
  leaving them out reads as absence. Agents read that marker correctly. A
  read-only scope has the same problem, so it gets the same fix.

## Decision

A scope that refuses writes it can otherwise see lists them in discovery. That
covers a read-only endpoint, a connector's `readOnly`, and a read-only pool
whose `writes` omit a tool from a connector it grants. `search_tools`,
`describe`, `connecta.search` and `connecta.describe` return each such write
with `classification: "write"` and `callable: false`, the marker from 0022. The
row's identity for collapsing includes it. Search shows these writes with a
summary, like reads, rather than the full description: no route here can run
them, so they don't use the write-description budget. Search and route
descriptions tell agents that writes marked this way are refused. A call is
then refused with `read_only_endpoint`, which tells the agent to tell the
user.

These stay the same:

- **Calls.** `read_only_endpoint` before validation or dispatch, on every path.
- **Native pools' `tools/list`.** Writes stay out of a read-only native pool's
  tool list. A listed tool is an invitation to call it, and on hosts that
  prompt, a tool the endpoint always refuses still costs the person an
  approval. Programs on that pool still find writes through `connecta.search`.
- **Scope boundary.** A tool outside the scope stays undiscoverable: an
  ungranted tool, a tool on an ungranted connector, or a tool classified
  `"hidden"`. Writes appear only on connectors the scope already grants, so no
  connector or tool outside the scope becomes visible.
- **The `unknown_tool` note** on a scope that refuses writes now says search
  lists them with `callable: false`. Its suggestions come from the same view
  search shows. It reads the same for every unknown name.

Rejected:

- **Keep omitting and improve the note.** #1434 tried this, and the run above
  measured it.
- **List refused writes only under `safety: "all"`.** That is already the
  default, so the condition changes nothing. Under `"approvalRequired"`, the
  same rows are what the caller asked for.
- **Also list them in a native pool's tool list.** See above. That would cost
  approvals and make hosts' tool pickers worse, for no gain over search.

## Consequences

Agents on read-only scopes see each in-scope write's name, summary and schema.
A deployment that relied on the omission to keep a write's existence private
from the scope's members has to remove the write from the scope with `"hidden"`
or a narrower grant. `readOnly` never hid anything a grant didn't. Reconsider
if the read-only refusal task still fails with writes listed, or if hosts treat
`callable: false` rows as tools to call.
