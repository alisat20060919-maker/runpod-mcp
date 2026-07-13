---
'@runpod/mcp-server': patch
---

Surface the configured `RUNPOD_REST_VERSION` in the MCP `serverInfo` version, e.g. `2.0.0 [RUNPOD_REST_VERSION=v2]` (or `RUNPOD_REST_VERSION unset (default v2)`). A plain `initialize` handshake now reveals whether a deployment is running v1 or v2 without inspecting the environment, and flags any per-resource overrides.
