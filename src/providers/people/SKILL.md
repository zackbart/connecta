---
{
  "name": "people",
  "instructionsHeading": "Connection instructions"
}
---

## Three address books

A person can be in any of three places, and each tool reads exactly one:

- **My contacts** (`search_contacts`, `list_contacts`): people the user saved.
  Resource names look like `people/c123`.
- **Other contacts** (`search_other_contacts`, `list_other_contacts`): people
  Gmail saved from mail the user exchanged, never added deliberately. Resource
  names look like `otherContacts/c123`; only names, emails and phones exist.
- **The Workspace directory** (`search_directory`, `list_directory`): the
  user's coworkers and domain contacts. It exists only for Google Workspace
  accounts, and a domain may hide it.

To resolve a name to an email address, search contacts first, then other
contacts, then the directory. No match in one book does not mean the person
is unknown. `people/me` is the signed-in user's own profile.

Searches match prefixes of whole words in names, emails and phone numbers,
not substrings. Google's search index can trail a contact edit by a few
minutes; read a just-changed contact by resource name instead.

## Reading people

A display name is not an identity: several people can share one, and one
person can appear in more than one book. Join on the email address, and report
which book each fact came from. Each field lists entries; `primary` marks the
one Google treats as the person's main value.

<!-- when: writes -->
## Editing contacts

Only the user's own contacts change; other contacts and directory profiles are
read-only. `update_contact` and `update_contact_group` need the `etag` from the
latest read, and a stale etag is refused: read again and rebuild the change.
Each field an update names replaces that whole field, so send every email or
phone the contact should keep. An etag does not make a repeated create safe:
after an uncertain create or copy, search before trying again.

Copying an other contact makes a new contact and leaves the other contact in
place. Groups are labels: deleting a group keeps its contacts unless
`deleteContacts` is true. Google refuses to remove a contact from its last
group; those contacts come back in `notRemovedFromLastGroup` and stay put.
<!-- end -->
