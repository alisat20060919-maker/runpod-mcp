---
'@runpod/mcp-server': patch
---

`create-pod` now returns a clean local 400 when `name` is omitted on a v2 GPU create without a `templateId`, matching the v2 spec (`CreatePodRequest` requires `name`) instead of surfacing the API's raw 422. Template deploys (name inherited from the template) and CPU pods (routed to v1) are unaffected.
