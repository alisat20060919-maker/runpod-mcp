import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildHubEnv, minCudaVersion } from '../src/tools/hub.js';

// Direct unit tests for the two pure helpers behind deploy-hub-repo. A single
// happy-path handler test was the only prior coverage, so the env-merge edge
// cases were invisible: an empty override satisfying a required key, caller
// booleans skipping trueValue/falseValue serialization.

describe('buildHubEnv', () => {
  it('applies schema defaults, serializing boolean defaults through trueValue/falseValue', () => {
    const { env, missingRequired } = buildHubEnv(
      {
        env: [
          { key: 'PLAIN', input: { default: 'hello' } },
          { key: 'NUMERIC', input: { default: 7 } },
          {
            key: 'FLAG_ON',
            input: { type: 'boolean', default: true, trueValue: '1' },
          },
          {
            key: 'FLAG_OFF',
            input: { type: 'boolean', default: false, falseValue: '0' },
          },
        ],
      },
      {}
    );
    assert.deepEqual(env, [
      { key: 'PLAIN', value: 'hello' },
      { key: 'NUMERIC', value: '7' },
      { key: 'FLAG_ON', value: '1' },
      { key: 'FLAG_OFF', value: '0' },
    ]);
    assert.deepEqual(missingRequired, []);
  });

  it('reports required keys that have no default and no override', () => {
    const { missingRequired } = buildHubEnv(
      {
        env: [
          { key: 'MODEL_NAME', input: { required: true } },
          { key: 'OPTIONAL', input: {} },
        ],
      },
      {}
    );
    assert.deepEqual(missingRequired, ['MODEL_NAME']);
  });

  it('treats an EMPTY override as not supplied for a required key', () => {
    // Regression: the guard was `key in overrides`, so '' satisfied a required
    // key — fail-fast passed and the deploy produced a broken worker.
    const { env, missingRequired } = buildHubEnv(
      { env: [{ key: 'MODEL_NAME', input: { required: true } }] },
      { MODEL_NAME: '' }
    );
    assert.deepEqual(missingRequired, ['MODEL_NAME']);
    assert.deepEqual(env, [{ key: 'MODEL_NAME', value: '' }]);
  });

  it('serializes CALLER-supplied booleans through trueValue/falseValue too', () => {
    // An agent naturally sends 'true'; without this the worker receives 'true'
    // where its own schema says '1'.
    const { env } = buildHubEnv(
      {
        env: [
          {
            key: 'TRUST_REMOTE_CODE',
            input: {
              type: 'boolean',
              default: false,
              trueValue: '1',
              falseValue: '0',
            },
          },
        ],
      },
      { TRUST_REMOTE_CODE: 'true' }
    );
    assert.deepEqual(env, [{ key: 'TRUST_REMOTE_CODE', value: '1' }]);

    const off = buildHubEnv(
      {
        env: [
          {
            key: 'TRUST_REMOTE_CODE',
            input: {
              type: 'boolean',
              default: true,
              trueValue: '1',
              falseValue: '0',
            },
          },
        ],
      },
      { TRUST_REMOTE_CODE: 'false' }
    );
    assert.deepEqual(off.env, [{ key: 'TRUST_REMOTE_CODE', value: '0' }]);
  });

  it('passes a non-boolean-looking value through untouched on a boolean input', () => {
    const { env } = buildHubEnv(
      {
        env: [
          {
            key: 'MODE',
            input: { type: 'boolean', trueValue: '1', falseValue: '0' },
          },
        ],
      },
      { MODE: 'auto' }
    );
    assert.deepEqual(env, [{ key: 'MODE', value: 'auto' }]);
  });

  it('OMITS an optional key that has no default and no override', () => {
    // '' would shadow the image's own fallback: os.environ.get('X', 'fallback')
    // returns '' when X is set to ''.
    const { env } = buildHubEnv(
      {
        env: [
          { key: 'OPTIONAL_NO_DEFAULT', input: {} },
          { key: 'HAS_DEFAULT', input: { default: 'keep' } },
        ],
      },
      {}
    );
    assert.deepEqual(env, [{ key: 'HAS_DEFAULT', value: 'keep' }]);
  });

  it('appends caller keys absent from the schema, verbatim', () => {
    const { env } = buildHubEnv(
      { env: [{ key: 'KNOWN', input: { default: 'a' } }] },
      { KNOWN: 'override', EXTRA: 'passthrough' }
    );
    assert.deepEqual(env, [
      { key: 'KNOWN', value: 'override' },
      { key: 'EXTRA', value: 'passthrough' },
    ]);
  });

  it('handles a config with no env schema at all', () => {
    assert.deepEqual(buildHubEnv({}, {}), { env: [], missingRequired: [] });
    assert.deepEqual(buildHubEnv({}, { ONLY: 'caller' }), {
      env: [{ key: 'ONLY', value: 'caller' }],
      missingRequired: [],
    });
  });
});

describe('minCudaVersion', () => {
  it('returns the lowest version, comparing numerically not lexically', () => {
    // '12.10' > '12.9' numerically but sorts lower as a string.
    assert.equal(minCudaVersion(['12.10', '12.9']), '12.9');
    assert.equal(minCudaVersion(['12.8', '12.4', '13.0']), '12.4');
    assert.equal(minCudaVersion(['12.4']), '12.4');
  });

  it('treats a missing segment as 0', () => {
    assert.equal(minCudaVersion(['12', '12.1']), '12');
  });

  it('returns null for an absent or empty list', () => {
    assert.equal(minCudaVersion(undefined), null);
    assert.equal(minCudaVersion([]), null);
  });
});
