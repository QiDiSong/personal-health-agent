import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';

const { default: worker } = await import('../worker/index.js');
const html = await (await worker.fetch(new Request('https://journal.test/'), {})).text();
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

async function app() {
  const elements = new Map(), listeners = new Map(), calls = [];
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, { elements: { kind: {} } });
    return elements.get(selector);
  };
  const state = { today: '2026-11-09', entries: [
    { id: 'w', day: '2026-11-09', kind: 'workout', source: 'manual', label: '羽毛球', minutes: 90 },
    { id: 'apple:activity:2026-11-09', day: '2026-11-09', kind: 'activity', source: 'device', label: 'Apple 健康活动', steps: 1234, apple_exercise_minutes: 25, active_energy_kcal: 300 },
  ], plan: [], goal: null, latestWeight: null };
  const context = vm.createContext({
    TextDecoder,TextEncoder,
    document: { querySelector: element, addEventListener: (name, fn) => listeners.set(name, fn), querySelectorAll: () => [] },
    fetch: async (url, options) => {
      const payload = JSON.parse(options.body); calls.push({ url, payload });
      return { ok: true, json: async () => payload.name === 'read_health' ? state : { devices: [] } };
    },
  });
  vm.runInContext(script, context);
  await vm.runInContext('refresh()', context);
  return { context, element, calls };
}

test('native activity is readable but its ring minutes never inflate workout totals', async () => {
  const a = await app();
  vm.runInContext("view='today';render()", a.context);
  assert.match(a.element('#metrics').innerHTML, /90 min/);
  assert.doesNotMatch(a.element('#metrics').innerHTML, /115 min/);
  assert.match(a.element('#content').innerHTML, /1234/);
  assert.match(a.element('#content').innerHTML, /Apple 锻炼时间/);
  assert.doesNotMatch(a.element('#content').innerHTML, /data-edit="apple:activity/);
});

test('connection panel explains one-tap 30-day catchup and lists devices without creating one', async () => {
  const a = await app();
  await vm.runInContext("view='connect';render();loadPhoneDevices()", a.context);
  assert.match(a.element('#content').innerHTML, /30 天/);
  assert.match(a.element('#content').innerHTML, /phone-sync\/help/);
  assert.match(a.element('#content').innerHTML, /phone-sync\/config/);
  assert.ok(a.calls.some(c => c.payload.name === 'phone_sync_list'));
  assert.ok(a.calls.every(c => c.url === '/api'));
  assert.doesNotMatch(html, /OAI-Sites-Authorization|PHONE_SYNC_GATEWAY_TOKEN/);
});

test('phone help is readable without credentials and explains training restriction', async () => {
  const response = await worker.fetch(new Request('https://journal.test/phone-sync/help'), {});
  assert.equal(response.status, 200);
  const guide = await response.text();
  assert.match(guide, /30/);
  assert.match(guide, /体能训练/);
  assert.match(guide, /首次|一次/);
});

test('config endpoint rejects unsigned and cross-origin browsers before creating keys', async () => {
  for (const headers of [{}, { 'oai-authenticated-user-id': 'owner', origin: 'https://other.test' }]) {
    const response = await worker.fetch(new Request('https://journal.test/phone-sync/config', { method: 'POST', headers, body: '{}' }), {});
    assert.ok([401, 403].includes(response.status));
  }
});
