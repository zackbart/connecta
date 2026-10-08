---
{
  "name": "tithely",
  "instructionsHeading": "Account instructions"
}
---

<!-- fragment: guide_0 -->


## Giving data is sensitive

- Donor names, emails, addresses, and gift amounts are pastoral data. Reduce
  inside `execute_code`: page, filter, and total there, and return the
  aggregate (sums by fund, month, or donor count), not donor rows, unless the
  task needs named people.
- Organization projections omit the payout bank's last four and the legal
  contact's date of birth. `raw: true` and `tithely_api_get` return them;
  do not reach for either to answer a giving question.

## Ids and vocabulary

- Ids carry their kind: `org_` organization, `user_` donor account,
  `ch_` charge, `rc_` recurring gift, `pm_` payment method. Read them
  from `list_organizations` and `list_accounts`; never guess one.
- A fund is a Tithe.ly giving type: `giving_type` becomes `fund`.
- Projections rename snake_case to camelCase, return amounts as integer
  `…Cents`, and Unix-second dates as ISO 8601 UTC `…At`.
  `depositedAt` may be `"pending"`. There is no deposits resource: net
  amount and fees live on each charge.

## Paging

List tools return `page.hasMore` and `page.nextCursor`; pass the cursor
back unchanged with the same `order`. `list_charges` and
`list_recurring_charges` need `organizationId` or `accountId`.
`list_payment_methods` is not paged.

## Failures

Tithe.ly answers most refusals with HTTP 200, `status: "fail"`, and a
reason but no code. They arrive as `connector_call_failed`; read the reason
rather than retrying blind.

## Writes go through the mutate hatch

Every Tithe.ly write moves money or changes a donor's payment state, so none
has a named tool. `tithely_api_mutate` sends form fields as name/value pairs
and always needs approval. Amounts are integer cents; card and bank tokens
come only from Tithely.js in a browser, never from an agent.

- `POST /charges`: account_id, pm_id, organization_id, amount,
  giving_type, optional memo. `POST /charge-once` charges a Tithely.js token
  without an account.
- `POST /refunds/{charge_id}` refunds a charge.
- `POST /recurring`: account_id, pm_id, organization_id, amount,
  giving_type, term (weekly, monthly, bimonthly, fortnightly), start_date
  (Unix seconds). `DELETE /recurring/{recurring_id}` stops future charges and
  refunds nothing.
- `POST /payment-methods` (account_id, token), `POST
  /payment-methods/{pm_id}` (account_id plus fields to change), `DELETE
  /payment-methods/{pm_id}` with query account_id.
- `POST /accounts` and `POST /accounts/{account_id}` create and update
  donor accounts.

## Limits

Tithe.ly publishes no rate limit, so this connection declares no call budget.
An operator who knows one sets `callAdmission` on the connection. Only v1 is
reachable; Tithe.ly's undocumented v2 is not.
<!-- endfragment -->
