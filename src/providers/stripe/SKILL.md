---
{
  "name": "stripe",
  "instructionsHeading": "Account instructions"
}
---

## Account and money

Confirm the account and environment before investigating a payment or moving
money. A Connect account's objects belong to that account, rather than the
platform's account. Sandbox objects do not establish anything about live
customers, revenue or payouts.

Resolve ids before acting. Stripe ids identify types: `cus_` customer, `sub_`
subscription, `ch_` charge, `pi_` PaymentIntent, `in_` invoice and `acct_`
account. A plausible-looking id can refer to a different object or to nobody.

Amounts are integers in the currency's minor unit: 1099 is 10.99 USD, while
10 is 10 JPY. Keep currencies separate when totaling balances or payments.

## Payment investigations

A PaymentIntent's `latest_charge` joins it to the charge holding the payment's
`outcome`, `failure_code` and `failure_message`. Follow that reference to
explain a decline. Search supports a documented field set for each resource;
charge search has no `payment_intent` field. Resolve the parent and follow its
reference when the needed relationship is not searchable.

Search is eventually consistent; use a direct object read to reconcile a
recent write. A POST's idempotency key identifies the exact operation and
parameters. Stripe v1 may prune keys after 24 hours, so reconcile the object
before attempting the operation outside that window. A new key can create a
second payment or refund.

## Data reduction and boundaries

Keep only the customer and payment facts the question needs. Reduce lists to
counts, totals or matching records before returning them to the conversation.
Use the account and balance summaries when their projections answer the task;
other account fields and balance transactions are available through the API.

Credential creation, customer/account sign-in links, secret payload expansions,
full Issuing card details, file uploads and the meter-event stream are outside
this connection's surface. Use the Dashboard or application server for those
flows. Single meter events remain available. A guest Checkout payment page is
available only when it is unbound to a Customer or Account and cannot manage
saved payment methods; use a payment link or hosted invoice for other cases.
