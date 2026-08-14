---
'@runpod/mcp-server': minor
---

`list-gpu-types` and `get-gpu-type` now always send `product` with their `include=AVAILABILITY` catalog requests, via a new optional `product` parameter (`POD` | `CLUSTER` | `SERVERLESS`, default `POD`). Availability is product-specific — the same GPU can be scarce for Pods and plentiful for Serverless — and the next v2 API release makes `product` required with availability (400 without it), so this keeps the availability lookups working and lets agents ask for the context they actually deploy to: pass `SERVERLESS` when picking a GPU for an endpoint, `CLUSTER` for Instant Clusters. When `includeAvailability` is false, `product` is not sent (the API also rejects `product` without `include=AVAILABILITY`). The CPU catalog tools never request availability, so they are unaffected.
