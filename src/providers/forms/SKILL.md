---
{
  "name": "forms",
  "instructionsHeading": "Connection instructions"
}
---

## Finding forms and joining answers

The Forms API cannot list or search forms. Find the file through Drive, or use
the id after `/forms/d/` in its edit URL. The `/forms/d/e/…` responder link is
not a form id. A form id is also its Drive file id.

A form contains items; an item may ask one question, several grid questions,
or no question. Responses join by `questionId`, never by `itemId`. Named
response reads label answers with the current question titles in form order;
an answer to a deleted question has no title. A response may contain several
values or uploaded-file references for one question. File ids join to Drive.

## Reading complete responses

Responses and respondent emails can contain personal information. Filter and
aggregate in `execute_code`, returning named answers only when the task needs
them. `submittedAfter` is exclusive UTC: retain the newest `lastSubmittedTime`
for the next incremental read. Google does not promise a stable response
snapshot. A continuation inside a changed vendor page fails `conflict`; start
again or use that newest timestamp.

Large grids continue inside the same item: `questionsFrom` places the returned
rows. `omittedQuestionIds` identifies answers left out for size; read those ids
with `get_response`. The structural hatch exposes quiz grading and correct
answers, images, and option navigation that named projections omit. Temporary
image access destinations remain withheld.

## Editing without losing structure

Read the form's current revision before editing. A stale revision refuses the
batch as `conflict`; re-read and rebuild the requested edit. A revision guards
concurrent changes and does not make a repeated write safe.

Creation sets only title and Drive file name. Add descriptions or questions
afterward. `updateItem` can replace grading, images and section navigation;
read the full item through the hatch first and use a precise `updateMask`.
Item locations are indexes, while response answers use question ids.

Publishing, sharing, deleting forms, and watch administration are outside this
connection. Responses are read-only; no tool submits or deletes a response.
