---
'@runpod/mcp-server': minor
---

Surface dead credentials as a proper HTTP 401 on the HTTP server so OAuth-capable MCP clients re-authenticate automatically.

Previously, when a bearer token was revoked mid-session (e.g. an OAuth-minted key), every upstream Runpod call failed with a 401 that the MCP SDK wrapped into a 200 JSON-RPC tool error — the client never saw an HTTP 401, never re-ran its auth flow, and the user was stuck with bare "Unauthorized" tool errors until they manually reconnected. The request handler now pre-flight verifies the bearer (one `myself` GraphQL query, cached ~60s valid / ~30s invalid by token hash, never the raw token) and answers `401` + `WWW-Authenticate` with the protected-resource metadata when the credential is dead. `WWW-Authenticate` is exposed via CORS so browser clients can read it, and a rejected credential carries `error="invalid_token"` to distinguish it from a request that sent none (RFC 6750 §3.1). `ToolContext` gains an optional `onUnauthorized` callback, invoked when an outbound call returns 401, which drops the cached verdict so the next request re-checks.

The check is deliberately conservative so it can never reject a working key:

- It fails **open** on anything indeterminate — auth-backend errors, 5xx, 403 (this host sits behind a WAF, and a block is not a revocation), a slow backend (time-bound), and a GraphQL response carrying an `errors` array (a resolver blip returns `myself: null` for everyone at once; treating that as invalid would 401 every valid key). Failing closed on any of these would make OAuth clients re-run the flow, minting a new API key per attempt — an unrecoverable loop.
- It runs only for the requests the transport would actually run a tool for: a `POST` whose `Content-Type` the SDK treats as JSON and whose body invokes a method (including inside a batch). Everything else is passed through unchecked.
- It self-disables (logging `skip_env_mismatch`) when the REST/Serverless hosts and the auth-GraphQL host disagree about environment in either direction, since it would otherwise validate a key against the wrong backend.
- Request bodies are capped at 4 MB (matching the SDK) on hosts that do not pre-parse them.
- The verdict cache is safe under load: eviction never disowns an in-flight check, and TTLs use a monotonic clock, so a burst of distinct tokens or a wall-clock adjustment cannot let a since-revoked key linger as `valid`.

Set `MCP_SKIP_CREDENTIAL_CHECK=true` to disable the pre-flight entirely.

Notes for consumers of the published `./http` export (not only the hosted deployment): the pre-flight adds one outbound `myself` call to the Runpod GraphQL host per checked request, and a new dependency on that host being reachable (it fails open if not). This does **not** close the pre-existing key-validity oracle — a caller who speaks MCP can still learn 401-vs-not for a token, one upstream call each, with no rate limiting; closing that needs rate limiting, which this does not add.
