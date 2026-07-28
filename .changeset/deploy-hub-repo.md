---
'@runpod/mcp-server': minor
---

Add a `deploy-hub-repo` tool that deploys a Runpod Hub repo's listed release as a new Serverless endpoint — the same operation as clicking Deploy on the Hub. Identify the repo by `repo` ("owner/name") or `hubReleaseId` (both from `list-hub-repos`); the release supplies the prebuilt image, container disk, CUDA constraints, and env-var defaults, with caller overrides for env vars, GPU pools, worker counts, scaling, and FlashBoot. Required env vars without a default fail fast with an actionable message before anything is created, as do POD listings and releases without a GPU pool when none is provided. Uses the authenticated GraphQL `saveEndpoint` mutation (Hub deploys have no REST home yet), so it behaves identically on v1 and v2. The tool runtime gains a `graphqlAuthed` helper (API-key Bearer + variables) to support it.
