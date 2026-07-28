import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IncomingMessage, ServerResponse } from 'node:http';

import { createCredentialChecker } from '../src/_shared/credential-check.js';
import { handleMcpRequest } from '../src/http.js';

// ============== Credential pre-flight (hosted 401 re-auth) ==============
// A dead bearer (expired/revoked OAuth-minted key) must produce a real HTTP
// 401 + WWW-Authenticate from the hosted server — that response is what makes
// OAuth-capable MCP clients re-run their auth flow. These tests pin the
// checker's verdict logic (observed live backend behavior), its cache, its
// fail-open posture, and the handleMcpRequest wiring end to end.

interface FetchCall {
  url: string;
  init: { method: string; headers: Record<string, string>; body: string };
}

function checkerHarness(opts: {
  status?: number;
  jsonBody?: unknown;
  reject?: boolean;
  now?: () => number;
  validTtlMs?: number;
  invalidTtlMs?: number;
}) {
  const calls: FetchCall[] = [];
  const check = createCredentialChecker({
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (opts.reject) throw new Error('network down');
      const status = opts.status ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => opts.jsonBody ?? {},
      };
    },
    url: () => 'https://graphql.test/graphql',
    now: opts.now,
    validTtlMs: opts.validTtlMs,
    invalidTtlMs: opts.invalidTtlMs,
  });
  return { check, calls };
}

describe('createCredentialChecker — verdicts (pins observed backend behavior)', () => {
  it('valid key: 200 with myself.id → valid; sends the bearer to the auth URL', async () => {
    const { check, calls } = checkerHarness({
      jsonBody: { data: { myself: { id: 'user-1' } } },
    });
    const verdict = await check('rpa_live');
    assert.equal(verdict.valid, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://graphql.test/graphql');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer rpa_live');
    assert.match(calls[0].init.body, /myself \{ id \}/);
  });

  it('expired/revoked key: HTTP 401 → invalid with an actionable reason', async () => {
    const { check } = checkerHarness({ status: 401 });
    const verdict = await check('rpa_dead');
    assert.equal(verdict.valid, false);
    assert.match(verdict.reason!, /expired or revoked/);
  });

  it('anonymous token: 200 with myself:null → invalid (no identity)', async () => {
    const { check } = checkerHarness({ jsonBody: { data: { myself: null } } });
    const verdict = await check('garbage');
    assert.equal(verdict.valid, false);
    assert.match(verdict.reason!, /does not resolve/);
  });

  it('FAILS OPEN on 5xx and on network errors (an auth-backend blip must not take the server down)', async () => {
    const fiveHundred = checkerHarness({ status: 503 });
    assert.equal((await fiveHundred.check('rpa_x')).valid, true);

    const netdown = checkerHarness({ reject: true });
    assert.equal((await netdown.check('rpa_x')).valid, true);
  });

  it('FAILS OPEN on an unrecognized response shape', async () => {
    const { check } = checkerHarness({ jsonBody: { weird: true } });
    assert.equal((await check('rpa_x')).valid, true);
  });
});

describe('createCredentialChecker — cache', () => {
  it('caches a valid verdict (one upstream call for repeated checks)', async () => {
    const { check, calls } = checkerHarness({
      jsonBody: { data: { myself: { id: 'u' } } },
    });
    await check('rpa_live');
    await check('rpa_live');
    await check('rpa_live');
    assert.equal(calls.length, 1);
  });

  it('caches per token — different tokens verify independently', async () => {
    const { check, calls } = checkerHarness({
      jsonBody: { data: { myself: { id: 'u' } } },
    });
    await check('rpa_a');
    await check('rpa_b');
    assert.equal(calls.length, 2);
  });

  it('an invalid verdict expires quickly so a re-authorized user is not locked out', async () => {
    let t = 0;
    const { check, calls } = checkerHarness({
      status: 401,
      now: () => t,
      invalidTtlMs: 1000,
    });
    assert.equal((await check('rpa_dead')).valid, false);
    t = 500; // still cached
    assert.equal((await check('rpa_dead')).valid, false);
    assert.equal(calls.length, 1);
    t = 1500; // past the invalid TTL → re-verify upstream
    await check('rpa_dead');
    assert.equal(calls.length, 2);
  });

  it('a valid verdict re-verifies after its TTL (revocation is noticed)', async () => {
    let t = 0;
    const { check, calls } = checkerHarness({
      jsonBody: { data: { myself: { id: 'u' } } },
      now: () => t,
      validTtlMs: 10_000,
    });
    await check('rpa_live');
    t = 9_999;
    await check('rpa_live');
    assert.equal(calls.length, 1);
    t = 10_001;
    await check('rpa_live');
    assert.equal(calls.length, 2);
  });
});

// ---- handleMcpRequest wiring: dead credential → HTTP 401 + WWW-Authenticate ----

function fakeReqRes(headers: Record<string, string>) {
  const req = {
    method: 'POST',
    url: '/mcp',
    headers: { host: 'mcp.test', ...headers },
  } as unknown as IncomingMessage;

  const written: {
    statusCode?: number;
    headers?: Record<string, string>;
    body?: string;
  } = {};
  const res = {
    writeHead(statusCode: number, hdrs: Record<string, string>) {
      written.statusCode = statusCode;
      written.headers = hdrs;
      return this;
    },
    end(body?: string) {
      written.body = body;
    },
    on() {},
  } as unknown as ServerResponse;

  return { req, res, written };
}

describe('handleMcpRequest — credential pre-flight', () => {
  it('dead credential → HTTP 401 with WWW-Authenticate resource metadata (the re-auth trigger)', async () => {
    const { req, res, written } = fakeReqRes({
      authorization: 'Bearer rpa_dead',
    });
    await handleMcpRequest(req, res, {
      verifyCredential: async () => ({
        valid: false,
        reason: 'The Runpod API rejected the credential.',
      }),
    });
    assert.equal(written.statusCode, 401);
    assert.match(
      written.headers!['WWW-Authenticate'],
      /^Bearer realm="mcp", resource_metadata="https:\/\/mcp\.test\/\.well-known\/oauth-protected-resource"$/
    );
    const body = JSON.parse(written.body!) as { error: string };
    assert.match(body.error, /Re-authenticate to continue/);
  });

  it('missing bearer still 401s with WWW-Authenticate (pre-existing behavior, no checker call)', async () => {
    let checkerCalls = 0;
    const { req, res, written } = fakeReqRes({});
    await handleMcpRequest(req, res, {
      verifyCredential: async () => {
        checkerCalls++;
        return { valid: true };
      },
    });
    assert.equal(written.statusCode, 401);
    assert.ok(written.headers!['WWW-Authenticate']);
    assert.equal(checkerCalls, 0);
  });

  it('MCP_SKIP_CREDENTIAL_CHECK=true bypasses the pre-flight', async () => {
    process.env.MCP_SKIP_CREDENTIAL_CHECK = 'true';
    try {
      let checkerCalls = 0;
      const { req, res, written } = fakeReqRes({
        authorization: 'Bearer rpa_dead',
      });
      // With the check skipped the request proceeds into the MCP transport,
      // which will fail on this fake req/res — that's fine; the assertion is
      // that no 401 was written and the checker was never consulted.
      await handleMcpRequest(req, res, {
        verifyCredential: async () => {
          checkerCalls++;
          return { valid: false };
        },
      }).catch(() => {});
      assert.equal(checkerCalls, 0);
      assert.notEqual(written.statusCode, 401);
    } finally {
      delete process.env.MCP_SKIP_CREDENTIAL_CHECK;
    }
  });
});
