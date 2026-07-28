---
'@runpod/mcp-server': minor
---

Add a `list-hub-repos` tool for discovering the Runpod Hub catalog (prebuilt Serverless workers and Pod templates such as vLLM, ComfyUI, and Axolotl). Served by the public GraphQL endpoint — no auth required — and available on both v1 and v2. Each result includes the repo metadata (stars, deploys, category, tags) plus the currently listed release with its `hubReleaseId` and prebuilt `imageName`, the two values a Hub deploy is pinned to. Supports `searchTerm`, `category`, `type` (SERVERLESS/POD), and `repoOwner` filters (applied client-side), and an opt-in `includeConfig` that returns the release's parsed hardware/env-var config from `.runpod/hub.json`. Results are sorted most-deployed first and use the shared pagination envelope.
