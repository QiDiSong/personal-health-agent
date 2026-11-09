import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { downloadPhoneConfig, handlePhoneSync, phoneSyncAction } from '../worker/native-sync.js';

const origin = 'https://journal.test';
const gateway = 'synthetic-private-gateway';
const owner = 'synthetic-owner';
const day = '2026-11-08';
const snapshot = '2026-11-09T01:00:00Z';
const payload = (extra = {}) => ({ version: 1, collected_at: snapshot, activities: [{ date: day, steps: 1234 }], ...extra });

async function memoryDB(t) {
  const sqlite = new DatabaseSync(':memory:');
  for (const file of ['0000_health.sql', '0001_native_phone_sync.sql']) sqlite.exec(await readFile(new URL('../drizzle/' + file, import.meta.url), 'utf8'));
  t.after(() => sqlite.close());
  const DB = {
    prepare(sql) {
      const make = (values = []) => ({
        bind: (...args) => make(args),
        run: async () => {
          const statement = sqlite.prepare(sql);
          if (statement.columns().length) return { success: true, results: statement.all(...values), meta: { changes: Number(sqlite.prepare('SELECT changes() AS n').get().n) } };
          const r = statement.run(...values);
          return { success: true, results: [], meta: { changes: Number(r.changes) } };
        },
        first: async () => sqlite.prepare(sql).get(...values) ?? null,
        all: async () => ({ results: sqlite.prepare(sql).all(...values) }),
      });
      return make();
    },
    beforeBatch: null,
    async batch(statements) {
      assert.ok(statements.length <= 75, 'bounded D1 batch');
      if (this.beforeBatch) { const fn = this.beforeBatch; this.beforeBatch = null; await fn(); }
      sqlite.exec('BEGIN');
      try { const results = []; for (const stmt of statements) results.push(await stmt.run()); sqlite.exec('COMMIT'); return results; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
  return {
    DB, sqlite, env: { DB, PHONE_SYNC_GATEWAY_TOKEN: gateway },
    entries: (who = owner) => sqlite.prepare('SELECT data FROM entries WHERE owner=? ORDER BY id').all(who).map(r => JSON.parse(r.data)),
    seed(who, row) { sqlite.prepare('INSERT INTO entries VALUES(?,?,?,?,?)').run(who, row.id, row.day, row.kind, JSON.stringify(row)); },
  };
}

function configRequest(options = {}) {
  return new Request(origin + '/phone-sync/config', { method: 'POST', headers: { 'content-type': 'application/json', origin, ...options.headers }, body: JSON.stringify({ name: 'Synthetic iPhone', ...options.body }) });
}
async function device(storage, who = owner) {
  const response = await downloadPhoneConfig(configRequest(), storage.env, who);
  assert.equal(response.status, 200);
  const config = await response.json();
  return { response, config, key: config.headers.Authorization.replace(/^Bearer /, '') };
}
function upload(key, body = payload(), options = {}) {
  // Sites consumes OAI-Sites-Authorization upstream. The Worker sees only the
  // narrow device bearer and must continue to work without the gateway header.
  return new Request(origin + '/api/phone-sync' + (options.query ?? ''), { method: options.method ?? 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key, ...options.headers }, body: options.raw ?? JSON.stringify(body), ...(options.stream ? { duplex: 'half' } : {}) });
}
async function sync(storage, key, body = payload(), options = {}) {
  const response = await handlePhoneSync(upload(key, body, options), storage.env);
  return { response, body: await response.json() };
}
const list = (storage, who = owner) => phoneSyncAction(storage.DB, who, 'phone_sync_list', {});

test('private download creates a usable owner-bound device key and stores only its hash', async t => {
  const storage = await memoryDB(t);
  const { config, key, response } = await device(storage);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-disposition'), /attachment;.*health-phone-sync\.json/);
  assert.equal(config.url, origin + '/api/phone-sync');
  assert.equal(config.headers['OAI-Sites-Authorization'], 'Bearer ' + gateway);
  assert.equal(config.headers['Content-Type'], 'application/json');
  assert.equal(Buffer.from(key, 'base64url').length, 32);
  assert.equal(config.body_template.version, 1);
  const row = storage.sqlite.prepare('SELECT * FROM phone_sync_devices').get();
  const expectedHash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key))).toString('hex');
  assert.equal(row.token_hash, expectedHash);
  assert.ok(!JSON.stringify(row).includes(key));
  const result = await sync(storage, key);
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.body, { ok: true, count: 1, latestDataDay: day, collectedAt: '2026-11-09T01:00:00.000Z' });
  assert.equal(storage.entries()[0].steps, 1234);
  const status = await list(storage);
  assert.equal(status.devices.length, 1);
  assert.equal(status.devices[0].lastCount, 1);
  assert.equal(status.devices[0].lastCollectedAt, '2026-11-09T01:00:00.000Z');
  assert.equal(status.devices[0].latestDataDay, day);
  assert.match(status.devices[0].lastReceivedAt, /^\d{4}-/);
  for (const secret of [key, expectedHash, gateway]) assert.ok(!JSON.stringify(status).includes(secret));
});

test('device limit is atomic, owner scoped, and a revoked slot can be reused', async t => {
  const storage = await memoryDB(t);
  const responses = await Promise.all(Array.from({ length: 8 }, () => downloadPhoneConfig(configRequest(), storage.env, owner)));
  assert.equal(responses.filter(r => r.status === 200).length, 5);
  assert.equal((await list(storage)).devices.length, 5);
  const id = (await list(storage)).devices[0].id;
  assert.deepEqual(await phoneSyncAction(storage.DB, 'other-owner', 'phone_sync_revoke', { id }), { revoked: false });
  assert.deepEqual(await phoneSyncAction(storage.DB, owner, 'phone_sync_revoke', { id }), { revoked: true });
  assert.equal((await downloadPhoneConfig(configRequest(), storage.env, owner)).status, 200);
  assert.equal((await downloadPhoneConfig(configRequest(), storage.env, 'other-owner')).status, 200);
});

test('download requires authenticated same-origin data and configured gateway without creating credentials on failure', async t => {
  const storage = await memoryDB(t);
  const cases = [
    [configRequest(), storage.env, null, 401],
    [configRequest({ headers: { origin: 'https://evil.test', 'sec-fetch-site': 'same-origin' } }), storage.env, owner, 403],
    [new Request(origin + '/phone-sync/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }), storage.env, owner, 403],
    [configRequest({ headers: { 'content-type': 'text/plain' } }), storage.env, owner, 415],
    [configRequest(), { DB: storage.DB }, owner, 503],
  ];
  for (const [req, env, who, status] of cases) {
    const response = await downloadPhoneConfig(req, env, who);
    assert.equal(response.status, status);
    assert.ok(!(await response.text()).includes(gateway));
  }
  assert.equal((await list(storage)).devices.length, 0);
  const noOrigin = new Request(origin + '/phone-sync/config', { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: '{}' });
  assert.equal((await downloadPhoneConfig(noOrigin, storage.env, owner)).status, 200);
  const form = new Request(origin + '/phone-sync/config', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin }, body: 'name=%E6%88%91%E7%9A%84+iPhone' });
  assert.equal((await downloadPhoneConfig(form, storage.env, owner)).status, 200);
  assert.ok((await list(storage)).devices.some(d => d.name === '我的 iPhone'));
});

test('unknown or revoked bearer is generic, ignores claimed owner, and cannot touch any owner data', async t => {
  const storage = await memoryDB(t);
  const a = await device(storage), b = await device(storage, 'other-owner');
  assert.equal((await sync(storage, b.key)).response.status, 200);
  assert.equal(storage.entries().length, 0);
  assert.equal(storage.entries('other-owner').length, 1);
  const id = (await list(storage)).devices[0].id;
  await phoneSyncAction(storage.DB, owner, 'phone_sync_revoke', { id });
  const invalid = await sync(storage, 'secret-malformed-key');
  const revoked = await sync(storage, a.key);
  assert.equal(invalid.response.status, 401);
  assert.equal(revoked.response.status, 401);
  assert.deepEqual(invalid.body, revoked.body);
  assert.ok(!JSON.stringify(invalid.body).includes('secret-malformed-key'));
  const forgedOwner = await sync(storage, b.key, payload(), { headers: { 'oai-authenticated-user-id': owner } });
  assert.equal(forgedOwner.response.status, 200);
  assert.equal(storage.entries().length, 0);
});

test('repeated uploads are idempotent, newer partial quantities preserve known fields, and old snapshots cannot replace status', async t => {
  const storage = await memoryDB(t), { key } = await device(storage);
  await sync(storage, key, payload({ activities: [{ date: day, steps: 1234, active_energy_kcal: 100 }] }));
  await sync(storage, key, payload({ collected_at: '2026-11-09T02:00:00Z', activities: [{ date: day, apple_exercise_minutes: 15 }] }));
  await sync(storage, key, payload({ collected_at: '2026-11-09T02:00:00Z', activities: [{ date: day, apple_exercise_minutes: 15 }] }));
  const stale = await sync(storage, key, payload({ collected_at: '2026-11-09T01:30:00Z', activities: [{ date: day, steps: 9 }] }));
  assert.equal(stale.body.count, 0);
  assert.equal(stale.body.latestDataDay, null);
  assert.equal(storage.entries().length, 1);
  assert.equal(storage.entries()[0].steps, 1234);
  assert.equal(storage.entries()[0].active_energy_kcal, 100);
  assert.equal(storage.entries()[0].apple_exercise_minutes, 15);
  assert.equal(storage.entries()[0].collectedAt, '2026-11-09T02:00:00.000Z');
  assert.equal((await list(storage)).devices[0].lastCollectedAt, '2026-11-09T02:00:00.000Z');
  await sync(storage, key, payload({ collected_at: '2026-11-09T03:00:00Z', activities: [] }));
  const empty = (await list(storage)).devices[0];
  assert.equal(empty.lastCount, 0);
  assert.equal(empty.latestDataDay, null);
  assert.equal(storage.entries()[0].steps, 1234);
});

test('stable sleep rows reconcile existing device XML rows while manual and other-owner rows survive', async t => {
  const storage = await memoryDB(t), { key } = await device(storage);
  storage.seed(owner, { id: 'apple:sleep:' + day, day, kind: 'sleep', label: 'Apple 健康睡眠', source: 'device', minutes: 60 });
  storage.seed(owner, { id: 'apple:activity:' + day, day, kind: 'activity', label: 'manual synthetic', source: 'manual', steps: 55 });
  storage.seed('other-owner', { id: 'apple:sleep:' + day, day, kind: 'sleep', label: 'other synthetic', source: 'device', minutes: 22 });
  const result = await sync(storage, key, payload({ range_start: day, sleep_samples: [{ start: '2026-11-07T23:00:00+08:00', end: '2026-11-08T07:00:00+08:00', state: 'Asleep' }] }));
  assert.equal(result.response.status, 200);
  assert.equal(result.body.count, 1);
  assert.equal((await list(storage)).devices[0].lastCount, 1);
  assert.equal(storage.entries().find(r => r.kind === 'sleep').minutes, 480);
  assert.equal(storage.entries().find(r => r.kind === 'activity').steps, 55);
  assert.equal(storage.entries('other-owner')[0].minutes, 22);
});

test('manual conflicts report no written measurements in the response and newest device status', async t => {
  const storage = await memoryDB(t), { key } = await device(storage);
  storage.seed(owner, { id: 'apple:activity:' + day, day, kind: 'activity', label: 'manual synthetic', source: 'manual', steps: 55 });
  const result = await sync(storage, key);
  assert.equal(result.response.status, 200);
  assert.equal(result.body.count, 0);
  assert.equal(result.body.latestDataDay, null);
  const status = (await list(storage)).devices[0];
  assert.equal(status.lastCount, 0);
  assert.equal(status.latestDataDay, null);
  assert.equal(status.lastCollectedAt, '2026-11-09T01:00:00.000Z');
  assert.equal(storage.entries()[0].steps, 55);
});

test('partial native sleep cannot reduce an existing complete XML sleep row', async t => {
  const storage = await memoryDB(t), { key } = await device(storage);
  storage.seed(owner, { id: 'apple:sleep:' + day, day, kind: 'sleep', label: 'Apple 健康睡眠', source: 'device', minutes: 480, bed: '23:00', wake: '07:00' });
  const result = await sync(storage, key, payload({ activities: [], range_start: day, sleep_samples: [{ start: '2026-11-08T06:00:00+08:00', end: '2026-11-08T07:00:00+08:00', state: 'Asleep' }] }));
  assert.equal(result.response.status, 200);
  assert.equal(result.body.count, 0);
  assert.equal(result.body.latestDataDay, null);
  assert.equal(storage.entries()[0].minutes, 480);
  assert.equal(storage.entries()[0].bed, '23:00');
  assert.equal((await list(storage)).devices[0].lastCount, 0);
});

test('native sleep only replaces an existing native snapshot with equal or greater duration and a non-stale collection', async t => {
  const storage = await memoryDB(t), { key } = await device(storage);
  storage.seed(owner, { id: 'apple:sleep:' + day, day, kind: 'sleep', label: 'Apple 健康睡眠', source: 'device', minutes: 480, bed: '23:00', wake: '07:00', collectedAt: '2026-11-09T01:00:00.000Z' });
  const sleep = (collected_at, start, end) => payload({ collected_at, activities: [], range_start: day, sleep_samples: [{ start, end, state: 'Asleep' }] });
  const partial = await sync(storage, key, sleep('2026-11-09T02:00:00Z', '2026-11-08T06:00:00+08:00', '2026-11-08T07:00:00+08:00'));
  assert.equal(partial.body.count, 0);
  assert.equal(storage.entries()[0].minutes, 480);
  assert.equal(storage.entries()[0].collectedAt, '2026-11-09T01:00:00.000Z');
  const greater = await sync(storage, key, sleep('2026-11-09T03:00:00Z', '2026-11-07T22:00:00+08:00', '2026-11-08T07:00:00+08:00'));
  assert.equal(greater.body.count, 1);
  assert.equal(storage.entries()[0].minutes, 540);
  assert.equal(storage.entries()[0].bed, '22:00');
  const equal = await sync(storage, key, sleep('2026-11-09T04:00:00Z', '2026-11-07T21:30:00+08:00', '2026-11-08T06:30:00+08:00'));
  assert.equal(equal.body.count, 1);
  assert.equal(storage.entries()[0].minutes, 540);
  assert.equal(storage.entries()[0].bed, '21:30');
  assert.equal(storage.entries()[0].wake, '06:30');
  const stale = await sync(storage, key, sleep('2026-11-09T02:30:00Z', '2026-11-07T21:00:00+08:00', '2026-11-08T07:00:00+08:00'));
  assert.equal(stale.body.count, 0);
  assert.equal(storage.entries()[0].minutes, 540);
  assert.equal(storage.entries()[0].collectedAt, '2026-11-09T04:00:00.000Z');
});

test('latest measurement day comes from written rows when a later manual, stale, or shorter sleep row is rejected', async t => {
  for (const rejection of ['manual', 'stale', 'sleep']) {
    await t.test(rejection, async t => {
      const storage = await memoryDB(t), { key } = await device(storage);
      const previousDay = '2026-11-07';
      let body;
      if (rejection === 'sleep') {
        storage.seed(owner, { id: 'apple:sleep:' + day, day, kind: 'sleep', label: 'Apple 健康睡眠', source: 'device', minutes: 480, bed: '23:00', wake: '07:00' });
        body = payload({ activities: [{ date: previousDay, steps: 200 }], range_start: day, sleep_samples: [{ start: '2026-11-08T06:00:00+08:00', end: '2026-11-08T07:00:00+08:00', state: 'Asleep' }] });
      } else {
        storage.seed(owner, { id: 'apple:activity:' + day, day, kind: 'activity', label: 'Synthetic activity', source: rejection === 'manual' ? 'manual' : 'device', steps: 500, ...(rejection === 'stale' ? { collectedAt: '2026-11-09T02:00:00.000Z' } : {}) });
        body = payload({ activities: [{ date: day, steps: 100 }, { date: previousDay, steps: 200 }] });
      }
      const result = await sync(storage, key, body);
      assert.equal(result.response.status, 200);
      assert.equal(result.body.count, 1);
      assert.equal(result.body.latestDataDay, previousDay);
      const status = (await list(storage)).devices[0];
      assert.equal(status.lastCount, 1);
      assert.equal(status.latestDataDay, previousDay);
      assert.equal(storage.entries().find(r => r.day === previousDay).steps, 200);
    });
  }
});

test('invalid payload, wrong content type, query credential, and actual or declared oversized body cause no writes', async t => {
  const storage = await memoryDB(t), { key } = await device(storage);
  const cases = [
    [payload({ activities: [{ date: day, steps: 1 }, { date: '2026-11-07', steps: 'bad-secret-value' }] }), {}, 400],
    [payload(), { raw: '{"secret":"bad-body"' }, 400],
    [payload(), { headers: { 'content-type': 'text/plain' } }, 415],
    [payload(), { query: '?token=' + key }, 400],
    [payload(), { headers: { 'content-length': String(2 * 1024 * 1024 + 1) } }, 413],
    [payload(), { raw: '{"padding":"' + 'x'.repeat(2 * 1024 * 1024) + '"}' }, 413],
    [payload({ sleep_samples: Array.from({ length: 12001 }, () => ({ start: '2026-11-07T23:00:00+08:00', end: '2026-11-08T07:00:00+08:00', state: 'Asleep' })) }), {}, 400],
  ];
  for (const [body, options, status] of cases) {
    const result = await sync(storage, key, body, options);
    assert.equal(result.response.status, status);
    for (const secret of [key, 'bad-secret-value', 'bad-body']) assert.ok(!JSON.stringify(result.body).includes(secret));
    assert.equal(storage.entries().length, 0);
  }
  const dev = (await list(storage)).devices[0];
  assert.equal(dev.lastReceivedAt, null);
});

test('streamed bytes enforce the limit despite a small declared length and reject malformed UTF-8', async t => {
  const storage = await memoryDB(t), { key } = await device(storage);
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(1024 * 1024));
      controller.enqueue(new Uint8Array(1024 * 1024));
      controller.enqueue(new Uint8Array(1));
      controller.close();
    },
  });
  const oversized = await sync(storage, key, payload(), { raw: stream, stream: true, headers: { 'content-length': '1' } });
  assert.equal(oversized.response.status, 413);
  const invalid = await sync(storage, key, payload(), { raw: new Uint8Array([0xc3, 0x28]) });
  assert.equal(invalid.response.status, 400);
  assert.equal(storage.entries().length, 0);
  assert.equal((await list(storage)).devices[0].lastReceivedAt, null);
});

test('revocation racing after token lookup blocks every row and status write', async t => {
  const storage = await memoryDB(t), { key } = await device(storage);
  const id = (await list(storage)).devices[0].id;
  storage.DB.beforeBatch = () => phoneSyncAction(storage.DB, owner, 'phone_sync_revoke', { id });
  const result = await sync(storage, key);
  assert.equal(result.response.status, 401);
  assert.equal(storage.entries().length, 0);
  assert.equal((await list(storage)).devices[0].lastReceivedAt, null);
});

test('SQL failures roll back the complete batch including device receipt', async t => {
  const storage = await memoryDB(t), { key } = await device(storage);
  storage.sqlite.exec("CREATE TRIGGER reject_synthetic BEFORE INSERT ON entries WHEN NEW.day='2026-11-07' BEGIN SELECT RAISE(ABORT,'synthetic-db-failure'); END");
  const result = await sync(storage, key, payload({ activities: [{ date: day, steps: 1 }, { date: '2026-11-07', steps: 2 }] }));
  assert.equal(result.response.status, 503);
  assert.equal(storage.entries().length, 0);
  assert.equal((await list(storage)).devices[0].lastReceivedAt, null);
  assert.ok(!JSON.stringify(result.body).includes('synthetic-db-failure'));
});
