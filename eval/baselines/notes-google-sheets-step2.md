# Google Sheets step 2 — pre-eval reference update

No paid model trials have run. This note records the reference-only update
requested after the Forms review, against main `ff3f7c3b` (#1011 and #1013).

Relative to that main, Sheets S4 replaces `get_spreadsheet.raw` with the GET
metadata hatch; S7 replaces it with the reviewed developer-metadata search
POST. All Sheets reference calls now use the AFTER surface. Prompts, expected
facts, fake state and outcome graders are unchanged by this product update.
The shared follow-up now recognizes S7 metadata as available on BEFORE through
its raw metadata read, so it is preservation coverage rather than a paid
new-capability credit.

Refreshed `runProtocol()` fingerprints:

- Main task definitions: `56e66bd447b3fb1ed8bcd6a56d4c9623c86db9c6a3e7f4a7a7c8cece2b130edd`.
- Updated task definitions: `7a006a519437655daebeb4f379463f9205808fab7216cdda5f5a1a04bdb2b464`.
- Common harness: `6b137f4efc0796a786185600fa89c30cfa738911ec208081de3406a225fa04ca`.

Future paired trials must use a common frozen task/harness snapshot. These
hashes disclose the reference-call change; they are not paid-run provenance or
evidence of comparable paid scores.

All seven deterministic Sheets references pass through both surfaces and both
grading modes, including committed append network/body failures and negative
controls. The shared surface-adapter envelope control did not fail, so no
`google-controls.ts` change or separate shared-fix commit was needed.

The signed cursor, caller-isolation, first-sentence discovery and protected
truncation changes are implementation updates, separately covered by the
provider suites and regenerated Sheets goldens. The two formerly known
standards checker failures now pass.
