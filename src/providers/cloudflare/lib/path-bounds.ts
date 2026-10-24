// Exact pin 843eae2f: these 16 integer path parameters declare minimum: 0
// with exclusiveMinimum: true. Enforce the strict bound locally; the pin and
// compiled index remain unchanged.
export const EXCLUSIVE_PATH_IDS: Readonly<Record<string, readonly string[]>> = {
  "POST /accounts/{account_id}/cloudforce-one/v2/brand-protection/queries/{query_id}/matches/{domain_id}/dismiss": [
    "query_id",
    "domain_id",
  ],
  "POST /accounts/{account_id}/cloudforce-one/v2/brand-protection/queries/{query_id}/matches/{domain_id}/undismiss": [
    "query_id",
    "domain_id",
  ],
  "DELETE /accounts/{account_id}/cloudforce-one/v2/brand-protection/takedown-notices/{notice_id}": ["notice_id"],
  "GET /accounts/{account_id}/cloudforce-one/v2/brand-protection/takedown-notices/{notice_id}": ["notice_id"],
  "PUT /accounts/{account_id}/cloudforce-one/v2/brand-protection/takedown-notices/{notice_id}": ["notice_id"],
  "GET /accounts/{account_id}/cloudforce-one/v2/brand-protection/takedown-notices/{notice_id}/letters": ["notice_id"],
  "POST /accounts/{account_id}/cloudforce-one/v2/brand-protection/takedown-notices/{notice_id}/letters": ["notice_id"],
  "DELETE /accounts/{account_id}/cloudforce-one/v2/brand-protection/takedown-notices/{notice_id}/letters/{letter_id}": [
    "notice_id",
    "letter_id",
  ],
  "GET /accounts/{account_id}/cloudforce-one/v2/brand-protection/takedown-notices/{notice_id}/letters/{letter_id}": [
    "notice_id",
    "letter_id",
  ],
  "GET /accounts/{account_id}/cloudforce-one/v2/brand-protection/takedown-notices/{notice_id}/letters/{letter_id}/pdf":
    ["notice_id", "letter_id"],
  "DELETE /accounts/{account_id}/cloudforce-one/v2/credential-monitor/domains/{id}": ["id"],
};
