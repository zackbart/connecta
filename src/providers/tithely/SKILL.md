---
{
  "name": "tithely",
  "instructionsHeading": "Account instructions"
}
---

## Giving data is pastoral

Donor names, emails, addresses, and gift amounts are pastoral data. Reduce
inside `execute_code`: page, filter, and total there, and return the
aggregate (sums by fund, month, or donor count), not donor rows, unless the
task needs named people.

## Ids and joins

- Ids carry their kind: `org_` organization, `user_` donor account, `ch_`
  charge, `rc_` recurring gift, `pm_` payment method. Read them from the list
  tools; never guess one.
- Tithe.ly lists charges and recurring gifts only for one organization or one
  donor, so pass `organizationId` or `accountId`.
- A charge carries its donor's name and email, its organization's name, and
  its payment method, so most joins need no second read.
- `list_accounts` covers every account these keys can see; `scope: "api"`
  narrows it to accounts created through this API.
- The named reads project Tithe.ly's records. A field a projection omits, such
  as an account's phone and postal address, comes back from `tithely_api_read`
  on that record's path.

## Money, dates and funds

- A fund is a Tithe.ly giving type: `giving_type` in Tithe.ly's records,
  `fund` in projections.
- Projections give amounts as integer `…Cents` and dates as ISO 8601 UTC
  `…At`. Tithe.ly's own records, from `tithely_api_read`, keep string cents
  and Unix seconds.
- `depositedAt` may be `"pending"`. There is no deposits resource: net amount
  and fees live on each charge.
- A charge a recurring gift produced has `recurring: true`; a one-time gift
  has `recurring: false`.

## Writes

- Every write moves money or changes a donor's records. Bodies are form
  fields in integer cents and Unix seconds.
- `POST /refunds/{charge_id}` refunds a whole charge.
  `DELETE /recurring/{recurring_id}` stops future charges and refunds nothing.
- Card and bank tokens, which `POST /charge-once` and `POST /payment-methods`
  need, come only from Tithely.js in a donor's browser. An agent cannot
  create one.
- Tithe.ly reports most refusals as HTTP 200 with `status: "fail"` and a
  reason but no code. They arrive as `connector_call_failed`; read the reason
  before deciding what to do next.

## Not available

Only Tithe.ly's API v1 is reachable; its undocumented v2 is not.
