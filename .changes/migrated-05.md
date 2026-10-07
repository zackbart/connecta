---
type: added
---

**Google Forms connection.** `@zackbart/connecta/providers/forms` exports
`forms(id, options)`, taking the same Workspace options as `gmail()`, plus
`FORMS_SCOPES` and `FORMS_API_BASE_URL`. Six hand-written tools: `get_form`
(title, description, quiz and publish state, `revisionId`, and every item
with the question ids answers are keyed by — one per grid row — their types,
options, and required flags; long descriptions and option lists cut with
explicit markers; `raw: true` for Google's whole Form), `list_responses`
(cursor-paged, an optional exclusive `submittedAfter` instant, each answer
labeled with its question's title in form order, with any quiz grade and
grader feedback, answers and feedback over 2,000 characters cut) and
`get_response` (one whole, with file ids, quiz grades, and feedback text and
links; `questionIds` narrows it), `create_form` (title, Drive file name,
optionally unpublished — all Google accepts at creation), `update_form_info`
(replaces the title or description), and `batch_update_form` (Google's own
batchUpdate requests, each exactly one of its six kinds, all or none, under a
required `requiredRevisionId` so an edit never lands on a form someone
changed since it was read; a stale revision fails `conflict`). Every result
stays inside 192 KiB, under `execute_code`'s 256 KiB host-result bridge,
measured whole, cursor included: a response page ends early and continues
after the last response it returned, only while Google's page still holds
the same responses in the same order (otherwise `conflict`), every
projected text is bounded in bytes as well as characters and cut without
splitting a surrogate pair, a large form pages its items under a cursor
bound to its revision — continuing inside a grid too large for one page, so
every question id is reachable — a response too large to read whole names the answers
it left out in `omittedQuestionIds`, `raw: true` refuses a form too large
for one result, and a batch reply too large to return whole drops question
ids, then everything but counts, marked `truncated` and still reported as
applied. `create_form` is additive; the other two writes are
destructive. A write Google may have applied — no answer, a 5xx or redirect after it
arrived, or a reply that broke — is reported as not retryable (no Forms
write is sent as idempotent), and a create says to look in Drive before
creating again. There is no list, delete, share, publish, or watch tool: Drive
lists forms, and this connection requests no Drive scope. A form is a Drive
file, so a 404 is reported as unknown-or-not-visible, never as absence.
Setup, with exactly `forms.body` and `forms.responses.readonly` for the
domain-wide delegation entry, is documented on `forms()` itself.
