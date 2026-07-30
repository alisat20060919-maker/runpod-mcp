---
'@runpod/mcp-server': patch
---

Surface HTTP-level GraphQL failures by status instead of as parse errors. The GraphQL helper (behind `list-gpu-types`, `list-data-centers`, `get-capacity`, `list-hub-repos`, `list-public-endpoints`, `deploy-hub-repo`, and `set-endpoint-gpus`) previously called `response.json()` unconditionally, so a 429 or 5xx returning an HTML error page surfaced as an opaque `Unexpected token '<'` parse error. Non-OK responses now throw the same `HttpError` as the REST client — status and body named, with the `RateLimit` wait hint on 429 — completing the treatment the REST client received. A non-OK body that still carries a GraphQL `errors` array keeps the readable GraphQL message, with the HTTP status attached.
