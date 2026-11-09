import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../worker/index.js', import.meta.url), 'utf8');
const { default: worker } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));

const emptyDatabase = {
  prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }), first: async () => null }) }),
};

async function profile(env = {}) {
  const response = await worker.fetch(new Request('https://journal.test/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'oai-authenticated-user-id': 'test-owner' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_health', arguments: {} } }),
  }), { DB: emptyDatabase, ...env });
  const body = await response.json();
  assert.notEqual(body.result.isError, true);
  return JSON.parse(body.result.content[0].text);
}

test('unconfigured personal profile stays unknown instead of exposing embedded values', async () => {
  const result = await profile();
  assert.equal(result.baselineKg, null);
  assert.equal(result.heightCm, null);
  assert.equal(result.baselineSource, null);
});

test('private runtime profile is retained without storing measurements in public source', async () => {
  const result = await profile({ PROFILE_BASELINE_KG: '98.5', PROFILE_HEIGHT_CM: '181' });
  assert.equal(result.baselineKg, 98.5);
  assert.equal(result.heightCm, 181);
  assert.equal(result.baselineSource, '自述约值');
});

test('invalid private runtime values stay unknown', async () => {
  const result = await profile({ PROFILE_BASELINE_KG: 'NaN', PROFILE_HEIGHT_CM: '999' });
  assert.equal(result.baselineKg, null);
  assert.equal(result.heightCm, null);
});
