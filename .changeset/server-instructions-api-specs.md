---
'@runpod/mcp-server': minor
---

Add server instructions (sent in the `initialize` response) pointing agents at the machine-readable API contracts: the REST v2 OpenAPI spec at api.runpod.io/v2/openapi.json and the GraphQL schema reference at graphql-spec.runpod.io. The MCP tools are curated projections of the underlying APIs; this gives agents a discoverable escape hatch when a tool doesn't expose the field or parameter they need, instead of a dead end. Also moves the `capabilities` object to the `ServerOptions` argument of the `McpServer` constructor, where the SDK actually reads it.
