---
type: changed
breaking: true
---

Standardize Google Forms with four indexed `forms_api_*` hatches while keeping
all six named tools. Replace `get_form.raw` with `forms_api_read` at
`/forms/{formId}` and read the vendor Form from `data`. `list_responses.responses`
becomes `items`, and its redundant `formId` is removed. Named reads accept
`fields` (per item for response lists); terminal pages omit `nextCursor`.
Discard old cursors after upgrade. Size cuts use `truncated` paths instead of
batch booleans or `moreOptions`/`moreQuestions`; recovery question ids remain.
Temporary image access destinations are permanently withheld. Publish settings
and all watches stay refused. Named-write classifications and scopes stay the
same; the new write hatch is destructive. See the Google Forms section of the
0.35 migration guide for concrete path, body, cursor and result mappings.
