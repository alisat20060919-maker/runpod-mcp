---
'@runpod/mcp-server': minor
---

Surface realtime GPU availability on the v2 catalog. `list-gpu-types` now requests `?include=AVAILABILITY`, so each GPU carries an `availability` summary (HIGH/MEDIUM/LOW/NONE), results are sorted highest-stock-first, and `includeUnavailable` is a real filter (out-of-stock GPUs are hidden by default) instead of the previous no-op. `get-gpu-type` returns the per-datacenter availability breakdown (and URL-encodes ids, which contain spaces) so callers can pick a `dataCenterIds` with stock before creating a pod. Falls back gracefully when the backend doesn't populate availability.
