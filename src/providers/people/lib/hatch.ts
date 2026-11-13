import { Effect } from "effect";
import { ConnectorCallError } from "../../../errors.js";
import { Refusal } from "../../../http/errors.js";
import { googlePageToken } from "../../../http/hatch-paging.js";
import type { Connection } from "../../../http/vendor.js";
import { googleHatchBinding } from "../../_shared/google/hatch.js";
import { OperationIndex } from "../../_shared/rest/operation-index.js";
import { refuseWithheldBase64 } from "../../_shared/rest/value-safety.js";
import { openapi } from "../openapi.generated.js";

export const peopleIndex = new OperationIndex(openapi, {
  vendor: "people",
  title: "Google People",
  pathMatching: "uri-template",
});

const PHOTO = "/people/{peopleId}:updateContactPhoto";
/** Writes that carry the etag a read returned; Google refuses a stale one. */
const GUARDED = new Set([
  "/people/{peopleId}:updateContact",
  "/people:batchUpdateContacts",
  "/contactGroups/{contactGroupsId}",
]);

/** Google's documented page-size ranges, checked before a hatch request is sent. */
const PAGE_SIZES: Readonly<Record<string, number>> = {
  "/people/{peopleId}/connections": 1000,
  "/contactGroups": 1000,
  "/otherContacts": 1000,
  "/people:listDirectoryPeople": 1000,
  "/people:searchDirectoryPeople": 500,
  "/people:searchContacts": 30,
  "/otherContacts:search": 30,
};

export function peopleBinding(connection: Connection) {
  return googleHatchBinding(connection, {
    index: peopleIndex,
    review:
      "All twenty-four reviewed People JSON methods, confined below /v1 with the delegated subject or connected account, shared safety and sensitive-field choice; contact photos are decoded and checked before upload.",
    refuse: (call) => {
      const max = PAGE_SIZES[call.op.path];
      const pageSize = call.query["pageSize"];
      if (
        max !== undefined &&
        pageSize !== undefined &&
        (typeof pageSize !== "number" || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > max)
      )
        return `People query.pageSize must be an integer from 1 to ${max} here; omit it for Google's default.`;
      return undefined;
    },
    revisionGuarded: (call) => GUARDED.has(call.op.path),
    // A photo travels as base64 JSON that Google decodes: its decoded bytes
    // meet the same withheld-value admission as every other request body.
    wrapSend: (call, send) =>
      call.op.path !== PHOTO
        ? send()
        : Effect.tryPromise({
            try: () =>
              refuseWithheldBase64((call.body as Record<string, unknown> | undefined)?.["photoBytes"], "Google People"),
            catch: (error) => error,
          }).pipe(
            Effect.catch((error) =>
              error instanceof ConnectorCallError ? Effect.fail(new Refusal({ error })) : Effect.die(error),
            ),
            Effect.flatMap(() => send()),
          ),
  });
}

export const PEOPLE_HATCH = {
  name: "people",
  title: "Google People",
  index: peopleIndex,
  pathExample: "/people/c1234567890",
  verdicts: {
    "GET /people/{peopleId}": "read",
    "GET /people/{peopleId}/connections": "read",
    "GET /people:batchGet": "read",
    "GET /people:searchContacts": "read",
    "GET /people:searchDirectoryPeople": "read",
    "GET /people:listDirectoryPeople": "read",
    "POST /people:createContact": "write",
    "PATCH /people/{peopleId}:updateContact": "destructive",
    "DELETE /people/{peopleId}:deleteContact": "destructive",
    "POST /people:batchCreateContacts": "write",
    "POST /people:batchUpdateContacts": "destructive",
    "POST /people:batchDeleteContacts": "destructive",
    "PATCH /people/{peopleId}:updateContactPhoto": "destructive",
    "DELETE /people/{peopleId}:deleteContactPhoto": "destructive",
    "GET /contactGroups": "read",
    "GET /contactGroups/{contactGroupsId}": "read",
    "GET /contactGroups:batchGet": "read",
    "POST /contactGroups": "write",
    "PUT /contactGroups/{contactGroupsId}": "destructive",
    "DELETE /contactGroups/{contactGroupsId}": "destructive",
    "POST /contactGroups/{contactGroupsId}/members:modify": "destructive",
    "GET /otherContacts": "read",
    "GET /otherContacts:search": "read",
    "POST /otherContacts/{otherContactsId}:copyOtherContactToMyContactsGroup": "write",
  },
  named: {
    "GET /people/{peopleId}": "get_person",
    "GET /people/{peopleId}/connections": "list_contacts",
    "GET /people:batchGet": "get_people",
    "GET /people:searchContacts": "search_contacts",
    "GET /people:searchDirectoryPeople": "search_directory",
    "GET /people:listDirectoryPeople": "list_directory",
    "POST /people:createContact": "create_contact",
    "PATCH /people/{peopleId}:updateContact": "update_contact",
    "DELETE /people/{peopleId}:deleteContact": "delete_contact",
    "GET /contactGroups": "list_contact_groups",
    "GET /contactGroups/{contactGroupsId}": "get_contact_group",
    "POST /contactGroups": "create_contact_group",
    "PUT /contactGroups/{contactGroupsId}": "update_contact_group",
    "DELETE /contactGroups/{contactGroupsId}": "delete_contact_group",
    "POST /contactGroups/{contactGroupsId}/members:modify": "update_contact_group_members",
    "GET /otherContacts": "list_other_contacts",
    "GET /otherContacts:search": "search_other_contacts",
    "POST /otherContacts/{otherContactsId}:copyOtherContactToMyContactsGroup": "copy_other_contact",
  },
  pages: {
    "GET /people/{peopleId}/connections": googlePageToken,
    "GET /contactGroups": googlePageToken,
    "GET /otherContacts": googlePageToken,
    "GET /people:listDirectoryPeople": googlePageToken,
    "GET /people:searchDirectoryPeople": googlePageToken,
  },
  pageCursor: "argument",
} as const;
