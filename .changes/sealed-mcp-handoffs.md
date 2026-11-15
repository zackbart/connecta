---
type: security
---

Every `/connect` link an MCP endpoint issues from a sealing vault is now sealed (`v4`), including the handoffs in auth errors, catalog errors and `authorize_connector` results on hosts without URL elicitation. These links used to carry an unsealed (`v3`) encoding whose decoding showed the caller's stable principal partition to the model and host logs. The recovery envelope, identity binding and expiry are unchanged, and outstanding `v3` links still verify. Operator UI links keep the unsealed encoding.
