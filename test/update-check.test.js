import assert from 'node:assert/strict';
import test from 'node:test';
import { compareSemver, findAvailableUpdate } from '../src/update-check.js';

test('semantic version comparison follows release precedence', () => {
  assert.equal(compareSemver('0.2.4', '0.2.3'), 1);
  assert.equal(compareSemver('1.0.0', '1.0.0'), 0);
  assert.equal(compareSemver('1.0.0-beta.2', '1.0.0-beta.11'), -1);
  assert.equal(compareSemver('1.0.0-rc.1', '1.0.0-beta.9'), 1);
  assert.equal(compareSemver('1.0.0', '1.0.0-rc.1'), 1);
  assert.equal(compareSemver('1.0.0+build.2', '1.0.0+build.1'), 0);
  assert.equal(compareSemver('1.0', '1.0.0'), null);
  assert.equal(compareSemver('1.0.0-01', '1.0.0'), null);
});

test('update checks query npm latest on every call', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      json: async () => ({
        name: '@galaxy-yearn/codex-deepseek-gateway',
        version: ' 0.3.0 ',
      }),
    };
  };
  const input = {
    packageName: '@galaxy-yearn/codex-deepseek-gateway',
    currentVersion: '0.2.3',
    fetchImpl,
  };

  assert.equal(await findAvailableUpdate(input), '0.3.0');
  assert.equal(await findAvailableUpdate(input), '0.3.0');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://registry.npmjs.org/%40galaxy-yearn%2Fcodex-deepseek-gateway/latest');
  assert.deepEqual(calls[0].options.headers, { accept: 'application/json' });
  assert.equal(calls[0].options.signal instanceof AbortSignal, true);
});

test('update checks ignore unavailable or untrusted registry results', async () => {
  const input = {
    packageName: '@galaxy-yearn/codex-deepseek-gateway',
    currentVersion: '0.2.3',
  };
  assert.equal(await findAvailableUpdate({
    ...input,
    fetchImpl: async () => ({ ok: false }),
  }), null);
  assert.equal(await findAvailableUpdate({
    ...input,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ name: 'another-package', version: '9.9.9' }),
    }),
  }), null);
  assert.equal(await findAvailableUpdate({
    ...input,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ name: input.packageName, version: '0.2.3' }),
    }),
  }), null);
  assert.equal(await findAvailableUpdate({
    ...input,
    fetchImpl: async () => {
      throw new Error('offline');
    },
  }), null);
});

test('update checks abort at the configured deadline', async () => {
  let aborted = false;
  const result = await findAvailableUpdate({
    packageName: '@galaxy-yearn/codex-deepseek-gateway',
    currentVersion: '0.2.3',
    timeoutMs: 10,
    fetchImpl: async (url, { signal }) => await new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {
        aborted = true;
        reject(signal.reason);
      }, { once: true });
    }),
  });
  assert.equal(result, null);
  assert.equal(aborted, true);
});
