---
{
  "name": "revenuecat",
  "instructionsHeading": "Project instructions"
}
---

<!-- fragment: guide_0 -->

- Inspect result framing before accessing fields. A text result is not automatically an object; parse it only if the returned text is valid JSON. Do not iterate fields that the response does not contain.
- Resolve ids before acting; never guess one. `list-projects` yields the `project_id` every project-scoped call takes. `list-apps`, `list-products`, `list-entitlements`, `list-offerings`, `list-paywalls`, `list-audiences`, and `list-customers` yield the ids their `get-`, `update-`, `archive-`, and `delete-` counterparts expect. A plausible-looking id belongs to another project or to nobody.
- Customers are addressed by the app user id your SDK set, not by an internal key. Find one with `list-customers` before `get-customer`, and carry the id it returned unchanged.
- Customer and subscription objects are large, and a customer's history is larger. Page with the cursor the list returned rather than raising the page size, and reduce inside `execute_code` — select the fields the question needs and return those, not the whole object.
- Whether a customer should have access is `gives_access` on each subscription from `list-subscriptions`, which RevenueCat calls the authoritative flag. `status` and `expires_date` describe the store-side state and disagree with it during grace periods, billing retries, and promotional grants — answer access questions from `gives_access` and say which subscription it came from.
- `get-chart-data` is the metrics path: read `get-chart-options-schema` for the chart you want before calling it, rather than guessing an option name. `get-overview-metrics` and `get-revenue-metric` answer the summary questions in one call.
- `create-paywall-ai` and `edit-paywall-ai` are asynchronous. Poll the task id they return with `get-paywall-ai-task` rather than assuming the work finished when the call returned.
- The documented `get-product-store-state-operation`, `create-product-prices`, `equalize-subscription-prices`, `set-product-store-state`, and `upload-product-store-state-screenshot` tools are deprecated; they remain supported when the server exposes them. Store changes use the plan workflow: `create-product-store-state-plan`, then `plan-product-store-state-plan`, then `apply-product-store-state-plan`. Every step past the create is asynchronous — read the plan back with `get-product-store-state-plan` between steps instead of assuming the last one finished.
- This connection's tool list is not a fixed set. The reviewed catalog is a superset, not a promise that every reviewed tool is available. RevenueCat gates parts of its MCP catalog by API key permissions, plan, platform, and beta enrollment — paywall AI editing, benchmarks, experiments, virtual currencies, and the account-billing tools are the usual absentees — so search this connector for what it actually exposes rather than assuming a documented tool is here.
- `list-app-subscription-groups`, `preview-audience`, and `render-paywall-screenshot` are reviewed reads. Audience preview uses an observational POST that returns matching customers without creating an audience; screenshot rendering previews a paywall without editing or publishing it.
- `validate-app-credentials` stays classified as write conservatively: the MCP reference labels it Read and says credentials are unchanged, but the live annotation says otherwise and the public API v2 app contract does not establish whether validation status or results persist. Do not infer permission to call it from its presence under a read-only API key.
- RevenueCat meters API v2 per minute and per domain, and the domains differ: 480 requests per minute for customer information and virtual currencies, 60 for project configuration and audiences, 25 for charts and metrics. It answers a breach with `429`, a `Retry-After` header, and a `backoff_ms` field. Back off on that rather than retrying immediately, and expect chart sweeps to hit the ceiling long before customer reads do.
- Use discovery's effective classification for routing rather than inferring safety from a name or HTTP method. Creates, updates, archives, grants, publishes, and store changes are writes; audience previews and screenshot rendering are reads. For guest calls, classification, and routing, fetch `skills({ name: "usage" })`.
- An `auth_required` failure means this connector's RevenueCat authorization is missing or expired: run `authorize_connector` for this connector id, then retry the same call unchanged. A rejected argument, a permission gap, or a plan restriction comes back in RevenueCat's own words instead — read it rather than re-authorizing.
<!-- endfragment -->

<!-- fragment: guide_1 -->
# RevenueCat usage

Account-scoped connection: this OAuth session reaches every RevenueCat project the account can see. Connector purpose: <!-- endfragment -->

<!-- fragment: guide_2 -->


Call `list-projects` first and carry the exact `project_id` it returned into every project-scoped call. Connecta does not pick a project, and the connector id, title, and purpose are routing hints rather than proof of which project a call will land in. If more than one project fits the request, stop and ask; never guess a `project_id`.
<!-- endfragment -->

<!-- fragment: guide_3 -->
. RevenueCat secret API keys are project-wide, so this key reaches exactly one project and nothing outside it. A second project is a second connector with its own key and its own id — never a `project_id` argument pointed somewhere else.

Confirm the project on first use: `list-projects` returns the one project this key can see, and its `project_id` is the one every project-scoped call takes. An empty or unexpected result means wrong connector, not missing data.

A RevenueCat secret key has per-resource permissions. RevenueCat can omit tools this key cannot use from its live catalog; Connecta serves the returned catalog rather than adding missing tools from its reviewed superset. Catalog presence alone does not prove a call is permitted. A served tool can still fail at RevenueCat for missing permissions; read that refusal and route the call to a connector with the required permissions. A read-only Connecta endpoint independently omits and blocks tools classified as writes.
<!-- endfragment -->
