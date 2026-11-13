---
type: fixed
---

Withholding credential-bearing links now matches whole parameter-name tokens. `token`, `access_token`, `api_key`, `apiKey`, `key`, `code`, `sig`, `client_secret` and `X-Amz-Signature` are still withheld, but ordinary parameters that merely contain a credential word, such as `keyword`, `country_code`, `postcode`, `monkey` and `author`, keep their bytes in every REST provider's results. Opaque fragments with no `name=value` pairs keep the previous conservative rule (#1408).
