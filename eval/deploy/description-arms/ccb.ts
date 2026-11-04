import { hatchDiscovery, type ProviderTable } from "./types.js";

const WRITE_RULE = "Writes require authorized configured scopes.";

export const CCB: ProviderTable = {
  tools: {
    get_me: {
      terse: "Get the CCB individual the access token belongs to.",
      disambiguation: "Get the signed-in CCB individual whose permissions every Identity Auth call carries.",
      example: 'Get the CCB individual the access token belongs to. Example: {"fields":["id","name"]}.',
    },
    list_individuals: {
      terse: "Find CCB individuals by partial name, phone or email; returns lean profiles with family and campus ids.",
      disambiguation:
        "Find CCB individuals and their family and campus ids by partial name, phone or email; search_records is the advanced search.",
      example: 'Find CCB individuals. Example: {"query":"Rowan","limit":100,"fields":["id","familyId"]}.',
    },
    get_individual: {
      terse: "Get one CCB individual's full profile. CCB allows one call a second.",
      disambiguation:
        "Get one individual's contact, addresses, membership and custom fields. CCB allows one call a second; list_individuals reads many people.",
      example: 'Get one CCB individual\'s profile; CCB allows one call a second. Example: {"individualId":42}.',
    },
    list_families: {
      terse: "Find CCB families by partial last name, email or mobile phone.",
      disambiguation:
        "Find a CCB family's id and address by partial last name, email or phone; get_family lists members.",
      example: 'Find CCB families. Example: {"lastName":"Rowan","fields":["id","name"]}.',
    },
    get_family: {
      terse: "Get one CCB family with every member's lean profile and family position.",
      disambiguation: "Get one CCB family's members and positions; list_families finds its id.",
      example: 'Get one CCB family with its members. Example: {"familyId":12}.',
    },
    list_groups: {
      terse: "List or search CCB groups by partial name and campus.",
      disambiguation:
        "Find a CCB group's id, type and leader by partial name; list_group_members reads its participants.",
      example: 'List CCB groups. Example: {"name":"Choir","fields":["id","name"]}.',
    },
    get_group: {
      terse: "Get one CCB group's details, member count and meeting time.",
      disambiguation: "Get one CCB group's description, meeting time and address; list_group_members reads its people.",
      example: 'Get one CCB group. Example: {"groupId":7}.',
    },
    list_group_members: {
      terse: "List one CCB group's participants with role and date added.",
      disambiguation:
        "List one group's participants and roles; list_individual_groups goes the other way, from a person to groups.",
      example: 'List one CCB group\'s participants. Example: {"groupId":7,"status":"leader"}.',
    },
    list_individual_groups: {
      terse: "List the CCB groups one individual belongs to, with their role.",
      disambiguation: "List one person's groups and roles; list_group_members goes from a group to people.",
      example: 'List one individual\'s CCB groups. Example: {"individualId":42}.',
    },
    list_events: {
      terse: "List CCB event occurrences by name and time range.",
      disambiguation: "Find CCB event occurrences; each row's eventId and occurrence feed the attendance tools.",
      example: 'List CCB event occurrences. Example: {"name":"Choir","range":"PAST"}.',
    },
    get_event: {
      terse: "Get one CCB event's details, optionally for one occurrence.",
      disambiguation: "Get one event's details or one occurrence's totals; get_event_attendance has the summary.",
      example: 'Get one CCB event. Example: {"eventId":3,"occurrence":"2026-10-01","withAttendance":true}.',
    },
    get_event_attendance: {
      terse: "Get one CCB occurrence's attendance totals. Drops leader notes and prayer requests.",
      disambiguation:
        "Get one occurrence's met status, totals and visitors; list_event_attendees names people. Drops leader notes and prayer requests.",
      example:
        'Get one CCB occurrence\'s attendance summary, without leader notes and prayer requests. Example: {"eventId":3,"occurrence":"2026-10-01"}.',
    },
    list_event_attendees: {
      terse: "List who attended one CCB event occurrence.",
      disambiguation: "List who attended one occurrence by id and name; get_event_attendance has totals.",
      example: 'List who attended one CCB occurrence. Example: {"eventId":3,"occurrence":"2026-10-01"}.',
    },
    list_individual_notes: {
      terse: "List the notes on one CCB individual. Pastoral content; reduce before returning.",
      disambiguation:
        "List one individual's notes this connection may read, with sharing level. Pastoral content; reduce before returning.",
      example:
        'List one CCB individual\'s notes. Pastoral content; reduce before returning. Example: {"individualId":42}.',
    },
    get_giving_metrics: {
      terse: "Get gift counts by period for one CCB individual or family, over at most 12 months. No per-gift amounts.",
      disambiguation:
        "Get gift counts by period, at most 12 months; No per-gift amounts or transactions, which indexed reads cover through ccb_api_read.",
      example:
        'Get CCB gift counts by period, at most 12 months. No per-gift amounts. Example: {"individualId":42,"start":"2026-01-01","end":"2026-10-01"}.',
    },
    search_records: {
      terse: "Search CCB records by domain with a reviewed read-only POST.",
      disambiguation:
        "Run CCB's advanced search when list_individuals and list_groups cannot filter it; ccb_api_read returns domain-specific fields.",
      example:
        'Search CCB records by domain. Example: {"domain":"individuals","body":{"configuration":{"filter_profile_type":["inactive"]},"filters":{}},"limit":100}.',
    },
    ...hatchDiscovery("CCB", '{"query":"update email","method":"PUT"}', '{"method":"GET","path":"/campuses"}', "ccb"),
    ccb_api_read: {
      terse: "Read a reviewed CCB API operation, including reviewed read-only POST.",
      disambiguation:
        "Read CCB fields no named tool returns: campuses, forms, processes, schedules, pledges and donations. Find the path with ccb_api_search first.",
      example: 'Read a reviewed CCB API operation. Example: {"path":"/campuses","query":{"name":"North"}}.',
    },
    ccb_api_write: {
      terse: `Send a reviewed CCB API write. ${WRITE_RULE}`,
      disambiguation: `Update a person's email or phone, or create people, notes, group memberships and events. Find the path with ccb_api_search first. ${WRITE_RULE}`,
      example: `Send a reviewed CCB API write. Example: {"method":"PUT","path":"/individuals/42","body":{"email":"alice@example.com"}}. ${WRITE_RULE}`,
    },
  },
};
