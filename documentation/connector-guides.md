# Connector guides

Descriptions and schemas say *what* a connector's tools are. They do not say
which tool to prefer, which id format an address quirk expects, how the service
paginates, or how hard you may hammer it. A connector's optional `usageGuide`
is where that goes — deployment-owned configuration, served by the `skills`
meta-tool as `connector:<id>` and returned verbatim, with a bounded `summary`
surfaced in discovery so an agent learns the guide exists at the moment it
matters. See [meta-tools](./meta-tools.md#connector-guide-selection) for the
discovery contract and [connectors](./connectors.md#catalog-contract) for how a
guide is configured.

> **Partial stub.** The general guide-authoring section — style, what belongs
> in a guide versus a schema, and the `required` rule in full — is still being
> rewritten from the retired manual (`docs/connector-guides.md` in git
> history); it lands with [#348](https://github.com/zackbart/connecta/issues/348).
> The provider-conventions portion below is written.

## Provider conventions

The maintained prebuilt connections come in two shapes, and each has its own
convention set — including the shape of its usage guide, which is one of the
few things both shapes fully own:

- [Hand-written HTTP providers](./provider-conventions.md#hand-written-http-providers)
  (H1–H14) — `api()` surfaces where Connecta owns every name, schema,
  projection, and error. Cloudflare and Notion.
- [Hosted-MCP proxies](./provider-conventions.md#hosted-mcp-proxies) (P1–P11) —
  `remoteMcp()` wrappers where the downstream owns the catalog and Connecta
  owns the endpoint, credential, classification, guide, and budget. Linear,
  Stripe, and Mixpanel.

Both sets are judged by one measure: what the convention saves the model that
interacts with connecta, priced in discovery tokens, wrong-tool selection,
argument retries, or result size. The same document defines
[what a provider audit checks](./provider-conventions.md#what-the-audit-checks),
so [#342](https://github.com/zackbart/connecta/issues/342) can run against it
convention by convention rather than by taste.

Two of those conventions decide how a guide is written, and they differ by
shape. A hand-written provider's guide carries only what a schema cannot,
because it owns the schemas and should fix them instead
([H13](./provider-conventions.md#h13--the-guide-carries-only-what-a-schema-cannot)).
A proxy's guide carries the reduction and identity-resolution advice its
schemas will never carry, because it cannot change them
([P7](./provider-conventions.md#p7--the-guide-carries-the-reduction-advice-the-schemas-cannot),
[P8](./provider-conventions.md#p8--identity-resolution-comes-before-action)).
