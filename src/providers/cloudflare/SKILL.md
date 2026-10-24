---
{
  "name": "cloudflare",
  "instructionsHeading": "Account instructions"
}
---

## Accounts, domains and records

Resolve account and zone ids before acting. A zone is a domain, found by its name;
its account id joins it to the account inventory. Cloudflare ids are normally
32-character hex strings. A default id routes a request; a pin limits its scope.

DNS TTL is in seconds; TTL 1 means automatic. Read the record before changing it.
PATCH changes supplied fields; PUT replaces the record, so preserve its type,
name and content. Read state before replacing, rolling back or purging. Prefer
a targeted cache purge by files, tags, hosts or prefixes over purging everything.

Hatch data keeps Cloudflare's vendor envelope. For example, select DNS record
identities with `fields: ["result.id", "result.name"]`; a list stays under
`data.result`. Named account and zone lists keep projected rows with camelCase
account and name-server fields.

## Workers, storage and analytics

Worker script source is code; secret binding values are separate and unavailable.
KV values are application data. Encode a slash inside a KV key or R2 object key
as `%2F`. R2 requires API-token authentication, rather than a Global API Key.

GraphQL Analytics uses accountTag and zoneTag for account/zone identities.
Filter every accounts/zones field by equality or an explicit set of those ids.
A pinned query uses one operation per document and every declared fragment.
Analytics Engine SQL is read-only; D1 SQL and Durable Object queries can write.
AI inference, previews and outbound checks can cost money or activate work.

## Disqualifiers and recovery

Credential minting, rotation, stored secrets, private session captures and signed
upload or deployment links are unavailable. Use the Cloudflare dashboard for
credential administration. A Global API Key cannot change user settings or
memberships through this connection.

After an authentication failure, use `verify_credential` once to distinguish a
rejected credential from a permission gap. An operator replaces the credential;
repeating the failed request does not add permissions. Cloudflare's global limit
counts dashboard traffic and all tokens together, so reduce requests as well as
honoring the returned wait.
