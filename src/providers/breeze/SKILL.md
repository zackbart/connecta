---
{
  "name": "breeze",
  "instructionsHeading": "Church instructions"
}
---

## Church records

Breeze ChMS (now Tithely Church Management) holds people, tags, events,
attendance, forms, volunteers and giving. People carry contact information,
birthdates and family ties; giving reveals donors and amounts. Reduce records
in code and return only the names, counts or totals the task needs.

## Ids and joins

Ids are numeric strings. Resolve them from the relevant inventory before
writing. Events have an occurrence id and a series `eventId`; attendance,
volunteers and check-in use the occurrence id. Event and pledge lists can lag
up to 15 minutes behind the site. An all-zero MySQL date means no time was
recorded, including no check-out.

Profile `details` use field ids, not names. Resolve field and option ids from
`list_profile_fields`; multiple-choice filters join option ids with `-`.
A person-name lookup requires listing people and matching in code. Form entry
responses similarly join to that form's field ids.

## Giving

Giving, funds and pledges use archival endpoints removed from the public
reference in 2023. They can change or vanish without notice. Amounts are
exact decimal strings: reduce them with integer-cent arithmetic, and read the
currency from `get_account_summary`. A split gift's fund amounts belong to
its fund ids. Tithe.ly deposits sync in batches, so recent gifts can be absent.
Editing a giving transaction may return a new payment id.
Use `limit: 1000` when reducing broad giving ranges: each local page refetches
the bounded vendor list, so larger windows avoid repeated full-list fetches.

## Required sequences

Check for an existing person before adding one: creation does not deduplicate.
Resolve profile fields before updating them. Text, dates (M/D/YYYY) and option
ids use `response`; email, phone, address and family-role values use `details`.
Named person writes take these entries in `values`.
Family changes can remove previous associations. Attendance check-out records
a departure time; removing attendance deletes the record instead.

Breeze sends writes as GET requests too. Query names ending in `_json` take
JSON-encoded strings. The named person writes encode their typed profile values
for you. The account-log `object_json` is a serialized affected-object value;
its free-text description has no stable schema. Events and account logs have
vendor caps: narrow the date range when the result fills its limit.
