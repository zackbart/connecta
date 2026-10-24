# Discovery wording follow-ups (#703)

This batch isolates the shared wording/recovery changes from the operation
ranking change. BEFORE uses PR A's clean commit `dc419a296f13` (source tree
`33403b4e86d5`); AFTER uses PR B's clean source commit, recorded below when
the runs finish. Both arms use the standard six-tool surface and route grading.

Five tasks exercise the earlier write declines: Overflow refund-once, Tithe.ly
duplicate refund and committed cancellation recovery, and Stripe partial
refund-once and committed refund recovery. The latter two recovery tasks are
included so the wording cannot gain completions by encouraging blind resends.

Protocol: GPT-6 Luna twice BEFORE and twice AFTER; Claude Sonnet 5.5 once
AFTER. Concurrency is one, timeout eight minutes, Node 24.22.1 on linux-x64.
The BEFORE runner is Codex CLI 0.163.0. The task-definition hash is
`60797c5f6708245c8fbb8b25a3432c7c6ae52e56bca1aa124768be734b9721cd` and
harness hash is
`69e2e4b80c40ae2eb09dad08600f603b9ecddd45e62160ba2348df2388f6c8b0`.
The same fixed prompts, graders, fake state and fakes run in each arm.

Only neutral fake credentials are used. Overflow uses its existing random-looking
sentinels, Stripe mints a fresh UUID key per fake world, and Tithe.ly uses its
existing synthetic key pair. No provider account or real credential is used.

| Task | Luna BEFORE | Luna AFTER | Sonnet AFTER |
| --- | ---: | ---: | ---: |
| overflow-refund-once | 2/2 | pending | pending |
| tithely-refund-duplicate | 2/2 | pending | pending |
| tithely-cancel-recovery | 2/2 | pending | pending |
| stripe-step2-refund-once | 2/2 | pending | pending |
| stripe-step2-refund-recovery | 2/2 | pending | pending |

All ten fresh BEFORE trials passed. This small batch therefore starts at a
ceiling; it cannot establish an accuracy gain or attribute an effect to any
single sentence. Historical declines motivated the tasks and are not substituted
for this fresh comparator. AFTER runs and trace audit remain planned at this
checkpoint; no AFTER outcome is claimed here.

Raw fake-only evidence and logs are retained under
`/home/zackbart/.t3/scratch/connecta-orchestrator/discovery-followups/`:
`before-luna.json`, `after-luna.json` and `after-sonnet.json`, with their runner
logs and offline regrades. The final notes record scores, completion failures,
write counts, authorization/decline observations and discovery bytes.
