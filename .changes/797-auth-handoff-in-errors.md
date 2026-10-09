---
type: changed
---

Auth failures on direct calls, program calls, and catalog search/describe now include the authorization URL or operator credential instructions that `authorize_connector` returns. Each call or program run reuses one handoff per connector, without forcing reauthorization. Programs can read typed recovery through `error.data` as well as `error.details`; URL elicitation is unchanged.
