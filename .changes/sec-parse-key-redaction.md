---
type: security
---

Provider kit responses keep their field names while sent-secret redaction runs on their values, so value safety and projections always find a field by the name the vendor gave it. A private argument that shares part of a field name no longer hides that field from the rule that withholds it. Field names are still checked for sent secrets before results, failures and program values reach the agent, and the Docs-only exemption for reviewed field names is no longer needed.
