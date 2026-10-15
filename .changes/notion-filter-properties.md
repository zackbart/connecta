---
type: fixed
---

Send selected properties to Notion as repeated `filter_properties` URL parameters for named page reads and data source queries, reducing response size while preserving the projected page title. Page reads whose deduplicated selection plus title exceeds Notion's 100-filter limit fetch all properties and project locally instead.
