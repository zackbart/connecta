---
type: changed
---

An agent in a pool without an `owner` no longer sees Google Workspace connectors whose `subject` is a mapping function: they are absent from discovery, search, describe, skills and code mode, and a call by address fails `unknown_address`, as for a personal connector. Before, the agent saw them and every call failed `auth_required`. People in the same pool, agents in owned pools, and fixed-subject connectors are unchanged (#870).

Paging a saved program return rechecks connectors referenced by search guidance even when no tools matched, including connector identities, scoped guides and summaries, absence rosters, and catalog errors. Removing a pool owner therefore also hides those saved references from agents.
