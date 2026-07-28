// ============== HOSTED CREDENTIAL PRE-FLIGHT ==============
// The hosted HTTP server forwards the caller's Bearer token straight to the
// Runpod API. When that credential dies mid-session (the OAuth-minted key
// expires or is revoked), every tool call fails upstream with a 401 — but the
// MCP SDK wraps thrown tool errors into a 200 JSON-RPC tool result, so the
// client never sees an HTTP 401 and never re-runs its OAuth flow. The user is
// stuck with bare "Unauthorized" tool errors until they manually reconnect.
//
// This module verifies the credential BEFORE the MCP request is handled, so
// a dead credential turns into a proper HTTP 401 + WWW-Authenticate response
// (src/http.ts writeUnauthorized) — the signal OAuth-capable MCP clients use
// to re-authenticate automatically.
//
// Verification is one authenticated `myself { id }` GraphQL query. Observed
// live behavior of the backend:
//   - invalid/expired key  → HTTP 401
//   - anonymous (no ident) → HTTP 200 with `myself: null`
//   - valid key            → HTTP 200 with `myself.id`
// Verdicts are cached in-memory by token hash (never the raw token) so a warm
// instance adds no per-request latency: valid verdicts live for a few minutes,
// invalid ones briefly (a just-reauthorized user shouldn't wait long). Network
// failures and 5xx responses FAIL OPEN — the request proceeds and the tools
// surface the real upstream error — so an auth-backend blip can't take down
// the whole server.

import { createHash } from 'node:crypto';

export interface CredentialVerdict {
  valid: boolean;
  // Why an invalid verdict was reached, for the 401 response body.
  reason?: string;
}

export type CredentialChecker = (token: string) => Promise<CredentialVerdict>;

interface FetchResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
  }
) => Promise<FetchResponseLike>;

const VALID_TTL_MS = 5 * 60_000;
const INVALID_TTL_MS = 30_000;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function createCredentialChecker(deps: {
  fetch: FetchLike;
  // Resolved per call so an env change takes effect without a module reload
  // (matches how the tool runtime resolves its base URLs).
  url: () => string;
  now?: () => number;
  validTtlMs?: number;
  invalidTtlMs?: number;
}): CredentialChecker {
  const now = deps.now ?? Date.now;
  const validTtl = deps.validTtlMs ?? VALID_TTL_MS;
  const invalidTtl = deps.invalidTtlMs ?? INVALID_TTL_MS;
  const cache = new Map<
    string,
    { verdict: CredentialVerdict; expiresAt: number }
  >();

  return async function verifyCredential(
    token: string
  ): Promise<CredentialVerdict> {
    const key = hashToken(token);
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now()) return cached.verdict;
    // Expired entries are dropped lazily; the cache stays bounded because a
    // stateless instance only ever sees a handful of distinct tokens.
    if (cached) cache.delete(key);

    let verdict: CredentialVerdict;
    try {
      const response = await deps.fetch(deps.url(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ query: 'query { myself { id } }' }),
      });

      if (response.status === 401 || response.status === 403) {
        verdict = {
          valid: false,
          reason:
            'The Runpod API rejected the credential (it may be expired or revoked).',
        };
      } else if (!response.ok) {
        // 5xx / unexpected status from the auth backend — fail open.
        verdict = { valid: true };
      } else {
        const result = (await response.json()) as {
          data?: { myself?: { id?: string } | null };
        };
        if (result?.data?.myself?.id) {
          verdict = { valid: true };
        } else if (result?.data && result.data.myself === null) {
          // The backend treated the request as anonymous — the token carries
          // no identity, so every downstream call would 401.
          verdict = {
            valid: false,
            reason: 'The credential does not resolve to a Runpod account.',
          };
        } else {
          // Unrecognized response shape — fail open.
          verdict = { valid: true };
        }
      }
    } catch {
      // Network error reaching the auth backend — fail open.
      verdict = { valid: true };
    }

    cache.set(key, {
      verdict,
      expiresAt: now() + (verdict.valid ? validTtl : invalidTtl),
    });
    return verdict;
  };
}
