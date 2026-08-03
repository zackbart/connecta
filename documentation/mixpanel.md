# Mixpanel prebuilt connection

Import `mixpanel()` independently from
`@zackbart/connecta/providers/mixpanel`. It wraps Mixpanel's hosted MCP server
with regional endpoint selection, OAuth by default, a provider-rate admission
budget, a task-oriented usage guide, and a vetted safety classification. It
adds no provider dependency and is not reachable from Connecta's root entry.

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

The wrapper classifies the documented observational tools as reads and the
documented create, update, edit, merge, dismiss, duplicate, and delete tools as
writes. An unfamiliar tool added by the downstream fails closed onto
`call_destructive_tool` until a Connecta release reviews it.

That classification is **fill-in only**. It supplies the annotations Mixpanel
leaves unset and may always tighten one — but it never contradicts an explicit
downstream annotation. A tool on the read allowlist that arrives carrying
`destructiveHint: true` or `readOnlyHint: false` keeps exactly what the
downstream said and stays behind `call_destructive_tool`: the downstream is
telling you this release's allowlist is stale, and the fail-closed invariant
does not bend for a maintained connection. Maintained writes that only create
something new (`Create-Dashboard`, `Create-Cohort`, `Create-Metric`, and the
rest) leave `destructiveHint` unset; `readOnlyHint: false` already routes them
through the destructive path, and asserting destruction only inflates the
approval copy the host shows a human.

Experiments and Feature Flags — 15 of the 63 classified tools — are Mixpanel
beta surfaces. Expect their names and schemas to move faster than the rest.

The connection also declares a per-runtime call-admission budget matching
Mixpanel's documented 600 requests per hour — a best-effort approximation of
the per-user limit, not an enforcement of it. Each runtime keeps its own
counter, so N Worker isolates or Node processes serving one deployment can each
admit up to 600. Discovery traffic is outside connector call admission and
still needs restrained use.
