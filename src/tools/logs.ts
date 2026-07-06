import { z } from 'zod';
import type { StreamSse } from './runtime.js';

// ============== SHARED LOG STREAMING ==============
// Both pod logs (GET /v2/pods/{id}/logs) and serverless worker logs
// (GET /v2/serverless/{id}/workers/{workerId}/logs) are Server-Sent-Event
// streams with an identical contract: `content-type: text/event-stream` of
// `data: {"source","line","ts"}` frames (each frame optionally preceded by an
// `id:` = ts line for EventSource `Last-Event-ID` resume). This module holds the
// pieces they share — the SSE frame parser, the tool parameter schema, and the
// bounded read step — so the two tool handlers stay thin and the risky parsing
// logic is unit-tested once, offline.

// One parsed SSE log frame. The API emits `data: {"source","line","ts"}` events;
// a frame whose payload doesn't parse as JSON is preserved verbatim under `raw`
// rather than dropped.
export interface LogEntry {
  source?: string;
  line?: string;
  ts?: string;
  raw?: string;
}

// Parse raw SSE event-stream text into log entries. Pure (no I/O), so the risky
// parsing logic is unit-tested without a network. SSE events are separated by a
// blank line; the payload is the `data:` field (possibly spanning multiple
// `data:` lines per the SSE spec). Non-JSON payloads fall back to `{raw}`. Other
// fields (`id:`/`event:`) and comment lines (`:`...) are ignored.
export function parseLogSse(raw: string): LogEntry[] {
  const items: LogEntry[] = [];
  for (const block of raw.split(/\r?\n\r?\n/)) {
    const dataLines = block.split(/\r?\n/).filter((l) => l.startsWith('data:'));
    if (!dataLines.length) continue;
    // Strip the `data:` field name and one optional leading space per line.
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

// Read cap for a log snapshot: how long to hold the stream open, and the byte
// ceiling that flips `truncated`. Kept here so both log tools agree.
export const LOG_STREAM_DEFAULT_WAIT_MS = 5000;
export const LOG_STREAM_MAX_BYTES = 256 * 1024;

// Shared Zod parameter schema for the two log tools. Spread into each
// server.tool() registration alongside the resource id (podId / workerId).
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
      'Number of historical lines to backfill before live output (API default 100, max 5000; 0 = live only). Ignored when `since` is set.'
    ),
  since: z
    .string()
    .optional()
    .describe(
      'RFC3339 timestamp to resume from. When set, the stream resumes from this point and `tail` is ignored.'
    ),
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

// Bounded read of a log SSE endpoint. Builds the query string, reads up to the
// byte/time cap via the injected `streamSse`, and returns the parsed frames.
// `source: 'both'` (or omitted) sends NO `source` param — the wire enum is only
// container|system, and the endpoint returns both streams when it is absent.
// Throws HttpError on a non-OK response (the caller maps it to a JSON error
// reply).
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
  const queryString = qs.toString() ? `?${qs.toString()}` : '';
  const { raw, truncated } = await streamSse(`${logsUrl}${queryString}`, {
    maxWaitMs: params.maxWaitMs ?? LOG_STREAM_DEFAULT_WAIT_MS,
    maxBytes: LOG_STREAM_MAX_BYTES,
  });
  const items = parseLogSse(raw);
  return { items, count: items.length, truncated };
}
