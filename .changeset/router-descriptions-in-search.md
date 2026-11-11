---
"@executor-js/mcp": patch
"@executor-js/app-templates": patch
---

`tools.search` and `tools.search.describe` list a router's description beside its
title in `namespaces`, as the first non-empty line cut to 200 characters, the way
search shows a tool's description. A router with a description and no title is
now listed too, without `router`. The app-authoring skill says that search shows
only that first line and that `describe` returns a tool's description whole.
