// Reviewed against archived People Discovery revision 20261111.
// Names, email addresses, phone numbers, organizations and memberships are the
// requested user data. Photo and cover-photo `url` values are vendor-minted
// image destinations readable without the grant, and `clientData` values are
// other applications' private storage: both are permanently withheld,
// wherever a Person or ContactGroup appears. `userDefined` custom fields are
// user-authored data, kept here and dropped by the deployment's default
// sensitive-field choice. Page and sync tokens are continuations, never
// credentials. Website, calendar and other user-entered URLs are ordinary
// references; no generic credential URL-name rule is applied to them, and
// global signing-name defense still covers free text and error bodies.
import { safe, redact, under, vendorErrors, type ValueSafetyTable } from "../_shared/rest/value-safety.js";

/** Paths inside one Person that the review withholds. */
const PERSON = ["photos[].url", "coverPhotos[].url", "clientData[].value"] as const;
/** Paths inside one ContactGroup that the review withholds. */
const GROUP = ["clientData[].value"] as const;

/** User-authored custom field values the key-name heuristic flags; the sensitive-field choice decides them. */
const KEPT = ["userDefined[].value"] as const;

const person = (reason: string, prefixes: readonly string[], keep: readonly string[] = []) =>
  vendorErrors(redact(reason, under(prefixes, [...PERSON]), [...under(prefixes, [...KEPT]), ...keep]));
const pages = ["nextPageToken", "nextSyncToken"];

export const PEOPLE_VALUE_SAFETY = {
  title: "Google People",
  embeddedUrls: {},
  operations: {
    "GET /people/{peopleId}": person("Profile and contact photos and app-private client data.", [""]),
    "GET /people/{peopleId}/connections": person(
      "Each contact's photos and app-private client data; page and sync tokens are continuations.",
      ["connections[]"],
      pages,
    ),
    "GET /people:batchGet": person("Each person's photos and app-private client data.", ["responses[].person"]),
    "GET /people:searchContacts": person("Each match's photos and app-private client data.", ["results[].person"]),
    "GET /people:searchDirectoryPeople": person(
      "Each directory person's photos and app-private client data; the page token is a continuation.",
      ["people[]"],
      ["nextPageToken"],
    ),
    "GET /people:listDirectoryPeople": person(
      "Each directory person's photos and app-private client data; page and sync tokens are continuations.",
      ["people[]"],
      pages,
    ),
    "POST /people:createContact": person("The created contact uses the same photo and client-data boundary.", [""]),
    "PATCH /people/{peopleId}:updateContact": person(
      "The updated contact uses the same photo and client-data boundary.",
      [""],
    ),
    "POST /people:batchCreateContacts": person("Created contacts use the same photo and client-data boundary.", [
      "createdPeople[].person",
    ]),
    "POST /people:batchUpdateContacts": person("Updated contacts use the same photo and client-data boundary.", [
      "updateResult{}.person",
    ]),
    "PATCH /people/{peopleId}:updateContactPhoto": person(
      "The returned contact's new photo destination is withheld like every other.",
      ["person"],
    ),
    "DELETE /people/{peopleId}:deleteContactPhoto": person(
      "The returned contact uses the same photo and client-data boundary.",
      ["person"],
    ),
    "GET /contactGroups": vendorErrors(
      redact(
        "Each group's app-private client data; page and sync tokens are continuations.",
        under(["contactGroups[]"], [...GROUP]),
        pages,
      ),
    ),
    "GET /contactGroups/{contactGroupsId}": vendorErrors(redact("The group's app-private client data.", [...GROUP])),
    "GET /contactGroups:batchGet": vendorErrors(
      redact("Each group's app-private client data.", under(["responses[].contactGroup"], [...GROUP])),
    ),
    "POST /contactGroups": vendorErrors(redact("The created group's app-private client data.", [...GROUP])),
    "PUT /contactGroups/{contactGroupsId}": vendorErrors(
      redact("The updated group's app-private client data.", [...GROUP]),
    ),
    "GET /otherContacts": person(
      "Each other contact's photos and app-private client data; page and sync tokens are continuations.",
      ["otherContacts[]"],
      pages,
    ),
    "GET /otherContacts:search": person("Each match's photos and app-private client data.", ["results[].person"]),
    "POST /otherContacts/{otherContactsId}:copyOtherContactToMyContactsGroup": person(
      "The copied contact uses the same photo and client-data boundary.",
      [""],
    ),
    "POST /contactGroups/{contactGroupsId}/members:modify": vendorErrors(
      safe("Only resource names the request named, and which of them Google could not find or modify."),
    ),
  },
  fields: {
    nextPageToken: {
      verdict: "keep",
      reason: "Opaque People pagination metadata, usable only with the same grant; not an access credential.",
    },
    nextSyncToken: {
      verdict: "keep",
      reason: "Opaque People sync metadata, usable only with the same grant; not an access credential.",
    },
    deleted: {
      verdict: "keep",
      reason: "A boolean marking a deleted contact or group in sync results.",
    },
  },
} as const satisfies ValueSafetyTable;
