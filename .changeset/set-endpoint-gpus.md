---
'@runpod/mcp-server': minor
---

Add a `set-endpoint-gpus` tool that sets which GPUs any Serverless endpoint's workers run on — including pinning specific GPU SKUs, which the REST API cannot express (its pool-level `gpuPoolIds` has no exclusion concept). Callers pass either a raw `gpuIds` string or `pools` plus `excludeGpuTypeIds` (GPU type ids from `list-gpu-types`) and the exclusion string is built automatically; excluding all but one SKU in a pool pins that SKU exactly. Because the GraphQL `saveEndpoint` mutation resets omitted endpoint-level fields to server defaults (verified live), the tool reads the endpoint's current settings first and echoes every field back with only the GPU selection changed — workers, scaling, timeouts, FlashBoot, locations, network volumes, and the template are all preserved.
