# Mixpanel prebuilt connection

Import `mixpanel()` independently from
`@zackbart/connecta/providers/mixpanel`. It wraps Mixpanel's hosted MCP server
with regional endpoint selection, OAuth by default, a task-oriented usage
guide, and a vetted safety classification. It adds no provider dependency and
is not reachable from Connecta's root entry.

```ts
import { mixpanel } from "@zackbart/connecta/providers/mixpanel";

const analytics = mixpanel("product_analytics", {
  title: "Production product analytics",
  purpose: "Product and growth decisions for the production app",
  region: "us",
  instructions: "Use the Core Product project unless the request says otherwise.",
});
```

The `id` owns the ordinary connector namespaces; use a different id for every
Mixpanel account. `purpose` is required because an agent choosing between two
instances needs to know which account answers the question. Account
`instructions` are appended to the maintained guide and cannot change the
connector's safety classification.

`region` accepts `"us"` (the default), `"eu"`, or `"in"` and selects the
corresponding [official hosted endpoint](https://docs.mixpanel.com/docs/mcp#mcp-server-urls).
A project lives in exactly one residency, so the region also decides what this
connection can see at all: a question pointed at the wrong one comes back empty
rather than wrong, which reads as the project having no data. That makes it a
routing fact, so it rides the default `title` (`Mixpanel (us)`, `Mixpanel
(eu)`, `Mixpanel (in)`) and opens the usage guide — `search_tools` renders a
connector's title and guide summary and never its description.
OAuth is the recommended default and keeps each connector instance's flow and
tokens in its connector-scoped storage. Mixpanel service accounts are also
supported with an explicit header override:

```ts
mixpanel("automation_analytics", {
  purpose: "Headless release-health reporting",
  auth: {
    type: "headers",
    headers: { Authorization: `Bearer Basic ${env.MIXPANEL_SA_TOKEN}` },
  },
});
```

Keep that encoded service-account value in the runtime's secret store; it is a
password, not ordinary configuration. Mixpanel currently labels service-account
MCP authentication beta. Prefer OAuth unless the deployment is intentionally
headless.

The same service account can arrive from `/credentials` instead, and there the
operator pastes the readable pair rather than an encoded blob:

```ts
mixpanel("automation_analytics", {
  purpose: "Headless release-health reporting",
  auth: { type: "credential" },
});
```

The slot renders as "Service account" and takes `username:secret`. Connecta
base64-encodes it and sends Mixpanel's documented `Bearer Basic` framing, so the
operator never has to encode anything by hand. **The two paths take different
strings:** the `headers` example above wants the already-encoded blob
(`echo -n "username:secret" | base64`), and this one wants the plaintext pair.
Migrating from one to the other means decoding, not copying. Until a value is
saved the connector is present and reports `auth_required`. See
[storage and credentials](./storage-and-credentials.md#a-remote-mcp-connectors-static-credential).

## Conditional input contracts

Mixpanel's hosted descriptions enforce three cross-field conditions that its
input schemas do not encode. Connecta preserves those schemas unchanged under
[P1](./provider-conventions.md#p1--normalize-by-adding-never-by-rewriting), so
the maintained guide carries the missing call guidance:

- `Get-Business-Context` requires `project_id` or `organization_id`.
- `Get-Property-Values` requires `properties` or the deprecated `property`
  alias. Event property values also require `event`.
- `List-Properties` accepts `names` or `query`, never both.

A read-only live audit on 2026-08-13 confirmed all three refusals against the
US hosted endpoint. They are reported upstream as
[`mixpanel/mixpanel-headless#202`](https://github.com/mixpanel/mixpanel-headless/issues/202).
The vetted catalog records current schema digests for all 64 tools,
so a later schema correction or regression increments runtime drift when an
ordinary catalog refresh observes it. The live definition is still served
unchanged. The credential-free provider check does not depend on those digests.
The guide can shrink when the downstream schema becomes complete; Connecta does
not absorb the defect permanently.

The wrapper classifies the documented observational tools as reads and the
documented create, update, edit, merge, dismiss, duplicate, and delete tools as
writes. An unfamiliar tool the downstream leaves unannotated fails closed onto
`call_destructive_tool` until a Connecta release reviews it.

That classification fills in downstream silence and otherwise preserves
explicit annotations. A tool on the read allowlist arriving with
`destructiveHint: true` or `readOnlyHint: false` keeps exactly what the
downstream said and stays behind `call_destructive_tool`. A tool on neither
maintained list arriving with `readOnlyHint: true` keeps that too, and stays
callable from `execute_code`. Both are the downstream telling you this
release's allowlist is stale, and on a name no release has reviewed its word is
the only evidence there is. One narrow fail-closed exception applies to a name
this release reviewed and filed destructive: a `Delete-Dashboard` claiming
`readOnlyHint: true` is a downstream bug rather than news, and stays on the
approval path. Maintained writes that only create
something new (`Create-Dashboard`, `Create-Cohort`, `Create-Metric`, and the
rest) leave `destructiveHint` unset; `readOnlyHint: false` already routes them
through the destructive path, and asserting destruction only inflates the
approval copy the host shows a human.

Experiments and Feature Flags are Mixpanel beta surfaces. Their three changed
schemas were reviewed again on 2026-08-30. The same review added
`Fill-Event-Metadata` as a destructive write because it applies generated names
and descriptions to existing Lexicon events.

## Rate limits

Mixpanel meters its MCP server **per user per hour**, shared with everything
else that credential does. Connecta's counter is per runtime, not per user, and
the two cannot be reconciled in either direction: one runtime serving several
users under-counts, and several Worker isolates or Node processes sharing one
credential each admit a full budget. A hardcoded ceiling would therefore either
throttle a healthy deployment or fail to protect a busy one, so this connection
declares **no call-admission budget by default**. An operator who knows the
account can supply one explicitly:

```ts
mixpanel("product_analytics", {
  purpose: "Product and growth decisions for the production app",
  callAdmission: {
    rules: [
      { budget: { kind: "rolling-window", maxCalls: 300, windowMs: 3_600_000 } },
    ],
  },
});
```

A budget-only rule needs no queue. If you add `maxConcurrency` you are asking
for a queue, and the admission controller then requires the rest of the queue
settings at construction. Discovery traffic is outside connector call admission
either way and still needs restrained use.

## Public contract check

`npm run drift:check -- --docs --provider mixpanel` compares Mixpanel's
official Available Tools table with the vetted manifest and checks all three
regional endpoints plus OAuth support. The current table lists 63 tools. It
omits `Fill-Event-Metadata`, which remains classified from the last
authenticated review and is reported as `not documented`, not silently removed.

## Conventions

This connection is audited against
[the provider conventions](./provider-conventions.md). Its verdict per
convention, including every recorded exception, is the Mixpanel section of
[the provider audit](https://github.com/zackbart/connecta/blob/main/records/provider-audit.md).
