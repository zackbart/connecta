---
type: fixed
---

Withheld-link write admission recognizes more spellings of a copied `[redacted]` link: numeric character references with any number of leading zeros, the ASCII-valued HTML named references (`&Tab;`, `&NewLine;`, `&lbrack;`, `&rsqb;`), tabs and line breaks (written or referenced) that split the marker or separate it from a valueless parameter such as `?token=`, and RFC 5322 quoted-pairs in Gmail raw message headers such as display names and `filename="…"` parameters. A line break after a complete link still ends it, so prose that puts `[redacted]` on the next line is admitted. Every spelling refused before is still refused.
