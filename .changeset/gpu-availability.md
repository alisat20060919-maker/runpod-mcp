---
'@runpod/mcp-server': minor
---

Surface realtime GPU availability on the v2 catalog. `list-gpu-types` now requests `?include=AVAILABILITY` by default, so each GPU carries an `availability` summary (HIGH/MEDIUM/LOW/NONE), results are sorted highest-stock-first, and `includeUnavailable` is a real filter (out-of-stock GPUs are hidden by default) instead of the previous no-op. A new `includeAvailability` param (default true) can opt out of the stock lookup. `get-gpu-type` returns the per-datacenter availability breakdown (and URL-encodes ids, which contain spaces) so callers can pick a `dataCenterIds` with stock before creating a pod. Falls back gracefully when the backend doesn't populate availability.

Behavior change to note: `list-gpu-types` previously returned the full GPU list in a stable order; it now hides out-of-stock GPUs and reorders by stock. A consumer doing a capacity or price survey will see fewer, reordered results by default — pass `includeUnavailable: true` to get the complete list back.
