---
{
  "name": "overflow",
  "instructionsHeading": "Nonprofit instructions"
}
---

## Giving records and joins

Donor ids join profiles, contributions, subscriptions and payment methods.
Campaigns and subcampaigns allocate gifts; locations identify campuses.
Resolve names to ids before editing a donor or moving money. There is no funds
endpoint: fund and sub-fund identifiers occur only in payment authorization.
A donor profile owned by a donor account cannot be edited through this API;
when reads work but its edit is denied, changing the credential does not fix it.

Tap groups contain devices and point to destinations. A tap is engagement,
not a gift; use contributions to establish giving.

## Money and final status

Read the unit per field. Values named `InCents` are cents, including deposits,
refunds, chargebacks and payment authorization. Subscription `amount` is
in dollars. Contribution and saved-method charge `amount` have no stated unit
in the public schema: establish it from a known gift before reporting a sum
or authorizing a charge. Do not assume every numeric amount uses the same unit.

A gift is final at `PAID_OUT` for `CASH`, `CONFIRMED` for manual cash or crypto,
`CONTRIBUTION_RECEIVED` or `BILLED` for stock, and `CONTRIBUTION_RECEIVED` for
DAF. A status bucket is coarser than those asset-specific states. Polling by
updated date finds later state changes; initiated date identifies when a donor gave.

## Reconcile a deposit

Find the bank payout, inspect its summary totals, then its line items.
Each line item's `referenceId` names a contribution, refund or chargeback
according to its type; contributions can also carry a `depositId`.
Keep gross, fee and net cent amounts separate and convert only for presentation.
An eligible cash gift under $1,000 is refunded with `POST /contributions/{contributionId}/initiate-refund`, which takes no body; its string acknowledgement means the refund started.
A refund request starts processing; verify the gift or refund before claiming
that funds have reached the donor. Canceling a recurring gift stops future
payments and does not refund earlier gifts.

## Reduce donor and delivery data

Giving history and donor contact details are personal data. Aggregate or join
inside code and return names, email, phone and address only when the task needs
them. Lean contribution rows carry donor identity; the full donor lookup
carries contact details. Webhook delivery logs can include delivered donor
payloads and the receiving server's response: select the status, response code
and error needed for diagnosis instead of returning those payloads wholesale.
