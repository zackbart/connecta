---
{
  "name": "overflow",
  "instructionsHeading": "Nonprofit instructions"
}
---

<!-- fragment: guide_0 -->


## Money, units, and status

Overflow does not use one money unit, so read the unit per field:

- Fields named `…InCents` are cents: deposits and their line items and
  totals, refunds, chargebacks, and the authorize body.
- Recurring-gift `amount` is dollars: Overflow's create and update bodies
  say so, and its subscription reads carry the same field.
- Contribution `amount` states no unit in Overflow's schema. Check one known
  gift before reporting totals.
- `status` is per asset type. A gift is final at `PAID_OUT` (cash),
  `CONFIRMED` (manual cash, crypto), `CONTRIBUTION_RECEIVED` or `BILLED`
  (stock), and `CONTRIBUTION_RECEIVED` (DAF). `statusBucket` filters by
  Overflow's coarser PENDING / CONFIRMED / FAILED / CANCELED.
- There is no funds endpoint. A gift reports its campaign and subcampaign;
  `fundId` and `subFundId` appear only in the payment-authorize body.
- Poll for changes with `minimumUpdatedDate`; `minimumInitiatedDate` is
  when the donor gave.

## Reconcile a deposit

`list_deposits` → `get_deposit_summary` for totals → `get_deposit` for the
line items, whose `referenceId` names the contribution, refund, or
chargeback. Contributions also carry their `depositId`.

## Donor data is sensitive

Giving history and donor contact details are personal data. Reduce inside
`execute_code` — aggregate, count, or keep ids — and return names, emails,
phones, or addresses only when the task needs them. Lists and contributions
already omit contact details; `get_donor` is the deliberate lookup.

## Writes go through `overflow_api_mutate`

Every Overflow write moves money or changes a donor record, so none has a
named tool. Each is one approval-gated `overflow_api_mutate` call with
Overflow's documented body:

- `POST /contributions` charges a saved payment method. Its `amount`
  states no unit; confirm it against a known gift of the same donor before
  charging. `POST /payments/authorize` takes `amountInCents` and
  authorizes a new method (`0` only saves it).
- `POST /contributions/{id}/initiate-refund` (under $1,000 only).
- `POST` / `PATCH` / `DELETE /subscriptions/{donorId}[/{subscriptionId}]`
  creates, changes, or cancels a recurring gift. Its `amount` is dollars,
  not cents: a $50.00 monthly gift is `amount: 50`. Cancel takes a
  `cancellationReason` body.
- `POST /donors`, `PATCH /donors/{id}`.

Resolve every id first — donors, payment methods (`list_payment_methods`),
campaigns, locations — and never guess one. A write that fails with HTTP 5xx
may still have happened: read before retrying.

## Hatches, pages, and limits

- `overflow_api_get` reaches the reads without a named tool: single refunds,
  chargebacks, campaigns, locations, webhooks, and recurring gifts
  (`/subscriptions/{donorId}/{id}`), and Tap devices, groups, and
  destinations (`/tap/devices`, `/tap/groups`, `/tap/destinations`). Paths
  are below `/api/v3`; array filters repeat a `name[]` query pair.
- Lists page by number: pass `page` while `page.hasMore` is true.
  `list_webhook_event_logs` pages by cursor instead.
- Overflow allows 120 requests per minute per API client. This connection
  admits the same per runtime, four at a time, which approximates rather than
  enforces it; a `rate_limited` failure carries the wait.
<!-- endfragment -->
