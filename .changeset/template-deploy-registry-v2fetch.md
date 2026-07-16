---
'@runpod/mcp-server': minor
---

create-pod template deploy improvements. Added a `containerRegistryAuthId` param to `create-pod` (private-image registry credential, a valid v2 ContainerConfig field). When deploying from a `templateId`, the template's registry credential is inherited as a default so a private-image template pulls correctly, `containerRegistryAuthId` overrides it, and passing an empty string opts out entirely (emits `registry: null`, which v2 accepts, clearing the template's credential). The template is fetched from v2 explicitly, so a split per-resource version override (e.g. templates pinned to v1) can't yield a v1-shaped template merged into a v2 pod body. Tool descriptions now state that template fields are applied whole-field as defaults (an explicitly-passed field replaces the template value rather than merging).
