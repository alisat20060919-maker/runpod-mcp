---
'@runpod/mcp-server': minor
---

Fix two template gaps from the same ticket (API-385 / E-3717).

1. `create-template`/`update-template` were dropping the container start command on the v2 REST API. `dockerStartCmd` is now mapped to the v2 template's `args` field (a single string; a multi-element array is space-joined) instead of being discarded, so a template's startup command is persisted. `update-template` accepts `dockerStartCmd` now too. (v2 has no separate entrypoint field, so `dockerEntrypoint` is still not persisted on v2 — documented in the tool.)

2. `create-pod` can now deploy from a template. v2 `CreatePodRequest` has no `templateId`, so `create-pod` accepts a `templateId`, fetches the template, and spreads its container config (image, start command, ports, env, disk, volume, registry credential) into the pod body as defaults — any field you also pass explicitly overrides the template. `imageName` is now optional when `templateId` is given. Template-based deploy requires the v2 REST API and (for now) a GPU pod; clear errors are returned for v1, CPU, or when neither image nor template is supplied.
