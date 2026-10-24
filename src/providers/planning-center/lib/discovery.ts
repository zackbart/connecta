import { OperationIndex, type OpenApiData, type RestMethod } from "../../_shared/rest/operation-index.js";

/** Reviewed workflow vocabulary over the unchanged vendor paths and contracts. */
const summaries: Readonly<Record<string, string>> = {
  "GET /people/v2/people":
    "Find and search People profiles: a person, contact details, active or inactive members, name, email or phone.",
  "GET /people/v2/people/{person_id}":
    "Get one person's People profile and contact details; include emails, phone numbers, addresses and household.",
  "PATCH /people/v2/people/{person_id}":
    "Update or archive a person: inactive archives the People profile; active restores it without deleting history.",
  "GET /people/v2/person_mergers":
    "Find merged person history and the surviving People id for a removed duplicate profile.",
  "POST /people/v2/people/{person_id}/emails": "Add an email address to a person as a separate People Email record.",
  "POST /people/v2/people/{person_id}/phone_numbers":
    "Add a phone number to a person as a separate People PhoneNumber record.",
  "GET /people/v2/field_definitions": "List custom field definitions, names and data types for People profiles.",
  "GET /people/v2/people/{person_id}/field_data":
    "List a person's custom field values; join field definitions for their names and data types.",
  "GET /people/v2/people/{person_id}/notes": "List a person's profile note records and their categories.",
  "GET /services/v2/people":
    "List Services volunteers and person identities for a volunteer roster; use plans for who is serving on a date.",
  "GET /services/v2/teams": "List volunteer teams and roster roles across Services service types.",
  "GET /services/v2/service_types":
    "List service types to resolve the worship service before finding its dated plan and order of service.",
  "GET /services/v2/service_types/{service_type_id}/plans":
    "List dated Services plans for an order of service; choose the plan before reading items or the volunteer roster.",
  "GET /services/v2/service_types/{service_type_id}/plans/{plan_id}/items":
    "Read the order of service: ordered plan items, songs, durations and worship-service positions.",
  "GET /services/v2/service_types/{service_type_id}/plans/{plan_id}/team_members":
    "List a plan's volunteer roster and serving team members, with person, team and position identities.",
  "POST /services/v2/service_types/{service_type_id}/plans/{plan_id}/team_members":
    "Schedule a volunteer into one plan's serving roster with the person's team and position.",
  "GET /groups/v2/groups": "Find church groups, then resolve group leaders and members through their memberships.",
  "GET /groups/v2/groups/{group_id}/memberships":
    "List church group leaders and members; each group membership joins a person and their leader role.",
  "GET /giving/v2/donations": "List donations by person, date or fund; include designations for fund identities.",
};

/**
 * A broad singular person query means the profile root, rather than every
 * cross-product relationship ending in /person. Scope only this local alias;
 * qualified queries such as person mergers retain full-index discovery.
 * Shared hatch ranking and every other provider's index are unchanged.
 */
export class PlanningCenterIndex extends OperationIndex {
  constructor(data: OpenApiData) {
    super(
      {
        ...data,
        ops: data.ops.map(([method, path, id, summary, tag, server]) => {
          const reviewed = summaries[`${method} ${path}`];
          // PCO omits operation ids: preserve the generated CRUD/resource words
          // alongside workflow synonyms so verb-led queries remain discoverable.
          const combined = reviewed ? `${reviewed} (${summary.replace(/ — Planning Center \w[\w-]*$/, "")})` : summary;
          return server === undefined
            ? ([method, path, id, combined, tag] as const)
            : ([method, path, id, combined, tag, server] as const);
        }),
      },
      { vendor: "pco", title: "Planning Center" },
    );
  }

  override search(query: string, options: { method?: RestMethod; limit: number }) {
    const found = super.search(query, { ...options, limit: this.ops.length });
    const scoped =
      query.trim().toLowerCase() === "person"
        ? found.filter((op) => ["/people/v2/people", "/people/v2/people/{person_id}"].includes(op.path))
        : found;
    return scoped.slice(0, options.limit);
  }
}
