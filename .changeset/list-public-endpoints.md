---
'@runpod/mcp-server': minor
---

Add a `list-public-endpoints` tool for discovering Runpod Public Endpoints — the managed, pay-per-use model APIs (text, image, video, audio) that require no deployment. Served by the public GraphQL endpoint — no auth required — and available on both v1 and v2. Each result includes the `endpointId` to call with `run-endpoint`/`runsync-endpoint` (or directly at `https://api.runpod.ai/v2/{endpointId}`), plus the model name, modality, owner, and pricing parsed from the catalog metadata. Only live endpoints are listed by default (`includeOffline:true` to include the rest), with `searchTerm`, `modality`, and `owner` filters and the shared pagination envelope.
