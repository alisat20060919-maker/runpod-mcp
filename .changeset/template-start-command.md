---
'@runpod/mcp-server': patch
---

Fix `create-template`/`update-template` dropping the container start command on the v2 REST API. The `dockerStartCmd` parameter is now mapped to the v2 template's `args` field (a single string; a multi-element array is space-joined) instead of being discarded, so a template's startup command is persisted. `update-template` also accepts `dockerStartCmd` now. Note: v2 has no separate entrypoint field, so `dockerEntrypoint` is still not persisted on v2 (documented in the tool).
