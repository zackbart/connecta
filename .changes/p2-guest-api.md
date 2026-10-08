---
type: changed
breaking: true
---

Complete the JavaScript guest API with `connecta.result(id, options)` and `connecta.skill(name)`, support object-form calls, and remove the `get_result` meta-tool. Guest calls now return `{ data, format: "json" | "text" }`; direct results also declare their format. Every program reports host-call counts, and guest failures use `program_error` with source locations and fixed repair hints. Uncaught host errors retain their type through executor-owned Error identities and host outcome channels. Programs and direct calls share configurable deadlines and report operation, stage, elapsed time, and effective deadline. Unawaited emission delivers MCP media content; emitted text shares the program result cap. All six meta-tools advertise output schemas.

Result paging binds stashes to the admitted identity, endpoint, origin, connector, and tool, and rechecks current grants, pool membership, and trust before returning data. Legacy unbound stashes are unavailable after upgrade.
