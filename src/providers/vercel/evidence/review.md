# Vercel value-safety review

Step 1 retains the reviewed verdicts, paths, field exemptions and acknowledged
absences from #801, #812 and #890. Project environment reads can return decrypted
values: generic access stays refused; the named metadata read sends decrypt=false
and removes values. No write or destructive tool becomes a read.

Embedded URL handling remains scoped to reviewed deployment/log fields, with
global signing-parameter defense and withheld-link admission on every write,
including decoded upload bytes and deployment file base64.

The reviewed response candidates and OpenAPI pin retain their original bytes.
