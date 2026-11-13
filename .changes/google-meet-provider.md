---
type: added
---

A maintained Google Meet provider, `@zackbart/connecta/providers/meet`, on the Meet REST API v2 in both Google modes (domain-wide delegation and OAuth). It creates spaces, reads them by name, meeting code or link, changes their access, moderation and auto-artifact settings, and ends an active conference; reads conference records filtered by space and start time, participants and their sessions, recordings with their Drive file, transcripts with their Docs file and their spoken entries, and Gemini smart notes; and reaches space members and the remaining indexed routes through the `meet_api_*` hatch. It requests `meetings.space.created`, `meetings.space.readonly` and `meetings.space.settings`. `providers:check` now reads a pinned Google Discovery original as Discovery, so the Google products' endpoint checks no longer report a parser error.
