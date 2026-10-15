---
type: security
---

Withhold the whole query and fragment of canonical Notion file links embedded in every REST response and error string, including Markdown and async results. Match only each URL's actual authority, preserving external proxies and look-alike hosts with ordinary parameters; AWS and Google signing parameter values are still withheld at any host. Refuse writes carrying the exact plain or encoded `[redacted]` placeholder in a Notion file link's own query or fragment before dispatch. Admission checks every adjacent Markdown destination, recognizes leading spaces, tabs, or one line ending, and respects balanced or escaped parentheses. Both scans stay linear. Split rich-text runs, encoded hosts or signing names, bare hosts without `//`, and userinfo before a file host are outside this scan's threat model.
