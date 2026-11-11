---
"@executor-js/mcp": patch
---

Accept dotted `tools.my-app.sources.add` string paths in call and describe for
valid app slugs. Unknown dotted paths suggest the JavaScript bracket form and
list the closest tools in the app. Execute errors for a dotted hyphenated app
name suggest brackets, since JavaScript treats the hyphen as subtraction.
