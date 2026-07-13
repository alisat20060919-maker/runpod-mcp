---
'@runpod/mcp-server': minor
---

Surface realtime GPU availability on the v2 catalog. `list-gpu-types` now requests `?include=AVAILABILITY` by default, so each GPU carries an `availability` summary (HIGH/MEDIUM/LOW/NONE) and results are sorted highest-stock-first. The full catalog is still returned by default — nothing is hidden — so the tool stays complete for discovery and capacity/price surveys. `includeUnavailable` is now an opt-in *hide*: pass `includeUnavailable: false` to drop out-of-stock GPUs and list only currently-deployable ones. A new `includeAvailability` param (default true) can opt out of the stock lookup entirely. `get-gpu-type` returns the per-datacenter availability breakdown (and URL-encodes ids, which contain spaces) so callers can pick a `dataCenterIds` with stock before creating a pod. Falls back gracefully when the backend doesn't populate availability.

Behavior change to note: `list-gpu-types` still returns every GPU by default, but results are now sorted highest-stock-first rather than in a stable order. Nothing is hidden by default.
