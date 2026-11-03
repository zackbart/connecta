---
type: changed
breaking: true
---

Put pool scope and the guide pointer before routing rules in meta and native endpoint instructions, preserving unscoped instructions.

Pool descriptions are limited to 500 UTF-16 code units after trimming so accepted text fits the instruction budget and first 512 units in every mode. This tightens validation: previously accepted descriptions with at most 500 Unicode code points but more than 500 UTF-16 units (for example, 500 emoji) now fail construction. Shorten those descriptions before upgrading; required routing rules remain intact.
