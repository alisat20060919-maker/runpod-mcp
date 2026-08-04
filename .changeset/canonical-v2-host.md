---
'@runpod/mcp-server': minor
---

Default REST v2 base URL is now `https://api.runpod.io/v2` (the documented canonical host) instead of `https://v2-rest.runpod.io/v2`. Both hosts serve the same API; deployments that pin `RUNPOD_REST_V2_API_URL` are unaffected. Server instructions updated to match.
