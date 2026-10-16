---
type: changed
---

An agent in a pool without an `owner` no longer sees Google Workspace connectors whose `subject` is a mapping function: they are absent from discovery, search, describe, skills and code mode, and a call by address fails `unknown_address`, as for a personal connector. Before, the agent saw them and every call failed `auth_required`. People in the same pool, agents in owned pools, and fixed-subject connectors are unchanged (#870).

Paging a saved program return rechecks every connector contributing to search counts, ranking, term analysis, or guidance, including matches outside the returned page and connector references when no tools matched. Removing a pool owner therefore also hides those saved contributions from agents.
