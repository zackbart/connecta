# Native workerd TCP port hardening (#1197, PR #1289)

Landlock restricts destination TCP ports. It does not restrict destination
addresses, UDP, or distinguish simultaneous worlds in the same harness. The
trial-only fake/gateway boundary requested by #1197 remains open. The raw-socket
control asserts both refusal on a disallowed port and successful non-loopback
receipt on an allowed port.

## Validation (2026-11-03, bigserv)

Current main (`f66f3ca7`) and PR head (`d7406f07`) were merged before this fix.
Local Node is v26.13.0. All temporary runtime directories used
`TMPDIR=$HOME/.cache/connecta-runtime-tmp`.

- `pnpm run eval:selftest --workerd-isolation-only`: passes on kernel
  7.0.0-38-generic / Landlock ABI 8, including the allowed-port address limit,
  disallowed-port refusal, fail-closed startup and launcher-crash cleanup.
- `pnpm run test:node test/deployment-shapes.node.test.ts`: 4/4 pass.
- `pnpm run check:static`: passes.
- `pnpm run build`: passes.
- `pnpm run eval:outcomes`: 118/118 pass (Node deployment).
- `pnpm run eval:smoke --no-build`: all eight targets pass: node-template,
  node-fakes, worker-example, worker-fakes, node-quickbooks, worker-quickbooks,
  node-granola, worker-granola.
- `pnpm run eval:selftest --worker-references-only`: **132/132 eligible
  references pass** on native isolated workerd, using the six-tool surface and
  outcome grading. No paid model or external vendor was used. No late-listener
  failure occurred, so no task needed a fixed-port repair. Two tasks cannot
  run on this target, as recorded below. No task was silently omitted.

Bigserv was heavily loaded during verification; CI remains the timing authority.
The full core check was not run in this focused fix round.

The worker batch wrote `eval/results/worker-references-1793734622913.json`.
This table preserves its complete per-task inventory in the PR:

| Task | Result | Reason if not run |
| --- | --- | --- |
| `granola-workspace-journey` | pass |  |
| `quickbooks-accounting-journey` | pass |  |
| `quickbooks-write-journey` | pass |  |
| `cross-connector-join` | pass |  |
| `stale-close-and-summarize` | pass |  |
| `auth-required-recovery` | pass |  |
| `truncated-read-paging` | pass |  |
| `truncated-write-export` | pass |  |
| `p5-trusted-program-write` | pass |  |
| `p5-read-only-program-refusal` | pass |  |
| `p5-result-paging` | pass |  |
| `p5-direct-rich-output` | pass |  |
| `p5-program-image` | pass |  |
| `p5-auth-url-capable` | not-run | the fake OAuth inbound auth, connector and URL-elicitation host are in-process Node objects |
| `p5-auth-connect-incapable` | not-run | the fake OAuth inbound auth, connector and URL-elicitation host are in-process Node objects |
| `p5-fanout-over-budget` | pass |  |
| `p5-revenuecat-text` | pass |  |
| `p5-supabase-project-ref` | pass |  |
| `p5-absent-github` | pass |  |
| `p5-known-read-routing` | pass |  |
| `p5-connecta-read` | pass |  |
| `801-stripe-failed-payment` | pass |  |
| `801-stripe-guessed-parameter-recovery` | pass |  |
| `801-stripe-idempotent-refund` | pass |  |
| `801-cloudflare-dns-ttl` | pass |  |
| `801-cloudflare-pin-refusal` | pass |  |
| `801-cloudflare-read-only-analytics` | pass |  |
| `801-vercel-failed-build` | pass |  |
| `801-vercel-env-value-safety` | pass |  |
| `tithely-fund-totals` | pass |  |
| `tithely-recurring-join` | pass |  |
| `tithely-account-paging` | pass |  |
| `tithely-widget-hatch` | pass |  |
| `tithely-donor-contact` | pass |  |
| `tithely-refund-duplicate` | pass |  |
| `tithely-cancel-recovery` | pass |  |
| `breeze-filtered-people` | pass |  |
| `breeze-attendance-join` | pass |  |
| `breeze-people-paging` | pass |  |
| `breeze-pledge-hatch` | pass |  |
| `breeze-create-once` | pass |  |
| `breeze-update-recovery` | pass |  |
| `breeze-giving-totals` | pass |  |
| `overflow-filtered-gifts` | pass |  |
| `overflow-recurring-join` | pass |  |
| `overflow-donor-paging` | pass |  |
| `overflow-deposit-reconciliation` | pass |  |
| `overflow-tap-hatch` | pass |  |
| `overflow-refund-once` | pass |  |
| `overflow-donor-update-recovery` | pass |  |
| `stripe-step2-scope-balance` | pass |  |
| `stripe-step2-filtered-customers` | pass |  |
| `stripe-step2-decline-join` | pass |  |
| `stripe-step2-customer-paging` | pass |  |
| `stripe-step2-tax-settings` | pass |  |
| `stripe-step2-refund-once` | pass |  |
| `stripe-step2-refund-recovery` | pass |  |
| `vercel-step2-filtered-deployments` | pass |  |
| `vercel-step2-team-project-alias` | pass |  |
| `vercel-step2-deployment-paging` | pass |  |
| `vercel-step2-domain-hatch` | pass |  |
| `vercel-step2-bounded-logs` | pass |  |
| `vercel-step2-env-once` | pass |  |
| `vercel-step2-env-recovery` | pass |  |
| `cloudflare-step2-filtered-dns` | pass |  |
| `cloudflare-step2-account-zone-join` | pass |  |
| `cloudflare-step2-dns-paging` | pass |  |
| `cloudflare-step2-kv-hatch` | pass |  |
| `cloudflare-step2-analytics` | pass |  |
| `cloudflare-step2-purge-once` | pass |  |
| `cloudflare-step2-dns-recovery` | pass |  |
| `ccb-filtered-individuals` | pass |  |
| `ccb-family-group-join` | pass |  |
| `ccb-individual-paging` | pass |  |
| `ccb-advanced-search` | pass |  |
| `ccb-campus-hatch` | pass |  |
| `ccb-update-once` | pass |  |
| `ccb-update-recovery` | pass |  |
| `pco-step2-filtered-people` | pass |  |
| `pco-step2-group-services-join` | pass |  |
| `pco-step2-plan-join` | pass |  |
| `pco-step2-people-paging` | pass |  |
| `pco-step2-merger-hatch` | pass |  |
| `pco-step2-note-once` | pass |  |
| `pco-step2-update-recovery` | pass |  |
| `google-gmail-1` | pass |  |
| `google-gmail-2` | pass |  |
| `google-gmail-3` | pass |  |
| `google-gmail-4` | pass |  |
| `google-gmail-5` | pass |  |
| `google-gmail-6` | pass |  |
| `google-gmail-7` | pass |  |
| `google-drive-1` | pass |  |
| `google-drive-2` | pass |  |
| `google-drive-3` | pass |  |
| `google-drive-4` | pass |  |
| `google-drive-5` | pass |  |
| `google-drive-6` | pass |  |
| `google-drive-7` | pass |  |
| `google-docs-1` | pass |  |
| `google-docs-2` | pass |  |
| `google-docs-3` | pass |  |
| `google-docs-4` | pass |  |
| `google-docs-5` | pass |  |
| `google-docs-6` | pass |  |
| `google-docs-7` | pass |  |
| `google-sheets-1` | pass |  |
| `google-sheets-2` | pass |  |
| `google-sheets-3` | pass |  |
| `google-sheets-4` | pass |  |
| `google-sheets-5` | pass |  |
| `google-sheets-6` | pass |  |
| `google-sheets-7` | pass |  |
| `google-slides-1` | pass |  |
| `google-slides-2` | pass |  |
| `google-slides-3` | pass |  |
| `google-slides-4` | pass |  |
| `google-slides-5` | pass |  |
| `google-slides-6` | pass |  |
| `google-slides-7` | pass |  |
| `google-forms-1` | pass |  |
| `google-forms-2` | pass |  |
| `google-forms-3` | pass |  |
| `google-forms-4` | pass |  |
| `google-forms-5` | pass |  |
| `google-forms-6` | pass |  |
| `google-forms-7` | pass |  |
| `github-filtered-issues` | pass |  |
| `github-repository-pr-join` | pass |  |
| `github-repository-paging` | pass |  |
| `github-contents-hatch` | pass |  |
| `github-release-once` | pass |  |
| `github-merge-once` | pass |  |
| `github-search-recovery` | pass |  |

## Full address isolation: investigation, not implementation

Read-only probes on bigserv (Ubuntu 26.04.1) found:

- `kernel.apparmor_restrict_unprivileged_userns = 1`
- `kernel.unprivileged_userns_clone = 1`
- `user.max_user_namespaces = 209340`
- `/proc/self/attr/current` is `unconfined`.
- `unshare --user --map-root-user --net true` fails writing `uid_map` with
  `Operation not permitted`.
- `ip`, `apparmor_parser`, and passwordless sudo are available.

No sysctl, AppArmor profile, firewall, or interface was changed. Commands below
are proposals for owner approval, not commands executed during this fix.

### Namespace permission

One temporary machine-wide option on bigserv or an Ubuntu CI runner is:

```sh
sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
unshare --user --map-root-user --net sh -c 'ip link set lo up; ip route; ip -6 route'
# Restore after testing (bigserv's observed starting value):
sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=1
```

Prefer an executable-specific AppArmor exception on a shared machine. For
example, install a dedicated copy of unshare with an attached profile, leaving
the global sysctl at 1:

```sh
sudo install -D -m 0755 /usr/bin/unshare /usr/local/libexec/connecta-eval-unshare
sudo tee /etc/apparmor.d/connecta-eval-unshare >/dev/null <<'PROFILE'
abi <abi/4.0>,
include <tunables/global>
profile connecta-eval-unshare /usr/local/libexec/connecta-eval-unshare flags=(unconfined) {
  userns,
}
PROFILE
sudo apparmor_parser -r /etc/apparmor.d/connecta-eval-unshare
/usr/local/libexec/connecta-eval-unshare --user --map-root-user --net \
  sh -c 'ip link set lo up; ip route; ip -6 route'
```

This grants namespace creation to that launcher; it is not itself a network
policy. Check profile loading and namespace creation on the actual host before
using it. GitHub-hosted Ubuntu runners have passwordless sudo, so CI can apply
the temporary sysctl in its disposable VM, or create a privileged network
namespace and drop privileges before starting the harness. CI's current
`ubuntu-latest` label does not guarantee a particular future kernel or policy;
probe it in the job.

### Reaching the gateway

A fresh network namespace has a separate loopback interface and no host routes.
Keeping the harness, gateway, fakes, Wrangler and workerd together inside a
per-trial namespace lets their existing loopback paths work. For scripted
references, a namespace launch after dependency installation/build needs no
external network at all:

```sh
/usr/local/libexec/connecta-eval-unshare --user --map-root-user --net \
  sh -c 'ip link set lo up; exec pnpm run eval:selftest --worker-references-only'
```

That command is an initial feasibility check, not a finished isolation design:
the current runner reuses one harness across trials. The final harness must
create and tear down a namespace per trial and exercise all lifecycle controls.

If the gateway stays on the host, use a pathname Unix socket in a private trial
directory (not an abstract Unix socket, which is namespaced). A Node relay
inside the namespace exposes the gateway on namespace loopback and connects
only to that fixed pathname using `net.connect({path})`; a host HTTP server
listens with `server.listen(socketPath)`. Retain the per-trial gateway token.
Apply the same fixed-target relay arrangement for each fake and for MCP ingress
from an outside model runner. Do not bridge arbitrary TCP destinations or pass
preconnected Internet sockets into workerd. Pathname sockets work across network
namespaces when both processes can access their filesystem path.

For a concrete transport probe (requires `socat`; illustrative host gateway at
127.0.0.1:18081), run the host relay and then the namespace relay in separate
terminals. Stop both after the probe; no part of this was executed here:

```sh
export trial_dir="$HOME/.cache/connecta-runtime-tmp/namespace-probe"
mkdir -m 0700 -p "$trial_dir"
socat UNIX-LISTEN:"$trial_dir/gateway.sock",fork,mode=0600 TCP4:127.0.0.1:18081
```

```sh
export trial_dir="$HOME/.cache/connecta-runtime-tmp/namespace-probe"
/usr/local/libexec/connecta-eval-unshare --user --map-root-user --net sh -c '
  ip link set lo up
  exec socat TCP4-LISTEN:18080,bind=127.0.0.1,reuseaddr,fork UNIX-CONNECT:"$trial_dir/gateway.sock"
'
```

Launch workerd in that same namespace (or launch relay plus workerd from one
namespace wrapper), pointing its gateway URL to `http://127.0.0.1:18080`.
Use a separate fixed-path relay for each fake; add a reverse pathname relay for
MCP ingress. Production integration must own relay PIDs and remove sockets on
every exit path. These commands demonstrate transport only; they do not patch
the current launcher's configuration or implement its lifecycle.

Alternatively, a privileged setup can connect host and trial with veth, e.g.:

```sh
sudo ip netns add connecta-trial
sudo ip link add cta-host type veth peer name cta-trial
sudo ip link set cta-trial netns connecta-trial
sudo ip addr add 192.0.2.1/30 dev cta-host
sudo ip link set cta-host up
sudo ip -n connecta-trial addr add 192.0.2.2/30 dev cta-trial
sudo ip -n connecta-trial link set cta-trial up
sudo ip -n connecta-trial link set lo up
# No default route, NAT or forwarding. Gateway binds only 192.0.2.1.
# After stopping all trial processes:
sudo ip netns del connecta-trial
sudo ip link del cta-host 2>/dev/null || true
```

Veth alone is insufficient: a host-side default-deny firewall must admit only
that trial's gateway/fake address+port tuples, refuse UDP and IPv6 unless
explicitly needed, and block forwarding. Drop CAP_NET_ADMIN and CAP_NET_RAW in
the trial process; otherwise it could change routes or forge traffic. Names,
subnets and firewall ownership need per-trial allocation and failure cleanup.
The Unix socket design avoids host IP exposure and firewall mutation.

Estimate: 2–4 engineering days for per-trial namespaces, gateway/fake/MCP relays,
privilege handling, late-listener support, cleanup, CI wiring and TCP/UDP/IPv6
escape controls; another 1–2 days if supporting both Unix relays and veth or
multiple host policies. This is an estimate, not shipped behavior.

Sources: [Ubuntu namespace restrictions](https://ubuntu.com/blog/ubuntu-23-10-restricted-unprivileged-user-namespaces),
[AppArmor profile syntax](https://manpages.ubuntu.com/manpages/resolute/man5/apparmor.d.5.html),
[GitHub runner privileges](https://docs.github.com/en/actions/reference/runners/github-hosted-runners),
[network namespaces](https://www.man7.org/linux/man-pages/man7/network_namespaces.7.html).
