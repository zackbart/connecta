// Google People's vendor on the provider kit: the operations the tools send,
// the product facts the shared Google table words its failures with, and the
// value-safety resolver over the pinned People index.
import { Schema } from "effect";
import { del, get, patch, post, put, vendor } from "../../http/vendor.js";
import type { SafetyOptions } from "../../http/safety.js";
import { googleErrors, type GoogleProduct } from "../_shared/google/kit.js";
import { valueSafety } from "../_shared/rest/value-safety.js";
import { peopleIndex } from "./lib/hatch.js";
import { PEOPLE_VALUE_SAFETY } from "./safety.js";
import { PEOPLE_SCOPES } from "./lib/constants.js";

export const PEOPLE: GoogleProduct = {
  provider: "Google People",
  api: "People API",
  scopes: PEOPLE_SCOPES,
  // A profile the user cannot see and one that does not exist both answer
  // 404, so a 404 is not proof of absence.
  notFound: "ambiguous",
};

const Person = { peopleId: Schema.String };
const Group = { contactGroupsId: Schema.String };
const Mask = {
  personFields: Schema.optionalKey(Schema.String),
  sources: Schema.optionalKey(Schema.Array(Schema.String)),
};
const Page = {
  pageSize: Schema.optionalKey(Schema.String),
  pageToken: Schema.optionalKey(Schema.String),
};
const Directory = {
  ...Page,
  readMask: Schema.optionalKey(Schema.String),
  sources: Schema.optionalKey(Schema.Array(Schema.String)),
};

const getPerson = get("getPerson", "/people/:peopleId", { params: Person, query: Mask, success: Schema.Unknown });

const OPERATIONS = [
  getPerson,
  get("listConnections", "/people/:peopleId/connections", {
    params: Person,
    query: { ...Mask, ...Page, sortOrder: Schema.optionalKey(Schema.String) },
    success: Schema.Unknown,
  }),
  get("batchGetPeople", "/people:batchGet", {
    query: { ...Mask, resourceNames: Schema.optionalKey(Schema.Array(Schema.String)) },
    success: Schema.Unknown,
  }),
  get("searchContacts", "/people:searchContacts", {
    query: {
      query: Schema.optionalKey(Schema.String),
      readMask: Schema.optionalKey(Schema.String),
      pageSize: Schema.optionalKey(Schema.String),
    },
    success: Schema.Unknown,
  }),
  post("createContact", "/people:createContact", {
    query: { personFields: Schema.optionalKey(Schema.String) },
    payload: Schema.Unknown,
    success: Schema.Unknown,
  }),
  patch("updateContact", "/people/:peopleId:updateContact", {
    params: Person,
    query: {
      updatePersonFields: Schema.optionalKey(Schema.String),
      personFields: Schema.optionalKey(Schema.String),
    },
    payload: Schema.Unknown,
    success: Schema.Unknown,
  }),
  del("deleteContact", "/people/:peopleId:deleteContact", { params: Person, success: Schema.Unknown }),
  get("listContactGroups", "/contactGroups", {
    query: { ...Page, groupFields: Schema.optionalKey(Schema.String) },
    success: Schema.Unknown,
  }),
  get("getContactGroup", "/contactGroups/:contactGroupsId", {
    params: Group,
    query: { maxMembers: Schema.optionalKey(Schema.String), groupFields: Schema.optionalKey(Schema.String) },
    success: Schema.Unknown,
  }),
  post("createContactGroup", "/contactGroups", { payload: Schema.Unknown, success: Schema.Unknown }),
  put("updateContactGroup", "/contactGroups/:contactGroupsId", {
    params: Group,
    payload: Schema.Unknown,
    success: Schema.Unknown,
  }),
  del("deleteContactGroup", "/contactGroups/:contactGroupsId", {
    params: Group,
    query: { deleteContacts: Schema.optionalKey(Schema.String) },
    success: Schema.Unknown,
  }),
  post("modifyContactGroupMembers", "/contactGroups/:contactGroupsId/members:modify", {
    params: Group,
    payload: Schema.Unknown,
    success: Schema.Unknown,
  }),
  get("listOtherContacts", "/otherContacts", {
    query: { ...Page, readMask: Schema.optionalKey(Schema.String) },
    success: Schema.Unknown,
  }),
  get("searchOtherContacts", "/otherContacts:search", {
    query: {
      query: Schema.optionalKey(Schema.String),
      readMask: Schema.optionalKey(Schema.String),
      pageSize: Schema.optionalKey(Schema.String),
    },
    success: Schema.Unknown,
  }),
  post("copyOtherContact", "/otherContacts/:otherContactsId:copyOtherContactToMyContactsGroup", {
    params: { otherContactsId: Schema.String },
    payload: Schema.Unknown,
    success: Schema.Unknown,
  }),
  get("searchDirectoryPeople", "/people:searchDirectoryPeople", {
    query: { ...Directory, query: Schema.optionalKey(Schema.String) },
    success: Schema.Unknown,
  }),
  get("listDirectoryPeople", "/people:listDirectoryPeople", { query: Directory, success: Schema.Unknown }),
] as const;

/** The eighteen People methods the named tools call, published under `/v1` as Google's Discovery document spells them. */
export const PeopleApi = vendor({ name: "Google People", manifestBase: "/v1" }, ...OPERATIONS);

const standard = googleErrors(PEOPLE, { standard: true, revisionConflicts: true });

/** Google's table, with the one conflict source People has: an update at a stale etag. */
export const errors: typeof standard = {
  ...standard,
  meanings: {
    ...standard.meanings!,
    conflicts: ["An etag-guarded contact or group update returned FAILED_PRECONDITION or ABORTED with HTTP 400 or 409"],
  },
};

const values = valueSafety(PEOPLE_VALUE_SAFETY, () => peopleIndex);

/** The reviewed table over the pinned index, then the deployment's sensitive-field choice. */
export function peopleSafety(sensitiveFields: SafetyOptions["sensitiveFields"]): SafetyOptions {
  return {
    reviewed: {
      resolve: (method: string, path: string) => {
        const op = peopleIndex.resolve(method, path).op;
        return { method: op.method, template: op.path };
      },
      redact: (data: unknown, op: { method: string; template: string }) => values.redact(data, op.method, op.template),
      withholds: (op: { method: string; template: string }) => values.withholds(op.method, op.template),
      withholdsErrors: (op: { method: string; template: string }) =>
        values.withholdsErrors(
          peopleIndex.ops.find((entry) => entry.method === op.method && entry.path === op.template)!,
        ),
    },
    sensitiveFields,
  };
}

/**
 * Delegation has no operator credential to test: the key is a deployment
 * secret read at construction. This probe is never run, because the
 * connection declares no credential.
 */
export const probe = {
  operation: getPerson,
  request: { params: { peopleId: "me" } },
  describe: () => "Google People delegation has no credential to test.",
};
