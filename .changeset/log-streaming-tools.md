---
'@runpod/mcp-server': minor
---

Enable pod and serverless worker log streaming (v2). `stream-pod-logs` (GET /v2/pods/{id}/logs) is now registered — it was previously implemented but disabled while the endpoint was dev-only, and it is now live on prod. A new `stream-worker-logs` tool (GET /v2/serverless/{id}/workers/{workerId}/logs) streams a single worker's logs; get the workerId from `list-endpoint-workers`. Both fetch a bounded snapshot of the live Server-Sent-Events stream (container and/or system) and support `source`, `tail`, `since`, and `maxWaitMs`; both return a 501 notice on the v1 API.
