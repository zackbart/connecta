# Mixpanel REST review

The nine-operation service-account subset and its safety verdicts are unchanged
from the 2026-10-14 review. `openapi.document.json` is the byte-identical former
`contracts.fixture.json`: the reviewed JSON conversion combines Query, Export,
Import and the schema-less service-account identity read. `openapi.json` retains
the original Query YAML URL and digest; its vendored document digest is recorded
separately in the generated index and drift evidence. Export, ingestion and
service-account YAML pins remain manual checks because their YAML sources are
not parsed by the JSON drift tooling. The endpoint check records the converted
contracts offline and links each row to its verified public reference page.

## Authentication and region

The API uses ordinary UTF-8 HTTP Basic for `username:secret`, with the existing
"Mixpanel service account" credential label. The former hosted MCP's
`Bearer Basic` framing and label remain documented in the hosted migration
guide; this provider still refuses construction without `via: "api"`.

Every connection fixes its US, EU or India query/app, export and ingestion
origins at construction. The operation's pinned server selects a confined kit
connection; arguments cannot supply an origin or widen the operation subset.
The account read is unscoped; other calls fill an omitted `project_id` from the
deployment default and allow an explicit granted project exactly as before.

## Reads, writes and values

`POST /api/query/engage` queries existing profiles and remains a reviewed read.
`POST /import` remains an additive write, with its existing validation and one
construction-declared write step. No API operation or hosted classification is
added. In particular, Get-Experiment remains outside this API subset and the
migration guide keeps its non-read warning for persisted compute results and
auto-conclusion.

Bounded export uses the kit's success prefix and applies whole sent-secret
redaction before splitting JSONL and the existing recursive safety review before
projection. Its legacy failure path uses status only and acquires then closes
the response stream's scope to cancel an error body without waiting for data.
All other replies preserve their Content-Type-based JSON, text, JSONL and binary
handling through the kit's reviewed body policies. Error mapping uses bounded
status facts and never vendor error prose. The existing safety table and guide
bytes remain unchanged.

The public service-account identity response has no schema, and analytics
properties are open user data. Existing recursive credential-name and bearer-URL
redaction continues to cover those values. Report dimension `headers` remains
reviewed as ordinary data rather than authentication material.
