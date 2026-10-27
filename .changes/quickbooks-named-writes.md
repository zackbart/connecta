---
type: added
---

Add explicitly enabled QuickBooks Online customer creation, sparse customer naming updates and real unsent service-invoice creation for US companies and USD customers. The connector remains read-only unless deployment code sets `readOnly: false`; the API hatch remains read-only. Writes require a stable request ID and are never automatically replayed. Invoice creation fixes email status and disables online payment options; invoice updates remain deferred pending safe preservation of existing delivery/payment settings.
