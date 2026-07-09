---
'@runpod/mcp-server': patch
---

URL-encode the resource ids interpolated into the log-streaming request paths (`stream-pod-logs`, `stream-worker-logs`) so an id containing a URL-special character can't corrupt the request path. Opaque Runpod ids are unaffected in practice; this is defensive hardening.
