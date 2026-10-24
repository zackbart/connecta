// Reviewed against the exact CCB v2 public pin 2f532bfdcd2c.
// Generic signing-name defense applies to free text; opaque file destinations are reviewed by response shape.
import type { ValueSafetyTable } from "../_shared/rest/value-safety.js";
export const CCB_VALUE_SAFETY = {
  "title": "CCB",
  "operations": {
    "PUT /events/{event_id}/attendance_grouping": {
      "verdict": "safe",
      "reason":
        "Reviewed public names denote background-check records, event settings, serving rotations or musical metadata; no authentication credential is returned.",
      "keep": [],
    },
    "PUT /events/{id}/invitation_settings": {
      "verdict": "safe",
      "reason":
        "Reviewed public names denote background-check records, event settings, serving rotations or musical metadata; no authentication credential is returned.",
      "keep": [],
    },
    "PUT /events/{id}/shared_campuses/{campus_id}": {
      "verdict": "safe",
      "reason":
        "Reviewed public names denote background-check records, event settings, serving rotations or musical metadata; no authentication credential is returned.",
      "keep": [],
    },
    "GET /individuals/background_checks": {
      "verdict": "safe",
      "reason":
        "Reviewed public names denote background-check records, event settings, serving rotations or musical metadata; no authentication credential is returned.",
      "keep": [],
    },
    "GET /individuals/{id}/background_checks": {
      "verdict": "safe",
      "reason":
        "Reviewed public names denote background-check records, event settings, serving rotations or musical metadata; no authentication credential is returned.",
      "keep": [],
    },
    "PUT /needs/{id}/coordinator": {
      "verdict": "safe",
      "reason":
        "Reviewed public names denote background-check records, event settings, serving rotations or musical metadata; no authentication credential is returned.",
      "keep": [],
    },
    "POST /oauth/token": {
      "verdict": "refuse",
      "reason": "OAuth token exchange and password reset belong to the connection grant or the vendor application.",
    },
    "POST /reset_password": {
      "verdict": "refuse",
      "reason": "OAuth token exchange and password reset belong to the connection grant or the vendor application.",
    },
    "PUT /scheduling/events/{event_id}/serving_rotations/{serving_rotation_id}": {
      "verdict": "redact",
      "reason":
        "File destinations can be private bearer download links; withhold them regardless of URL signing spelling.",
      "paths": ["event_files[].url"],
      "keep": [],
    },
    "GET /scheduling/songs/{song_id}": {
      "verdict": "safe",
      "reason":
        "Reviewed public names denote background-check records, event settings, serving rotations or musical metadata; no authentication credential is returned.",
      "keep": ["time_signature"],
    },
    "POST /search/songs/results": {
      "verdict": "safe",
      "reason":
        "Reviewed public names denote background-check records, event settings, serving rotations or musical metadata; no authentication credential is returned.",
      "keep": ["[].song_keys", "[].time_signature"],
    },
    "POST /files": {
      "verdict": "redact",
      "reason":
        "File destinations can be private bearer download links; withhold them regardless of URL signing spelling.",
      "paths": ["url"],
      "keep": [],
    },
    "GET /files/{id}": {
      "verdict": "redact",
      "reason":
        "File destinations can be private bearer download links; withhold them regardless of URL signing spelling.",
      "paths": ["url"],
      "keep": [],
    },
    "GET /individuals/{id}/files": {
      "verdict": "redact",
      "reason":
        "File destinations can be private bearer download links; withhold them regardless of URL signing spelling.",
      "paths": ["[].file.url"],
      "keep": [],
    },
    "POST /individuals/{id}/files": {
      "verdict": "redact",
      "reason":
        "File destinations can be private bearer download links; withhold them regardless of URL signing spelling.",
      "paths": ["[].file.url"],
      "keep": [],
    },
    "POST /individuals/{id}/files/{file_id}": {
      "verdict": "redact",
      "reason":
        "File destinations can be private bearer download links; withhold them regardless of URL signing spelling.",
      "paths": ["[].file.url"],
      "keep": [],
    },
    "GET /forms/{id}": {
      "verdict": "redact",
      "reason":
        "File destinations can be private bearer download links; withhold them regardless of URL signing spelling.",
      "paths": ["files[].url"],
      "keep": [],
    },
    "GET /groups/{id}/messages": {
      "verdict": "redact",
      "reason":
        "File destinations can be private bearer download links; withhold them regardless of URL signing spelling.",
      "paths": ["[].files.url", "[].recent_comments.files.url"],
      "keep": [],
    },
    "GET /messages/{id}": {
      "verdict": "redact",
      "reason":
        "File destinations can be private bearer download links; withhold them regardless of URL signing spelling.",
      "paths": ["files.url", "recent_comments.files.url"],
      "keep": [],
    },
    "PUT /messages/{id}": {
      "verdict": "redact",
      "reason":
        "File destinations can be private bearer download links; withhold them regardless of URL signing spelling.",
      "paths": ["files.url", "recent_comments.files.url"],
      "keep": [],
    },
    "GET /messages/{id}/comments": {
      "verdict": "redact",
      "reason":
        "File destinations can be private bearer download links; withhold them regardless of URL signing spelling.",
      "paths": ["[].files.url"],
      "keep": [],
    },
    "POST /messages/{id}/comments": {
      "verdict": "redact",
      "reason":
        "File destinations can be private bearer download links; withhold them regardless of URL signing spelling.",
      "paths": ["files.url"],
      "keep": [],
    },
    "PUT /messages/{id}/comments/{comment_id}": {
      "verdict": "redact",
      "reason":
        "File destinations can be private bearer download links; withhold them regardless of URL signing spelling.",
      "paths": ["files.url"],
      "keep": [],
    },
    "GET /scheduling/categories/{id}/schedules": {
      "verdict": "redact",
      "reason":
        "File destinations can be private bearer download links; withhold them regardless of URL signing spelling.",
      "paths": ["[].events[].event_files[].url"],
      "keep": [],
    },
    "POST /scheduling/categories/{id}/schedules": {
      "verdict": "redact",
      "reason":
        "File destinations can be private bearer download links; withhold them regardless of URL signing spelling.",
      "paths": ["[].events[].event_files[].url"],
      "keep": [],
    },
    "POST /scheduling/categories/{id}/files": {
      "verdict": "redact",
      "reason":
        "File destinations can be private bearer download links; withhold them regardless of URL signing spelling.",
      "paths": ["url"],
      "keep": [],
    },
    "GET /scheduling/categories/{id}/events": {
      "verdict": "redact",
      "reason":
        "File destinations can be private bearer download links; withhold them regardless of URL signing spelling.",
      "paths": ["[].event_files[].url"],
      "keep": [],
    },
    "GET /scheduling/schedules/{id}": {
      "verdict": "redact",
      "reason":
        "File destinations can be private bearer download links; withhold them regardless of URL signing spelling.",
      "paths": ["events[].event_files[].url"],
      "keep": [],
    },
    "PUT /scheduling/schedules/{id}": {
      "verdict": "redact",
      "reason":
        "File destinations can be private bearer download links; withhold them regardless of URL signing spelling.",
      "paths": ["events[].event_files[].url"],
      "keep": [],
    },
    "PUT /scheduling/events/{event_id}/event_position_associated_times": {
      "verdict": "redact",
      "reason":
        "File destinations can be private bearer download links; withhold them regardless of URL signing spelling.",
      "paths": ["event_files[].url"],
      "keep": [],
    },
    "GET /scheduling/events/{id}": {
      "verdict": "redact",
      "reason":
        "File destinations can be private bearer download links; withhold them regardless of URL signing spelling.",
      "paths": ["event_files[].url"],
      "keep": [],
    },
    "PUT /scheduling/events/{id}": {
      "verdict": "redact",
      "reason":
        "File destinations can be private bearer download links; withhold them regardless of URL signing spelling.",
      "paths": ["event_files[].url"],
      "keep": [],
    },
    "PUT /scheduling/events/{id}/copy_assignments": {
      "verdict": "redact",
      "reason":
        "File destinations can be private bearer download links; withhold them regardless of URL signing spelling.",
      "paths": ["[].event_files[].url"],
      "keep": [],
    },
    "PUT /scheduling/events/{id}/copy_assignments/{copyFromEventId}": {
      "verdict": "redact",
      "reason":
        "File destinations can be private bearer download links; withhold them regardless of URL signing spelling.",
      "paths": ["event_files[].url"],
      "keep": [],
    },
    "POST /scheduling/events/{id}/files": {
      "verdict": "redact",
      "reason":
        "File destinations can be private bearer download links; withhold them regardless of URL signing spelling.",
      "paths": ["[].url"],
      "keep": [],
    },
    "GET /scheduling/categories/{id}/service_plans": {
      "verdict": "redact",
      "reason":
        "File destinations can be private bearer download links; withhold them regardless of URL signing spelling.",
      "paths": ["[].items[].files[].url"],
      "keep": [],
    },
    "POST /scheduling/categories/{id}/service_plans": {
      "verdict": "redact",
      "reason":
        "File destinations can be private bearer download links; withhold them regardless of URL signing spelling.",
      "paths": ["items[].files[].url"],
      "keep": [],
    },
    "PUT /scheduling/service_plans/{id}": {
      "verdict": "redact",
      "reason":
        "File destinations can be private bearer download links; withhold them regardless of URL signing spelling.",
      "paths": ["[].items[].files[].url"],
      "keep": [],
    },
    "PUT /scheduling/service_plans/{id}/items": {
      "verdict": "redact",
      "reason":
        "File destinations can be private bearer download links; withhold them regardless of URL signing spelling.",
      "paths": ["items[].files[].url"],
      "keep": [],
    },
    "POST /scheduling/service_plans/{id}/items": {
      "verdict": "redact",
      "reason":
        "File destinations can be private bearer download links; withhold them regardless of URL signing spelling.",
      "paths": ["items[].files[].url"],
      "keep": [],
    },
    "PUT /scheduling/service_plan_items/{id}": {
      "verdict": "redact",
      "reason":
        "File destinations can be private bearer download links; withhold them regardless of URL signing spelling.",
      "paths": ["files[].url"],
      "keep": [],
    },
    "GET /scheduling/individuals/{id}/open_event_positions/{event_position_id}": {
      "verdict": "redact",
      "reason":
        "File destinations can be private bearer download links; withhold them regardless of URL signing spelling.",
      "paths": ["schedule.events[].event_files[].url"],
      "keep": [],
    },
    "POST /search/assignments/results": {
      "verdict": "redact",
      "reason":
        "File destinations can be private bearer download links; withhold them regardless of URL signing spelling.",
      "paths": ["[].schedule.events[].event_files[].url"],
      "keep": [],
    },
    "POST /search/organizers/results": {
      "verdict": "redact",
      "reason":
        "File destinations can be private bearer download links; withhold them regardless of URL signing spelling.",
      "paths": ["[].schedule.events[].event_files[].url"],
      "keep": [],
    },
    "POST /search/schedules/results": {
      "verdict": "redact",
      "reason":
        "File destinations can be private bearer download links; withhold them regardless of URL signing spelling.",
      "paths": ["[].events[].event_files[].url"],
      "keep": [],
    },
    "POST /search/scheduling_files/results": {
      "verdict": "redact",
      "reason":
        "File destinations can be private bearer download links; withhold them regardless of URL signing spelling.",
      "paths": ["[].url"],
      "keep": [],
    },
  },
  "fields": {
    "calendar_ical": {
      "verdict": "redact",
      "reason": "Private calendar feed destination, never returned through configuration.",
    },
    "payment_url": {
      "verdict": "redact",
      "reason": "Payment-session destination may convey access; use the vendor application.",
    },
    "time_signature": {
      "verdict": "keep",
      "reason": "Musical time signature, not an authentication signature.",
    },
    "song_keys": {
      "verdict": "keep",
      "reason": "Musical song keys, not stored credentials.",
    },
    "access_token": {
      "verdict": "redact",
      "reason": "OAuth access credential is permanently withheld.",
    },
    "refresh_token": {
      "verdict": "redact",
      "reason": "OAuth refresh credential is permanently withheld.",
    },
  },
} as const satisfies ValueSafetyTable;
