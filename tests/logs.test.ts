import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseLogSse,
  collectLogSnapshot,
  readSseSnapshot,
  type SseFetch,
  type SseResponse,
} from '../src/tools/logs.js';
import { HttpError } from '../src/_shared/http.js';

// ── readSseSnapshot: the REAL bounded reader ─────────────────────────────────
// The handler tests inject a fake `streamSse`, so the production read loop (byte
// cap, connect-vs-body abort handling, non-OK → HttpError, once-at-the-end
// decode) is only exercised here, against a mock Response.

// Build a mock fetch that streams the given byte chunks as the response body.
function streamingFetch(
  chunks: Buffer[],
  { ok = true, status = 200 }: { ok?: boolean; status?: number } = {}
): { fetchImpl: SseFetch; aborted: () => boolean } {
  let sawAbort = false;
  const fetchImpl: SseFetch = async (_url, init) => {
    init.signal.addEventListener('abort', () => {
      sawAbort = true;
    });
    const body: AsyncIterable<Buffer> = {
      async *[Symbol.asyncIterator]() {
        for (const c of chunks) yield c;
      },
    };
    const res: SseResponse = {
      ok,
      status,
      text: async () => 'error-body',
      body,
    };
    return res;
  };
  return { fetchImpl, aborted: () => sawAbort };
}

const HDRS = { Authorization: 'Bearer k', Accept: 'text/event-stream' };
const BIG = { maxWaitMs: 5000, maxBytes: 256 * 1024 };

describe('readSseSnapshot (real reader)', () => {
  it('reads the full body under the cap and decodes once (truncated: false)', async () => {
    const { fetchImpl } = streamingFetch([
      Buffer.from('data: {"line":"a"}\n\n'),
      Buffer.from('data: {"line":"b"}\n\n'),
    ]);
    const out = await readSseSnapshot(fetchImpl, 'u', HDRS, BIG);
    assert.equal(out.truncated, false);
    assert.equal(out.raw, 'data: {"line":"a"}\n\ndata: {"line":"b"}\n\n');
  });

  it('decodes a UTF-8 char split across two chunks (concat-then-decode, not per-chunk)', async () => {
    // "é" is 0xC3 0xA9 in UTF-8; split it across the chunk boundary.
    const { fetchImpl } = streamingFetch([
      Buffer.from([0x64, 0x61, 0x74, 0x61, 0x3a, 0x20, 0xc3]), // "data: " + 0xC3
      Buffer.from([0xa9, 0x0a, 0x0a]), // 0xA9 + "\n\n"
    ]);
    const out = await readSseSnapshot(fetchImpl, 'u', HDRS, BIG);
    assert.equal(out.raw, 'data: é\n\n');
  });

  it('body over the byte cap → truncated: true and the stream is aborted', async () => {
    const { fetchImpl, aborted } = streamingFetch([
      Buffer.from('x'.repeat(60)),
      Buffer.from('y'.repeat(60)),
      Buffer.from('z'.repeat(60)), // never reached — cap hits on the 2nd chunk
    ]);
    const out = await readSseSnapshot(fetchImpl, 'u', HDRS, {
      maxWaitMs: 5000,
      maxBytes: 100,
    });
    assert.equal(out.truncated, true);
    assert.equal(out.raw.length, 120); // stopped right after crossing the cap
    assert.equal(aborted(), true);
  });

  it('AbortError thrown while CONNECTING → partial snapshot, no throw (the connect-time fix)', async () => {
    const fetchImpl: SseFetch = async () => {
      const e = new Error('The operation was aborted');
      e.name = 'AbortError';
      throw e;
    };
    const out = await readSseSnapshot(fetchImpl, 'u', HDRS, BIG);
    assert.deepEqual(out, { raw: '', truncated: false });
  });

  it('AbortError thrown mid body read → keeps what was collected, no throw', async () => {
    const fetchImpl: SseFetch = async () => ({
      ok: true,
      status: 200,
      text: async () => '',
      body: {
        async *[Symbol.asyncIterator]() {
          yield Buffer.from('data: {"line":"a"}\n\n');
          const e = new Error('aborted mid-stream');
          e.name = 'AbortError';
          throw e;
        },
      },
    });
    const out = await readSseSnapshot(fetchImpl, 'u', HDRS, BIG);
    assert.equal(out.raw, 'data: {"line":"a"}\n\n');
    assert.equal(out.truncated, false);
  });

  it('non-OK status → throws HttpError carrying the status + body', async () => {
    const { fetchImpl } = streamingFetch([], { ok: false, status: 404 });
    await assert.rejects(
      () => readSseSnapshot(fetchImpl, 'u', HDRS, BIG),
      (err: unknown) => {
        assert.ok(err instanceof HttpError);
        assert.equal(err.status, 404);
        assert.equal(err.body, 'error-body');
        return true;
      }
    );
  });

  it('a non-abort error mid read propagates (not swallowed)', async () => {
    const fetchImpl: SseFetch = async () => ({
      ok: true,
      status: 200,
      text: async () => '',
      body: {
        async *[Symbol.asyncIterator]() {
          throw new Error('connection reset');
        },
      },
    });
    await assert.rejects(
      () => readSseSnapshot(fetchImpl, 'u', HDRS, BIG),
      /connection reset/
    );
  });
});

// ── collectLogSnapshot: truncation trims the trailing partial frame ──────────
describe('collectLogSnapshot', () => {
  const passthroughStreamSse =
    (raw: string, truncated: boolean) => async () => ({ raw, truncated });

  it('drops the last (partial) frame when the stream was truncated', async () => {
    // The final frame is sliced mid-JSON by the byte cap.
    const raw =
      'data: {"line":"a"}\n\ndata: {"line":"b"}\n\ndata: {"line":"c';
    const out = await collectLogSnapshot(
      passthroughStreamSse(raw, true),
      'u',
      {}
    );
    assert.equal(out.truncated, true);
    assert.equal(out.count, 2);
    assert.deepEqual(
      out.items.map((i) => i.line),
      ['a', 'b']
    );
  });

  it('keeps every frame when not truncated', async () => {
    const raw = 'data: {"line":"a"}\n\ndata: {"line":"b"}\n\n';
    const out = await collectLogSnapshot(
      passthroughStreamSse(raw, false),
      'u',
      {}
    );
    assert.equal(out.count, 2);
  });
});

// ── parseLogSse: bare non-object payloads are kept verbatim, not mistyped ────
describe('parseLogSse non-object guard', () => {
  it('a bare JSON number/string/array/null is kept under raw (not a LogEntry)', () => {
    assert.deepEqual(parseLogSse('data: 42\n\n'), [{ raw: '42' }]);
    assert.deepEqual(parseLogSse('data: "hi"\n\n'), [{ raw: '"hi"' }]);
    assert.deepEqual(parseLogSse('data: [1,2]\n\n'), [{ raw: '[1,2]' }]);
    assert.deepEqual(parseLogSse('data: null\n\n'), [{ raw: 'null' }]);
  });

  it('a JSON object frame parses into a LogEntry as before', () => {
    assert.deepEqual(parseLogSse('data: {"line":"x","source":"container"}\n\n'), [
      { line: 'x', source: 'container' },
    ]);
  });
});
