# Agent evaluations

`npm run eval:agent -- --tasks p2-build-chart,p2-fix-chart-title --repeats 3`
runs the selected tasks against local fake services. The runner uses the signed-in
Codex CLI and requests `gpt-6-sol` unless `--models` names another Codex model.
It requires no provider credentials. Each trial starts a fresh fake world, a
Connecta deployment, and an isolated Codex app-server session. That session's
temporary `CODEX_HOME` exposes only the fake Connecta MCP server; app
connections, web search, and shell execution are disabled. The runner checks
the server's observed tool inventory and the model actually served before the
trial proceeds. The temporary home is removed after the session closes.

`--tasks` accepts comma-separated active task IDs; `--repeats`, `--concurrency`,
`--timeout-min`, `--effort`, `--models`, `--out`, `--report`, and `--baseline`
control a run. The result JSON is saved after every completed trial, so an
interrupted batch retains those results. SIGINT or SIGTERM stops the active
Codex process and prevents further trials from starting. New files record
requested and served models, the Codex version, observed MCP tools, transcripts,
grades, and fake-service calls. Historical Claude baselines in `baselines/`
remain readable by the report; the runner no longer starts Claude Code.

Task grades inspect fake service state and calls, rather than trusting the
agent's final answer. Approval prompts for denied MCP tools are declined by
the eval host. A denial test should show both a recorded permission denial and
zero downstream writes; a passing task grade alone does not prove the host
actually rejected an approval request.
