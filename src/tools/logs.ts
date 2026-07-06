import { z } from 'zod';
import { HttpError } from '../_shared/http.js';
import type { Backend, Resource } from '../_shared/backend.js';
import type { StreamSse, ToolRuntime } from './runtime.js';

// ============== SHARED LOG STREAMING ==============
// Pod logs (GET /v2/pods/{id}/logs) and worker logs
// (GET /v2/serverless/{id}/workers/{workerId}/logs) are the same feature on two
// resources: an SSE stream of `data: {source,line,ts}` frames. This module holds
// everything they share — the frame parser, the param schema, the bounded read,
// and the tool handler — so each tool registration is just a name + a URL.

// One parsed log frame. A payload that isn't JSON is kept verbatim under `raw`.
export interface LogEntry {
  source?: string;
  line?: string;
  ts?: string;
  raw?: string;
}

// Parse SSE text into log frames. Pure, so it's unit-tested without a network.
// Events are separated by a blank line; only `data:` fields are read (`id:`,
// `event:`, and `:` comments are ignored). A `data:` field may span several lines.
export function parseLogSse(raw: string): LogEntry[] {
  const items: LogEntry[] = [];
  for (const block of raw.split(/\r?\n\r?\n/)) {
    const dataLines = block.split(/\r?\n/).filter((l) => l.startsWith('data:'));
    if (!dataLines.length) continue;
    // Drop the `data:` prefix and one optional leading space from each line.
    const payload = dataLines
      .map((l) => l.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!payload.trim()) continue;
    try {
      items.push(JSON.parse(payload) as LogEntry);
    } catch {
      items.push({ raw: payload });
    }
  }
  return items;
}

// How long to hold the stream open, and the byte cap that flips `truncated`.
export const LOG_STREAM_DEFAULT_WAIT_MS = 5000;
export const LOG_STREAM_MAX_BYTES = 256 * 1024;

// Zod params shared by both log tools; spread in alongside the resource id.
export const logStreamParams = {
  source: z
    .enum(['container', 'system', 'both'])
    .optional()
    .describe('Which log source to read (default: both)'),
  tail: z
    .number()
    .int()
    .min(0)
    .max(5000)
    .optional()
    .describe(
      'Historical lines to backfill before live output (API default 100, max 5000; 0 = live only). Ignored when `since` is set.'
    ),
  since: z
    .string()
    .optional()
    .describe('RFC3339 timestamp to resume from; when set, `tail` is ignored.'),
  maxWaitMs: z
    .number()
    .int()
    .min(500)
    .max(30000)
    .optional()
    .describe('How long to read the stream, in ms (default 5000, max 30000)'),
} as const;

export interface LogStreamParams {
  source?: 'container' | 'system' | 'both';
  tail?: number;
  since?: string;
  maxWaitMs?: number;
}

// Read a bounded snapshot of a log endpoint and return the parsed frames.
// `source: 'both'` (or omitted) sends no `source` param — the endpoint returns
// both streams when it's absent (the wire enum is only container|system).
// Throws HttpError on a non-OK response.
export async function collectLogSnapshot(
  streamSse: StreamSse,
  logsUrl: string,
  params: LogStreamParams
): Promise<{ items: LogEntry[]; count: number; truncated: boolean }> {
  const qs = new URLSearchParams();
  if (params.source && params.source !== 'both')
    qs.append('source', params.source);
  if (params.tail !== undefined) qs.append('tail', String(params.tail));
  if (params.since) qs.append('since', params.since);
  const query = qs.toString() ? `?${qs}` : '';
  const { raw, truncated } = await streamSse(`${logsUrl}${query}`, {
    maxWaitMs: params.maxWaitMs ?? LOG_STREAM_DEFAULT_WAIT_MS,
    maxBytes: LOG_STREAM_MAX_BYTES,
  });
  const items = parseLogSse(raw);
  return { items, count: items.length, truncated };
}

// The full handler for a log tool: resolve the backend, gate v2-only, stream a
// snapshot, and map an HTTP error to a JSON reply. `logsUrl` builds the endpoint
// URL from the resolved backend (the resource id is closed over by the caller).
export async function streamLogsReply(
  rt: Pick<ToolRuntime, 'jsonReply' | 'backendFor' | 'streamSse'>,
  tool: {
    name: string;
    resource: Resource;
    logsUrl: (backend: Backend) => string;
  },
  params: LogStreamParams
) {
  const backend = rt.backendFor(tool.resource);
  if (backend.version === 'v1') {
    return rt.jsonReply({
      error: `${tool.name} is only available on the v2 REST API. Set RUNPOD_REST_VERSION=v2.`,
      status: 501,
    });
  }
  try {
    return rt.jsonReply(
      await collectLogSnapshot(rt.streamSse, tool.logsUrl(backend), params)
    );
  } catch (error) {
    if (error instanceof HttpError) {
      return rt.jsonReply({ error: error.message, status: error.status });
    }
    throw error;
  }
}
