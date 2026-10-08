---
{
  "name": "forms",
  "instructionsHeading": "Connection instructions"
}
---

<!-- fragment: guide_0 -->
# Google Forms usage

Acts as the signed-in person in Google Forms through Workspace delegation: read and edit their forms, read responses, never submit or delete.

Connection purpose: <!-- endfragment -->

<!-- fragment: guide_1 -->


## Whose forms

Every call reaches only the forms the Workspace user deployment config maps
the caller to can open. No argument names a user. A call with none mapped
fails `auth_required`; only an operator can change the mapping. A form id
that does not exist and one not shared with that user fail alike, as
`connector_call_failed`: Google does not say which.

## Finding forms

There is no list or search here: the Forms API has none. Find a form in
Drive, or take its id from an edit URL (`/forms/d/<formId>/edit`). The
`/forms/d/e/…` responder link is not the form id.

## Reading

- Every result stays inside <!-- endfragment -->

<!-- fragment: guide_2 -->
 KiB, so it crosses into
  `execute_code` whole. A page that would outgrow that ends early with
  `page.hasMore`; follow `page.nextCursor` rather than raising `limit`.
- `get_form` lists items with their `questions`: one for a question,
  one per row for a grid, none for sections and media. Answers are keyed by
  those `questionId`s. A large form pages its items (`itemCount` is the
  total), and a grid too large for one page continues on the next: the item
  repeats with `questionsFrom`, the index of its first row there, and
  `moreQuestions` counts rows still to come. A cursor from a form that has
  since changed fails `conflict`.
  Long text is cut with a marker; `raw: true` returns Google's whole Form
  resource, or refuses one too large for a result.
- `list_responses` labels each answer with its question's title, in form
  order; an answer to a since-deleted question has no title. Answers longer
  than <!-- endfragment -->

<!-- fragment: guide_3 -->
 characters end with a truncation marker; `get_response`
  reads one whole. Page with `page.nextCursor` and the same
  `submittedAfter`. To read only new responses, pass the newest
  `lastSubmittedTime` already seen as `submittedAfter`. A cursor
  continues after the last response it returned; if Google's page has
  changed since (new, deleted, or reordered responses), it fails
  `conflict` — start again, or use `submittedAfter`.
- A response too large for one result comes back cut, with the answers left
  out named in `omittedQuestionIds`; pass them to `get_response` as
  `questionIds`.

## Editing

- `create_form` makes an empty form: Google takes only its title and Drive
  file name at creation. Add a description and questions afterwards.
- `update_form_info` replaces the title or description.
- `batch_update_form` is the escape hatch for everything else, and always
  needs approval. It takes Google's own Request objects, applied all or none,
  with the form's current `revisionId` as `requiredRevisionId`: a form
  someone changed since you read it is refused as `conflict`, so re-read it
  and rebuild the edit. Its reply carries the new `revisionId` and each created item's id.
  A reply too large to return whole comes back with `truncated: true`: the
  batch still applied; read the rest with `get_form`. An `updateItem` needs an `updateMask`; read `raw: true` first so the
  item it replaces keeps its grading, images, and navigation.
- Publishing, sharing, deleting, and watches are not in this connection; the
  owner does those in Forms or Drive. Responses are read-only.
<!-- endfragment -->
