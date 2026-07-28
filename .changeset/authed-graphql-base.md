---
'@runpod/mcp-server': minor
---

Add `RUNPOD_AUTHED_GRAPHQL_URL` to override the GraphQL host used by authenticated operations that have no REST equivalent (`deploy-hub-repo`, `set-endpoint-gpus`). These calls send the caller's API key as a Bearer token, so they no longer follow `RUNPOD_PUBLIC_GRAPHQL_URL` — that variable stays the credential-free discovery override, safe to point at a stub.
