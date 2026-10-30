---
type: added
---

Search returns fully determined API reads as `readyCalls` on the first page: `{ address: "<id>.<x>_api_read", args: { path }, classification: "read", summary }`, ready to pass unchanged to `connecta.call` or `call_tool`. Only a reviewed GET served by the hatch's read tool with no path template, required parameter or required body qualifies, and every object word of the query must name its resource in the path or operationId (summaries supply only actions); an exact or complete authored-tool match suppresses ready calls; anything needing an id, method choice or argument still routes through `_api_search` and `_api_details`. Ready calls pass the same endpoint, connector, safety, hidden-tool and grant checks as other discovery, are computed offline, and are bounded to three per hatch and three per page. Listing Granola notes, Vercel deployments or Stripe customers now takes two host calls instead of four.
