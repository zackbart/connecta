---
type: added
---

A maintained Google People provider (`@zackbart/connecta/providers/people`) reads and edits the user's contacts and contact groups, searches and copies "Other contacts", reads `people/me`, and searches or lists the Google Workspace directory, in both delegation and OAuth mode. Searches send Google's documented warm-up request first. Addresses, birthdays, notes, events, external ids, genders, relations and custom fields stay out of every result unless the deployment sets `sensitiveFields: "return"`; photo URLs and other applications' client data are always withheld. Contact and group updates at a stale etag fail `conflict`, and directory reads explain that personal Google accounts have no directory.
