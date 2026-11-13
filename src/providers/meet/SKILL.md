---
{
  "name": "meet",
  "instructionsHeading": "Connection instructions"
}
---

## Spaces, meeting codes and conferences

A space is a reusable meeting room: `spaces/<id>` is its stable name, and its
meeting code (`abc-mnop-xyz`, the end of its `meet.google.com` link) is a
human-typed alias that Google can later reassign. Store the space name, not the
code. Meet cannot list a user's spaces.

Each time people meet in a space, Google keeps a conference record
(`conferenceRecords/<id>`): one space has many. A space's `activeConference`
names the record of the meeting under way. Conference records and transcript
entries are deleted 30 days after the meeting ends; absence after that proves
nothing about the meeting.

## Joining Calendar, Drive and Docs

A Calendar event's `conferenceData.conferenceId` is the meeting code, and its
video entry point is the same `meet.google.com` link. Resolve it with
`get_space`, then list that space's conference records; an event recurring in
one space shares a space, so choose its conference by start time.

A recording's `driveDestination.file` is a Drive file id (an MP4). A
transcript's or smart note's `docsDestination.document` is a Google Docs
document id. Read their content through a Drive or Docs connection; the
`exportUri` links open only with the reader's own Google access. Artifacts are
saved to the organizer's Drive, so another attendee may be unable to open them.
`state` is `FILE_GENERATED` only once the file is ready; `STARTED` or `ENDED`
means it is still being produced.

## Attendance and transcripts

A participant is one person per conference. A signed-in participant's
`signedinUser.user` (`users/<id>`) joins to Admin SDK and People ids;
anonymous and phone attendees have only a display name, and a phone number is
partly hidden. Each rejoin or device is a separate participant session, so
count people with participants and time on the call with sessions.

Transcript entries name their speaker as a participant resource name; join to
`list_participants` for names. Entries can differ slightly from the Docs
transcript file. Recordings, transcripts and smart notes exist only when the
organizer's Workspace edition and admin policy allow them and someone turned
them on; smart notes also need Gemini. An empty list is not proof the meeting
did not happen.

<!-- when: writes -->
## Creating and changing spaces

Each `create_space` makes a new meeting link; there is no way to list spaces
to find a duplicate. Settings changes apply to spaces the user owns. Ending a
conference and other management apply only to spaces this app created. Only
the organizer, not a co-host, sets auto recording, transcripts and smart
notes. Moderation restrictions take effect only while moderation is on.
Ending a conference disconnects everyone at once and cannot be undone; the
space and its link remain for the next meeting.
<!-- end -->
