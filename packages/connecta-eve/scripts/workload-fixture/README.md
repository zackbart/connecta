# Disposable workload validation (contributor recipe)

This reuses the small endpoint, proof and local RSA/JWKS runner from the original
workload validation. It adds Eve 0.84 instruction evaluation, a real SDK audience
exchange, and correlated cancellation receipts. It is a fixture, not another
supported deployment template. No cloud action belongs to local preparation.

## Prepare locally

On Node 24, after installing dependencies and building the core and helper:

```sh
node packages/connecta-eve/scripts/prepare-workload.mjs --output /absolute/path/outside/checkout/assistant-proof
cd /absolute/path/outside/checkout/assistant-proof
pnpm install --frozen-lockfile --ignore-scripts
pnpm run check
```

The output directory must not exist. The command packs the built packages,
installs those archives with real Eve 0.84.0, `@vercel/oidc` 4.0.3 and
`@vercel/functions` 3.10.3, and applies Eve's undici 8.12.3 override plus Zod
4.6.6 for `@vercel/cli-config` 0.3.3's older pin. Audit the generated consumer
with `pnpm audit --audit-level moderate` before approving a live deployment. Preserve
`provenance.json`, the archives, dependency lockfile and `local-results.json`.
Record the source commit, any dirty paths, Node/pnpm versions and every file hash.
After a package or source change, prepare a new directory; never overwrite old
evidence. The separate catalog probe owns real-Eve turns and catalog measurements.
This fixture evaluates the helper with Eve's public interfaces; its local HTTP
and issuance are substituted and do not prove Vercel behavior.

## Review the live plan before authorization

Name the exact Vercel account and one new disposable project. Obtain owner
authorization for that project, at most two deployment attempts, one proof
invocation, a total of at most 20 client-initiated function invocations, one token
exchange, a $1 incremental ceiling, and cleanup in the same session. The normal
path uses 16 function invocations: `/proof`, discovery, eight endpoint controls,
cancellation, a fresh read and four concurrent reads. Do not attach storage,
databases, production connectors, paid models, custom domains or repository
deployment hooks. Use one region, Fluid compute with the standard 2 GiB memory
preset, a 30-second function limit and the standard build machine. Verify the
project's `resourceConfig` reports `fluid: true`, `functionDefaultMemoryType:
"standard"`, `functionDefaultRegions: ["iad1"]`, `functionDefaultTimeout: 30`
and `functionZeroConfigFailover: false` before adding secrets or deploying,
and again before invoking the proof. Refuse an absent or different setting.
With Fluid enabled, `vercel.json` cannot set memory; the project preset owns it.
See [function memory](https://vercel.com/docs/functions/configuring-functions/memory)
and [project resource configuration](https://vercel.com/docs/rest-api/projects/update-an-existing-project).
Bound the project lifetime to 30 minutes.

All account commands must explicitly select the reviewed team, for example
`vercel ... --scope example-team`. Verify the returned immutable account ID
before any mutation. Create a fresh project, retain its default deployment
protection, and use an automation bypass confined to this disposable project.
Select team-mode OIDC on this new project. Do not change team-wide settings.
Refuse a reused project name or any unexpected account/project IDs.

The runner supplies these deployment environment variables:

| Variable             | Value                                  |
| -------------------- | -------------------------------------- |
| `PROOF_TEAM_ID`      | Reviewed immutable team ID             |
| `PROOF_PROJECT_ID`   | Newly created immutable project ID     |
| `PROOF_OWNER_SLUG`   | Reviewed team slug                     |
| `PROOF_PROJECT_NAME` | Newly created project name             |
| `PROOF_RUN_ID`       | Unique non-secret correlation ID       |
| `PROOF_RUN_KEY`      | Random, project-only invocation secret |
| `PROOF_BYPASS_KEY`   | Project-only automation bypass secret  |

Never print or persist either secret or a workload token. Configure secrets
through structured input in memory. Capture CLI output privately and retain only
allowlisted IDs, statuses and counts. Deploy the prepared directory with its
frozen lockfile and install scripts disabled. `includeFiles` retains Eve's pinned
package-import targets; `supportsCancellation` enables platform cancellation.
POST `/proof` once with `x-proof-key` and `x-vercel-protection-bypass` in memory.
Do not retry an invocation after an ambiguous outcome.

## Classify evidence precisely

The proof independently verifies each original/exchanged token signature with
Web Crypto against Vercel's public JWKS, then sends it to the actual installed
Connecta endpoint. A 401 by itself is not signature evidence.

| Control                                                      | Evidence and limit                                                                                                                                                                                                                  |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ordinary production token                                    | Positive admission, guidance and exact fixture reads                                                                                                                                                                                |
| Same signed token, changed receiver team/project/environment | Binding rejection; not an independent issuer or audience permutation                                                                                                                                                                |
| SDK custom-audience exchange                                 | Independently verified signature; same issuer, subject, owner, project, environment and expiry; 401 at the unchanged receiver. Exchange may update `iat` and add `act`; record changed claim **names**, never values                |
| Independent inconsistent issuer                              | Unavailable through documented Vercel issuance: team issuer must match owner; global issuer is also accepted. A second issuer mode is not a rejection control. Keep the ephemeral locally signed inconsistent-issuer check separate |
| Another deployment of the same project/environment           | Permitted by contract. Deployment ID is provenance, not an admission binding                                                                                                                                                        |
| Edited claims or signature                                   | Tampering controls only; preserve earlier observations without relabeling them                                                                                                                                                      |

The audience exchange is supported by the pinned SDK and Vercel's
[custom-audience service](https://vercel.com/changelog/custom-oidc-token-audiences).
If issuance or independent signature verification fails, report the live control
as unproven; do not substitute an edited token. A different team's token changes
owner/audience/subject/team together, so it cannot isolate the issuer check.

## Retain cancellation before cleanup

The cancellation route forwards the original platform `Request` to Connecta.
It sends a start handshake only after the fixture handler starts. The client
reads that handshake, then aborts. No response-reader hook or app cleanup
manufactures the handler's abort. `waitUntil` retains the pending handler and
app cleanup so they can emit payload-free receipts after client disconnection,
as required by [Vercel cancellation guidance](https://vercel.com/docs/functions/functions-api-reference#cancel-requests).

After `/proof` returns, query runtime logs for the exact project and deployment
in at most twelve bounded reads over one minute. Parse JSON in memory and retain
only receipts with the exact `event: workload-proof`, run ID, deployment ID,
stage, boolean `signalAborted`, numeric `at`, sequence number and Node version. Require ordered
`handler-started` (false), `handler-cancelled` (true), `app-closed` (true), with no
`handler-completed`. Save and flush the sanitized receipts plus aggregate result
outside the checkout **before deleting resources**. Only that combined evidence
may set `liveServerCancellationProven: true`; the endpoint deliberately returns
false until the collector verifies it. Client abort and a later read alone do
not establish server cancellation.

If receipts do not arrive within the bound, retain a failed/incomplete result
and perform cleanup anyway within the authorized lifetime. Evidence open, write
or flush errors must not prevent cleanup; put deletion in an unconditional
`finally`, and retain sanitized evidence-failure facts when possible. Do not claim proof
or keep resources running indefinitely. Logs are a delivery dependency, not a
durable database: success requires an actual retained receipt, not an assumption.

Delete the disposable project and all its deployments, environment secrets and
automation bypass. Verify the project and deployment lookups return not-found;
retain those cleanup statuses. Overall success requires both not-found results,
no evidence or cleanup errors, and the authorized lifetime bound. On failure, record exact remaining IDs for owner
cleanup. Remove local linkage and private temporary files, retain sanitized
source/package hashes, versions, result and cleanup receipts, and keep the
original evidence unchanged. The fixture has no operational data to undo.
