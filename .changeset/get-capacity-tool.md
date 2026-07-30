---
'@runpod/mcp-server': minor
---

Add `get-capacity`: GPU capacity across host CUDA versions as one matrix call. Agents picking an endpoint's `allowedCudaVersions`/`minCudaVersion` (or diagnosing a capacity-starved endpoint) previously had to reverse-engineer per-version stock by calling the GraphQL `gpuTypes.lowestPrice` query once per CUDA version — an undocumented idiom nobody discovers organically. The default mode returns, per GPU type, overall stock plus AVAILABLE/UNAVAILABLE per host-reported CUDA version in a single credential-free catalog query; passing `cudaVersions` deep-probes those versions instead, returning graded stock (High/Medium/Low) and the lowest on-demand price per version. Works on both v1 and v2 APIs (the v2 REST catalog has no CUDA dimension, so both versions use the public GraphQL catalog).
