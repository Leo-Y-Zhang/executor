---
"apps": patch
---

Preserve imported JSON Schema documents in object fields, arrays, records and
optional/default wrappers so tool schemas and describe signatures show the
constraints their validators enforce. Relocate local references and conflicting
definitions safely, and prevent nested document IDs or dialects from changing the
parent schema. Nested imports declaring another dialect must be used at the root
or converted to draft 2020-12.
