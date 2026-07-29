---
'@runpod/mcp-server': patch
---

Make 429s actionable. A bare "rate limit exceeded" invites an immediate retry — the worst possible agent response. On any 429 the error now parses the API's `RateLimit` header and reports which quota window (minute/hour/day) is exhausted and when it resets, e.g. `(rate limited — the hour quota is exhausted; it resets in ~1724s. Wait before retrying and pace bulk operations)`. Falls back to generic back-off guidance when the header is absent (the v1 API sends none). `HttpError.status`/`.body` are unchanged for programmatic callers.
