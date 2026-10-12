---
type: added
---

`planningCenter()` accepts `excludeApps`, a list of Planning Center products the connection never reaches, such as `["giving"]` for a deployment that keeps agents away from donor and financial data. An excluded product's named tools leave the catalog; the description, usage guide, and version pins stop naming it; and `pco_api_get` and `pco_api_mutate` refuse its paths with `provider_permission_denied` before sending, including percent-encoded, miscased, doubled-slash, backslash, and traversal spellings. While any product is excluded, the hatches also refuse a webhook subscription to an excluded product's events and every webhook event or delivery payload. Any product except People can be excluded; an unknown name or People throws at construction. The default excludes nothing and is unchanged.
