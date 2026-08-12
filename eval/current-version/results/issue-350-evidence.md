# Does each Cloudflare named tool earn its place? (#350)

Cloudflare shipped 51 named tools above three raw escape hatches that already
reach every v4 endpoint. Each named tool is a bet that its schema, projection,
and ergonomics save an agent more than its permanent catalog weight and its
maintenance cost. This is the audit of that bet.

It is deliberately not the provider-conventions audit
([#342](https://github.com/zackbart/connecta/issues/342)). That one asks
whether a tool is *well formed*; this one asks whether the tool should exist at
all. Where the measurement below finds a convention miss on a tool that clearly
earns its place, the verdict is `improve` and the fix is handed to #342 rather
than done twice.

**Outcome: 30 keep, 18 improve, 3 prune.** The three removals —
`get_r2_metrics`, `set_r2_cors`, `delete_r2_cors` — are a breaking change in
0.16.0. The surviving surface is 48 named tools.

## The measurement

`eval/current-version/cloudflare-surface-report.ts`, one representative
operator request per named tool in
[`cloudflare-surface-tasks.json`](../cloudflare-surface-tasks.json):

```sh
npm --prefix eval/current-version run report:cloudflare-surface
```

Pre-audit artifacts (the 55-tool surface at commit `297f0b9`, before this
change):
[`issue-350-cloudflare-surface-preaudit.json`](./issue-350-cloudflare-surface-preaudit.json)
and [`.md`](./issue-350-cloudflare-surface-preaudit.md). The post-change run is
[`issue-350-cloudflare-surface.json`](./issue-350-cloudflare-surface.json) and
[`.md`](./issue-350-cloudflare-surface.md). Every number in this document is
from the pre-audit run unless it says otherwise.

The lane is deterministic and runs entirely inside the process. Nothing in the
provider is stubbed: the real constructor, the real hand-written schemas, the
real `api()` validation path with `strictValidation`, the real handlers, and
the real `CatalogService` produce every number. Only `fetch` is a probe, and it
records the request the provider built. No credential, no packet, no account.
The connector is measured unscoped — no `zoneId`, no `accountId` — because that
is what a fresh deployment gets and it is the harder case.

Four costs, the four from
[`documentation/provider-conventions.md`](../../../documentation/provider-conventions.md):

| Cost | How this lane measures it |
| --- | --- |
| discovery tokens | the exact per-entry payload `search_tools` emits with compact schemas, tokenized one tool at a time |
| wrong-tool selection | the tool's rank in a real `search_tools` call for its own task, against the connector's whole catalog |
| argument retries | four classes of argument mistake per tool, scored on whether the refusal happened locally or at Cloudflare |
| result size | the provider's object goes down carrying known noise keys; the lane records what came back |

## What it found

**Discovery.** The whole connector browses at **8,511 tokens** with compact
schemas; the named surface is 7,683 of that and the three hatches are 678. The
median named tool costs **129 tokens** and a single search for one task returns
a median of 1,173. Four tools carry a fifth of the named weight —
`list_dns_records` (443), `create_dns_record` (376), `update_dns_record` (371),
`get_dns_record` (257) — which is Cloudflare's 21-value record-type enum being
honest, not waste. No compact schema was truncated by the renderer.

**Selection.** Top-1 **52.9%**, top-3 78.4%. That is the number this lane most
wants misread. It is not "half the tools are unfindable": most misses are a
sibling in the same product family ranking first — `create_dns_record` above
`list_dns_records`, `get_kv_namespace` above `delete_kv_namespace` — which
costs an agent a glance, not a wrong call. The misses worth naming are the five
where an *escape hatch* outranked the named tool (`list_zone_settings`,
`update_zone_setting`, `delete_worker_script`, `get_r2_metrics`, `set_r2_cors`)
and the one vocabulary collision worth a fix: the Pages domain tools outrank
`list_zones` for "find the id for the domain example.com", because "domain" is
Pages vocabulary in this catalog and zone vocabulary everywhere else.

**Arguments.** 125 probes across 51 tools — an unknown property (51), a missing
required argument (49), an unknown enum value (16), a page size over the
documented maximum (9). **All 125 were refused locally as `invalid_args`, with
zero requests reaching Cloudflare.** This is the one thing every named tool
does that no escape hatch can: the hatch's path is an opaque string, so it can
only validate that a path is a path. It is also why "the hatch already reaches
this endpoint" is never on its own a reason to prune.

**Results.** 29 tools project (dropping 65–98% of the probe's object), 11
return a fixed confirmation shape, and **11 return Cloudflare's object
untouched**. `list_zone_settings` is the sharpest of those: it *grew* the
payload by 22.7%, wrapping an unprojected settings array in a page object. 19
named tools declare no output keys at all, so a program cannot know the shape
without calling first.

## The activity half, which is missing

The issue asks for real payload-free activity addresses where deployments
provide them. **None were provided, so there is no usage evidence in this
report.** Connecta's activity events are payload-free by construction and do
record tool-selection frequency, so this is exactly the evidence a live
deployment could contribute — it simply was not available here.

That absence sets the bar rather than lowering it. Every verdict below rests on
measured surface properties, and no tool was pruned for being *unused*, because
nothing here can know that. Pruning on measurement alone means pruning only
where the tool is measurably weaker than the route that replaces it.

## How a verdict was assigned

- **prune** — the tool adds nothing over the escape hatch except the path, *and*
  the measurement shows a defect the hatch does not have. Both halves are
  required.
- **improve** — the tool earns its place, but a measured miss is real: it
  returns the provider's object unprojected, or declares no output keys. The
  fix is H8/H9 convention work and belongs to
  [#342](https://github.com/zackbart/connecta/issues/342).
- **keep** — measured clean: it projects or returns a fixed confirmation, it
  declares output keys, and it refused every argument mistake locally.

Selection rank never decides a verdict on its own. A query is written by a
human, and pruning a tool because a sibling outranked it would delete a
capability to fix a ranking.

## Verdicts

| tool | verdict | compact tokens | selection rank | result | output keys |
| --- | --- | --- | --- | --- | --- |
| `list_accounts` | **keep** | 162 | 1 | projected −68.5% | 2 |
| `list_zones` | **keep** | 228 | 4 | projected −65.1% | 2 |
| `get_zone` | **keep** | 165 | 1 | projected −87.5% | 11 |
| `list_zone_settings` | **improve** | 127 | miss (add_pages_domain) | passthrough | 2 |
| `get_zone_setting` | **improve** | 103 | 1 | passthrough | 0 |
| `update_zone_setting` | **improve** | 114 | miss (get_zone_setting) | passthrough | 0 |
| `list_zone_rulesets` | **keep** | 122 | 1 | projected −88.2% | 2 |
| `get_zone_ruleset` | **improve** | 97 | 1 | projected −91.6% | 0 |
| `list_dns_records` | **keep** | 443 | 2 | projected −68.7% | 2 |
| `get_dns_record` | **keep** | 257 | 1 | projected −91.6% | 11 |
| `list_worker_scripts` | **keep** | 145 | 1 | projected −73.2% | 2 |
| `get_worker_settings` | **improve** | 98 | 1 | passthrough | 0 |
| `list_worker_deployments` | **keep** | 136 | 1 | projected −92.1% | 2 |
| `get_worker_deployment` | **improve** | 95 | 1 | projected −96.1% | 0 |
| `delete_worker_script` | **keep** | 129 | 6 | fixed confirmation | 2 |
| `list_kv_namespaces` | **keep** | 160 | 1 | projected −67.6% | 2 |
| `get_kv_namespace` | **improve** | 82 | 1 | projected −91.1% | 0 |
| `create_kv_namespace` | **improve** | 84 | 2 | projected −91.1% | 0 |
| `rename_kv_namespace` | **improve** | 108 | 3 | passthrough | 0 |
| `delete_kv_namespace` | **keep** | 120 | 4 | fixed confirmation | 2 |
| `list_kv_keys` | **keep** | 126 | 1 | projected −92.7% | 2 |
| `bulk_get_kv_values` | **improve** | 136 | 1 | passthrough | 0 |
| `bulk_write_kv_values` | **improve** | 151 | 1 | passthrough | 0 |
| `bulk_delete_kv_values` | **improve** | 110 | 3 | passthrough | 0 |
| `list_r2_buckets` | **keep** | 166 | 1 | projected −98.5% | 2 |
| `get_r2_bucket` | **keep** | 149 | 1 | projected −95.2% | 5 |
| `create_r2_bucket` | **keep** | 204 | 2 | projected −95.2% | 5 |
| `update_r2_bucket` | **keep** | 180 | 3 | projected −95.2% | 5 |
| `delete_r2_bucket` | **keep** | 146 | 2 | fixed confirmation | 2 |
| `list_r2_objects` | **keep** | 211 | 1 | projected −88.4% | 4 |
| `delete_r2_object` | **keep** | 149 | 1 | fixed confirmation | 2 |
| `get_r2_metrics` | **prune** | 82 | 5 | passthrough | 0 |
| `get_r2_cors` | **improve** | 108 | 1 | passthrough | 0 |
| `set_r2_cors` | **prune** | 139 | miss (cloudflare_api_upload) | passthrough | 0 |
| `delete_r2_cors` | **prune** | 130 | miss (get_r2_cors) | fixed confirmation | 1 |
| `list_pages_projects` | **keep** | 187 | 1 | projected −72.1% | 2 |
| `get_pages_project` | **improve** | 96 | 2 | projected −95.2% | 0 |
| `list_pages_deployments` | **keep** | 156 | 7 | projected −72.3% | 2 |
| `get_pages_deployment` | **improve** | 109 | 1 | projected −96.1% | 0 |
| `retry_pages_deployment` | **improve** | 107 | 2 | projected −96.1% | 0 |
| `rollback_pages_deployment` | **improve** | 114 | 2 | projected −96.1% | 0 |
| `delete_pages_deployment` | **keep** | 129 | 1 | fixed confirmation | 2 |
| `list_pages_domains` | **keep** | 129 | 1 | projected −84.4% | 2 |
| `add_pages_domain` | **improve** | 103 | 1 | projected −87.5% | 0 |
| `delete_pages_domain` | **keep** | 118 | 1 | fixed confirmation | 2 |
| `purge_pages_build_cache` | **keep** | 119 | 1 | fixed confirmation | 1 |
| `delete_pages_project` | **keep** | 118 | miss (list_pages_projects) | fixed confirmation | 2 |
| `create_dns_record` | **keep** | 376 | 2 | projected −91.6% | 11 |
| `update_dns_record` | **keep** | 371 | 2 | projected −91.6% | 11 |
| `delete_dns_record` | **keep** | 122 | 4 | fixed confirmation | 2 |
| `purge_cache` | **keep** | 167 | 2 | fixed confirmation | 3 |

## The three removals, and why

**`get_r2_metrics`** — its entire input is an account id that goes straight into
the path; it declares no output keys; it returns Cloudflare's metrics object
untouched; and search ranked it fifth for its own task, behind
`list_r2_objects`, with `cloudflare_api_get` above it. Everything it does is
`cloudflare_api_get { path: "/accounts/{accountId}/r2/metrics" }`, and it
charged every deployment 82 catalog tokens forever to not have to know that
path.

**`set_r2_cors`** — the decisive one. Its `rules` array declared
`items: { type: "object", additionalProperties: true }`: the free-form body this
connection explicitly refuses elsewhere. The provider already made this call for
structured-data DNS records — those are readable through named tools but not
creatable, because "supporting the rest would mean a free-form `data`
passthrough, the untyped `{}` this connection exists to avoid." So the schema
validated the ids and waved through the part of the call that actually fails,
which means it did not beat `cloudflare_api_mutate` on argument retries; it
returned the result unprojected, so it did not beat it on result size; and it is
destructive either way, so it did not beat it on safety routing. Search agreed:
for its own task, `cloudflare_api_upload` ranked first and `set_r2_cors` did not
place at all.

**`delete_r2_cors`** — the other half of the same policy pair. With the write
gone, keeping the delete would leave the guide explaining why one half of CORS
management is named and the other is not. Its own task ranked `get_r2_cors`
first and it did not place. Reading a policy stays named; changing one takes the
approval-gated raw route, exactly as structured DNS data already does.

No capability was lost. `get_r2_cors` still reads the policy, and the usage
guide now names the replacement routes explicitly:
`cloudflare_api_mutate` with `PUT` or
`DELETE /accounts/{accountId}/r2/buckets/{bucketName}/cors`, and
`cloudflare_api_get` at `/accounts/{accountId}/r2/metrics`.
`test/cloudflare-provider.test.ts` pins the absence, the surviving read, the
guide lines, and the raw route.

## After

Re-running the lane against the shipped surface: 48 named tools, **8,162
tokens** to browse the connector (−349), top-1 selection 54.2% and top-3 83.3%.
Read that improvement honestly — it is mostly arithmetic, since all three
removed tools were themselves selection misses. One unrelated rank moved
(`list_pages_projects`, 1 → 2 behind `list_accounts`), because removing tools
changes the lexical corpus statistics every other query is scored against. That
is a real property of the ranker worth knowing: a curated catalog's selection
behavior is not the sum of its tools.

## What this cannot tell you

- **No usage data.** See above. A deployment that shares payload-free activity
  turns several `improve` rows into a stronger keep-or-prune argument than
  anything measurable here.
- **The queries are authored.** Fifty-one operator-language requests written by
  one author decide every selection number. They were written without looking at
  the tool's own wording, but that is a discipline, not a control.
- **Projection is detected, not sized.** The probe carries known identity and
  noise keys, so "projected", "passthrough", and "fixed confirmation" are solid
  readings — but the percentages are reductions against that probe, not against
  a real R2 or Pages payload. Hand-writing a faithful fat response for every
  Cloudflare product family would have measured this harness's imagination.
- **No model in the loop.** Selection here is the ranking a model's
  `search_tools` call actually runs. What a model then does with the ranked list
  is the reference-connection lane's question, and it is unchanged by this work.
