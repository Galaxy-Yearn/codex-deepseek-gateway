import assert from 'node:assert/strict';
import test from 'node:test';
import { compareSemver, findAvailableUpdate } from '../src/update-check.js';

test('update discovery follows npm release precedence and never blocks CLI work', async () => {
  assert.equal(compareSemver('1.1.0', '1.0.0'), 1);
  assert.equal(compareSemver('1.0.0-beta.2', '1.0.0-beta.11'), -1);
  assert.equal(compareSemver('1.0.0', '1.0.0-rc.1'), 1);
  assert.equal(compareSemver('1.0', '1.0.0'), null);

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
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://registry.npmjs.org/%40galaxy-yearn%2Fcodex-deepseek-gateway/latest');
  assert.deepEqual(calls[0].options.headers, { accept: 'application/json' });
  assert.equal(calls[0].options.signal instanceof AbortSignal, true);

  const base = {
    packageName: '@galaxy-yearn/codex-deepseek-gateway',
    currentVersion: '0.2.3',
  };
  const unavailable = [
    async () => ({ ok: false }),
    async () => ({ ok: true, json: async () => ({ name: 'another-package', version: '9.9.9' }) }),
    async () => ({ ok: true, json: async () => ({ name: base.packageName, version: base.currentVersion }) }),
    async () => { throw new Error('offline'); },
  ];
  for (const unavailableFetch of unavailable) {
    assert.equal(await findAvailableUpdate({ ...base, fetchImpl: unavailableFetch }), null);
  }

  let aborted = false;
  const result = await findAvailableUpdate({
    ...base,
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
