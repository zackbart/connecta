// Public People constants, kept outside the kit declarations so the published
// entry names no Effect type.

/**
 * The People API root. Every path the tools send sits beneath `/people`,
 * `/contactGroups` or `/otherContacts`; there is no user segment, because the
 * token's subject decides whose contacts and directory a request reaches.
 */
export const PEOPLE_API_BASE_URL = "https://people.googleapis.com/v1";

/**
 * Exactly the scopes this connection requests, and exactly what the Admin
 * console's domain-wide delegation entry must list (comma-separated there).
 * `contacts` reads and edits My Contacts and contact groups;
 * `contacts.other.readonly` reads "Other contacts"; `directory.readonly`
 * reads the Workspace directory; the `user.*.read` and `userinfo.profile`
 * scopes read the signed-in user's own profile through `people/me`.
 */
export const PEOPLE_SCOPES = [
  "https://www.googleapis.com/auth/contacts",
  "https://www.googleapis.com/auth/contacts.other.readonly",
  "https://www.googleapis.com/auth/directory.readonly",
  "https://www.googleapis.com/auth/user.emails.read",
  "https://www.googleapis.com/auth/user.phonenumbers.read",
  "https://www.googleapis.com/auth/user.addresses.read",
  "https://www.googleapis.com/auth/user.birthday.read",
  "https://www.googleapis.com/auth/user.organization.read",
  "https://www.googleapis.com/auth/userinfo.profile",
] as const;

/**
 * The person fields every result drops by default, by name and at any depth:
 * postal addresses, age ranges, birthdays, free-text notes (`biographies`),
 * dated events such as anniversaries, external ids (employee, customer or
 * government numbers), genders, family relations and user-defined custom
 * fields. Resolving a person needs none of them, and each is exactly what
 * should not leak into a transcript. Only deployment code returns them.
 */
export const PEOPLE_SENSITIVE_FIELDS: readonly string[] = [
  "addresses",
  "ageRanges",
  "birthdays",
  "biographies",
  "events",
  "externalIds",
  "genders",
  "relations",
  "userDefined",
];

/** A page of large contacts with long notes, or a full directory page. */
export const PEOPLE_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
