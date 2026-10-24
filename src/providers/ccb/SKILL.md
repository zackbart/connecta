---
{"name":"ccb","instructionsHeading":"Church instructions"}
---

## People, households and groups

CCB v2 addresses records by integer ids. Resolve a person from the individual
list and a household from families; never guess ids. Family membership and
church group membership join by individual id. A membership role belongs to
that group, rather than being a property of the person everywhere.

Identity Auth acts with the signed-in person's permissions. A permission
refusal can mean that person lacks access even when the connection is healthy.

## Events and attendance

An event is a series; its dated occurrence is a separate identity. Attendance
joins need both the event id and occurrence. Preserve the vendor's date and
time-zone meaning instead of treating every occurrence as UTC midnight.

## Pastoral and financial records

Notes, background checks, pledges and giving metrics can be sensitive. Read
only what the task needs and reduce those records inside execute_code before
returning an answer. Gift metrics are counts by period, with a range of at
most twelve months. Per-gift transactions and amounts belong to the legacy
v1 XML API, which this v2 connector does not reach.

## Vendor call rates and recovery

CCB meters endpoints separately per API client. Individual profile reads have
no burst; individual advanced searches allow one call per five seconds, and
category schedule lists allow one per two seconds. Prefer list pages over a
loop of individual gets. Other deployments sharing the client spend from the
same vendor allowance.

For a profile edit, resolve the individual first and preserve fields outside
the requested change. Use `ccb_api_write` for the edit; the host may ask the
user to confirm. After an ambiguous update, read that profile to determine
what actually changed before deciding whether another write is needed.
