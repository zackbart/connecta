---
type: security
---

Sent-secret redaction no longer renames vendor field names before result safety runs. Provider kit responses keep their field names and have every value redacted, so value safety and projections find each field by the name the vendor gave it; response header names are kept the same way, with their values redacted. Field names are still checked for sent secrets before results, failures and program values reach the agent. The reviewed field-name exemption that Docs and Slides declared is no longer needed and is removed.
