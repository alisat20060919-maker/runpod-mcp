---
'@runpod/mcp-server': patch
---

create-pod template deploy: address review — do not inject a template's `registry` credential into the pod body (it was un-overridable and produced an unverified v2 pod-create shape), and fetch the template from v2 explicitly so a split per-resource version override can't yield a v1 template shape. Tool description updated to note a template registry credential is not applied.
