# v2 log streaming (pods + serverless workers)

How the MCP server exposes the v2 log endpoints (PR #52), what the API contract
is, and how to test it end-to-end.

## Endpoints

- `GET /v2/pods/{id}/logs` — `getPodLogs` → tool `stream-pod-logs`
- `GET /v2/serverless/{id}/workers/{workerId}/logs` — `getWorkerLogs` → tool `stream-worker-logs`

Both share the same contract and the same shared implementation in
`src/tools/logs.ts`.

## API contract

From `https://v2-rest.runpod.io/v2/openapi.yaml`:

- **Transport:** Server-Sent Events. `content-type: text/event-stream`.
- **Body:** a stream of `data:` frames, each a JSON object; frames may be preceded
  by an `id:` line (= the event `ts`) so an EventSource can resume via `Last-Event-ID`:

  ```
  id: 2026-07-06T22:04:13Z
  data: {"source":"system","line":"create 20GB volume","ts":"2026-07-06T22:04:13Z"}

  id: 2026-07-06T22:04:14Z
  data: {"source":"container","line":"CUDA Version 12.4.1","ts":"2026-07-06T22:04:14Z"}
  ```

- **Frame fields:** `source` (`container | system`), `line` (message), `ts` (RFC3339).
- **Query params:**
  - `source` — enum `container | system`; **omit to include both**.
  - `tail` — historical lines to backfill (default 100, max 5000; `0` = live only).
  - `since` — RFC3339 timestamp to resume from (ignored when `Last-Event-ID` is sent).
  - `Last-Event-ID` — header, SSE reconnect cursor.

## How the MCP tools work

MCP tools return a single result, not an open stream, so each tool reads a
**bounded snapshot**: it opens the SSE stream, accumulates frames until either
`maxWaitMs` elapses (default 5s, max 30s) or a 256 KB byte cap is hit, then parses
the collected `data:` frames and returns them.

- A clean timeout is a normal end (the stream stays open to tail live output), not
  an error — only a non-OK HTTP status throws.
- `source: 'both'` (the default) sends no `source` query param, so the API returns
  both streams. `container`/`system` are passed through.
- `truncated: true` in the result means the byte cap cut the snapshot short.

Tool parameters (`source`, `tail`, `since`, `maxWaitMs`) plus the resource id
(`podId`, or `endpointId` + `workerId`).

Result shape:

```json
{
  "items": [
    {
      "source": "system",
      "line": "create 20GB volume",
      "ts": "2026-07-06T22:04:13Z"
    }
  ],
  "count": 1,
  "truncated": false
}
```

## How to test

### 1. Raw curl (see the SSE frames)

```bash
KEY=<runpod-api-key>
POD=<pod-id>

curl -sN --max-time 12 -D - \
  "https://v2-rest.runpod.io/v2/pods/$POD/logs?tail=100" \
  -H "Authorization: Bearer $KEY" \
  -H "Accept: text/event-stream"
```

Route-exists check (live route = `404` for a bad id; a missing route returns
`422 "GET Path ... not found"`):

```bash
curl -s "https://v2-rest.runpod.io/v2/pods/does-not-exist/logs" \
  -H "Authorization: Bearer $KEY"
# {"detail":"pod not found","status":404,"title":"Not Found"}   ← route exists
```

### 2. Through the MCP tool (end-to-end)

Drive the actual tool handler against v2 (no MCP client needed):

```ts
// scripts/_logtest.ts  (temporary — delete after)
import { registerTools } from '../src/tools.js';

const handlers = new Map<
  string,
  (a: unknown) => Promise<{ content: Array<{ text: string }> }>
>();
const server = {
  tool(name: string, ...args: unknown[]) {
    const last = args.at(-1);
    if (typeof last === 'function') handlers.set(name, last as never);
  },
  server: { getClientVersion: () => ({ name: 'log-verify', version: '0' }) },
} as never;

process.env.RUNPOD_REST_VERSION = 'v2';
process.env.RUNPOD_REST_V2_API_URL = 'https://v2-rest.runpod.io/v2';
registerTools(server, {
  apiKey: process.env.KEY as string,
  transport: 'stdio',
});

const call = async (n: string, a: Record<string, unknown>) =>
  JSON.parse((await handlers.get(n)!(a)).content[0].text);

const podId = process.env.POD as string;
console.log('both     :', (await call('stream-pod-logs', { podId })).count);
console.log(
  'system   :',
  (await call('stream-pod-logs', { podId, source: 'system' })).count
);
console.log(
  'container:',
  (await call('stream-pod-logs', { podId, source: 'container' })).count
);
```

```bash
KEY=<key> POD=<pod-id> pnpm tsx scripts/_logtest.ts
```

Expected: non-zero counts, `source=system`/`source=container` narrower than `both`.

### 3. Offline unit + handler tests

```bash
pnpm test
```

- `tests/mappers.test.ts` → `parseLogSse` covers frame parsing (multi-line `data:`,
  CRLF, `id:`-prefixed frames, non-JSON payloads, empty stream).
- `tests/handlers.test.ts` → drives both tools through the injected `streamSse` seam
  and locks URL/query building + parsed output.
