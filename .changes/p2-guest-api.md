---
type: changed
breaking: true
---

Complete the JavaScript guest API with `connecta.result(id, options)` and `connecta.skill(name)`, support object-form calls, and remove the `get_result` meta-tool. Guest calls now return `{ data, format: "json" | "text" }`; direct results also declare their format. Every program reports host-call counts, and guest failures use `program_error` with source locations and fixed repair hints. Uncaught host errors retain their type through executor-owned Error identities and host outcome channels. Programs and direct calls share configurable deadlines and report operation, stage, elapsed time, and effective deadline. Unawaited emission delivers MCP media content; emitted text shares the program result cap. All six meta-tools advertise output schemas.

Result paging binds stashes to the admitted identity, endpoint, origin, connector, and tool, and rechecks current grants, pool membership, and trust before returning data. Legacy unbound stashes are unavailable after upgrade. Truncated direct writes on read-only pools return inline notices and bounded previews without storing results or advertising unavailable paging. Refresh refusals retain write accounting, including uncertain outcomes.

Worker guest modules cannot resolve runner modules through dynamic imports or builtin module loaders. A private runner module captures its references before guest module evaluation, and the adapter refuses splices containing more than one expression before loading. QuickJS checks interrupt and deadline facts before safely describing rejections without guest getters, serialization hooks, or Proxy traps, including interruptions during private diagnostic initialization. Images require a supported MIME type and canonical base64 before collection. Catalog search advertises the shared flat schema; eval programs and graders use typed data and result paging.
