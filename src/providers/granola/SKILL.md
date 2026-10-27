---
{"name":"granola","instructionsHeading":"Workspace instructions"}
---

## Accessible meeting records

Workspace keys reach public workspace notes and spaces explicitly enabled for
Granola API access. Folder permissions inherit their space's setting. They do
not grant unrelated private notes. Only notes with a generated AI summary and
transcript appear; a missing result does not establish that a meeting never
happened. The owner's private handwritten notes are null for workspace keys.

Discover actual note, folder and space IDs. API IDs use not_, fol_ and spa_
prefixes; a web-link UUID, title or human name is not an API ID. Notes can
belong to several folders and spaces; folder parent_folder_id describes the
hierarchy and space_id joins a folder to its space. Folder filtering includes
descendant folders. Null space_id can also mean an inaccessible space.

Operation search searches the API contract, not meeting content. The REST API
offers date, folder and space filters, with no natural-language meeting search.
Filter accessible notes and inspect their contents to answer a topic question;
disclose the period and scope examined.

## Transcript interpretation

Inline transcripts are optional. If including one fails with HTTP 413
(TRANSCRIPT_TOO_LARGE), read note details without include and retrieve the
separate transcript endpoint through its complete continuation sequence. No
partial transcript proves a complete quotation or count. An empty page can
still have a continuation; follow the returned paging state.

Speaker source describes the audio input, not a person's identity. macOS may
distinguish microphone from speaker audio. iOS currently uses microphone and
may supply anonymous diarization labels; do not invent attendee attribution.
Preserve start/end timestamps when quoting. Summaries are AI-generated, so
confirm important wording against the transcript. Return only the relevant
passages and identifying meeting metadata.
