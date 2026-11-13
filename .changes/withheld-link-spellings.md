---
type: fixed
---

Withheld-link write admission now recognizes every spelling a recipient reconstructs: numeric character references with any number of leading zeros, every ASCII-valued HTML named reference (`&Tab;`, `&NewLine;`, `&lbrack;`, `&rsqb;`), tabs and line breaks the URL parser strips inside quoted attribute values, angle-bracketed tags and space-free values, and RFC 5322 quoted-pairs in Gmail raw message headers such as display names and `filename="…"` parameters.
