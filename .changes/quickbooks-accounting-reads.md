---
type: added
---

Add a QuickBooks Online Accounting API provider for one fixed sandbox or
production company: company identity, bounded record searches, individual
records and hierarchical financial reports, with shared OAuth and a restricted
read hatch. Contact details and payment credentials remain withheld; public
SyncToken record versions remain available.

Support successive coordinated OAuth refreshes when a vendor returns unchanged
refresh-token bytes after a successful commit. Static API OAuth can configure
a trusted revocation endpoint and form or JSON request framing; QuickBooks
disconnect revokes the latest grant after local removal. Malformed query and
report payloads fail instead of appearing as empty accounting results.
