import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import vm from 'node:vm';
import { zipSync, strToU8 } from 'fflate';

const { default: worker } = await import('../worker/index.js');
const page = await (await worker.fetch(new Request('https://journal.test/'), {})).text();
const script = page.match(/<script>([\s\S]*?)<\/script>/)[1];

// Node has no DOMParser. This narrow fixture adapter supplies DOM nodes from
// our synthetic XML; the page's real import handler and mapping run unchanged.
class FixtureDOMParser {
  parseFromString(text) {
    const nodes = [...text.matchAll(/<(Record|Workout)\b([^>]*)\/>/g)].map(([, nodeName, attributes]) => {
      const attrs = Object.fromEntries([...attributes.matchAll(/(\w+)="([^"]*)"/g)].map(([, key, value]) => [key, value.replace(/&(amp|lt|gt|quot|apos);/g, (_, entity) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[entity])]));
      return { nodeName, getAttribute: key => attrs[key] ?? null };
    });
    return {
      documentElement: { nodeName: 'HealthData' },
      querySelector: () => null,
      querySelectorAll: () => nodes,
    };
  }
}

function record(value, start, end, extra = {}) {
  return { type: 'HKCategoryTypeIdentifierSleepAnalysis', value: 'HKCategoryValueSleepAnalysis' + value, startDate: start, endDate: end, sourceName: 'Watch', ...extra };
}
const on = (day, time) => `${day} ${time}:00 +0800`;
const xml = records => '<HealthData>' + records.map(({ nodeName = 'Record', ...attrs }) => '<' + nodeName + ' ' + Object.entries(attrs).map(([key, value]) => `${key}="${String(value).replace(/[&<>"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character])}"`).join(' ') + '/>').join('') + '</HealthData>';

function memoryDB(seed = []) {
  const database = new DatabaseSync(':memory:');
  database.exec('CREATE TABLE entries(owner TEXT NOT NULL,id TEXT NOT NULL,day TEXT NOT NULL,kind TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(owner,id))');
  for (const { owner = 'test-owner', ...entry } of seed) database.prepare('INSERT INTO entries VALUES(?,?,?,?,?)').run(owner, entry.id, entry.day, entry.kind, JSON.stringify(entry));
  return {
    DB: {
      prepare: sql => ({ bind: (...values) => ({ run: () => database.prepare(sql).run(...values) }) }),
      batch: async statements => statements.map(statement => statement.run()),
    },
    rows: (owner = 'test-owner') => database.prepare('SELECT data FROM entries WHERE owner=? ORDER BY id').all(owner).map(row => JSON.parse(row.data)),
    close: () => database.close(),
  };
}

async function importer({ storage, failImportBatch } = {}) {
  const elements = new Map(), listeners = new Map(), imported = [];
  let importBatches = 0;
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, { elements: { kind: {} } });
    return elements.get(selector);
  };
  const state = { today: '2026-11-09', entries: [], plan: [], goal: null, latestWeight: null };
  const context = vm.createContext({
    DOMParser: FixtureDOMParser,TextDecoder,TextEncoder,
    document: { querySelector: element, addEventListener: (name, handler) => listeners.set(name, handler) },
    fetch: async (_url, options) => {
      const request = JSON.parse(options.body);
      if (request.name === 'import_health') imported.push(...request.args.entries);
      else assert.ok(['read_health', 'reconcile_apple_sleep'].includes(request.name));
      if (request.name === 'import_health' && ++importBatches === failImportBatch) return Response.json({ error: 'synthetic import batch failure' }, { status: 400 });
      if (storage && request.name !== 'read_health') return worker.fetch(new Request('https://journal.test/api', { ...options, headers: { ...options.headers, origin: 'https://journal.test', 'oai-authenticated-user-id': 'test-owner' } }), { DB: storage.DB });
      return { ok: true, json: async () => request.name === 'read_health' ? state : { count: request.args.entries.length } };
    },
  });
  vm.runInContext(script, context);
  await vm.runInContext('refresh()', context);
  return {
    async run(records, suppliedFile) {
      imported.length = 0;
      const file=suppliedFile??new File([xml(records)],'export.xml',{type:'application/xml'});
      const target = { id: 'xml', disabled: false, files: [file] };
      await listeners.get('change')({ target });
      assert.equal(target.disabled, false);
      return { entries: structuredClone(imported), status: element('#status').textContent };
    },
    context,
  };
}

test('connected core/deep/REM stages stay on the final waking date across midnight', async () => {
  const app = await importer();
  const result = await app.run([
    record('AsleepCore', on('2026-11-07', '23:00'), on('2026-11-07', '23:30')),
    record('AsleepDeep', on('2026-11-07', '23:30'), on('2026-11-08', '02:00')),
    record('AsleepREM', on('2026-11-08', '02:00'), on('2026-11-08', '07:00')),
  ]);
  assert.deepEqual(result.entries, [{ id: 'apple:sleep:2026-11-08', day: '2026-11-08', kind: 'sleep', label: 'Apple 健康睡眠', minutes: 480, bed: '23:00', wake: '07:00' }]);
});

test('a single legacy asleep record spanning midnight uses its waking date', async () => {
  const app = await importer();
  const { entries } = await app.run([record('Asleep', on('2026-11-07', '23:00'), on('2026-11-08', '07:00'))]);
  assert.deepEqual(entries, [{ id: 'apple:sleep:2026-11-08', day: '2026-11-08', kind: 'sleep', label: 'Apple 健康睡眠', minutes: 480, bed: '23:00', wake: '07:00' }]);
});

test('in-bed and awake intervals connect a session without adding asleep minutes', async () => {
  const app = await importer();
  const { entries } = await app.run([
    record('InBed', on('2026-11-07', '22:30'), on('2026-11-08', '07:30')),
    record('AsleepUnspecified', on('2026-11-07', '23:00'), on('2026-11-07', '23:30')),
    record('Awake', on('2026-11-07', '23:30'), on('2026-11-08', '00:15')),
    record('AsleepCore', on('2026-11-08', '00:15'), on('2026-11-08', '07:00')),
  ]);
  assert.deepEqual(entries, [{ id: 'apple:sleep:2026-11-08', day: '2026-11-08', kind: 'sleep', label: 'Apple 健康睡眠', minutes: 435, bed: '23:00', wake: '07:00' }]);
});

test('an awake interval alone can bridge stages across midnight', async () => {
  const app = await importer();
  const { entries } = await app.run([
    record('AsleepCore', on('2026-11-07', '23:00'), on('2026-11-07', '23:30')),
    record('Awake', on('2026-11-07', '23:30'), on('2026-11-08', '00:15')),
    record('AsleepREM', on('2026-11-08', '00:15'), on('2026-11-08', '01:00')),
  ]);
  assert.deepEqual(entries.map(({ day, minutes }) => ({ day, minutes })), [{ day: '2026-11-08', minutes: 75 }]);
});

test('overlapping asleep records from multiple devices count once', async () => {
  const app = await importer();
  const { entries } = await app.run([
    record('Asleep', on('2026-11-07', '23:00'), on('2026-11-08', '07:00'), { sourceName: 'Phone' }),
    record('AsleepCore', on('2026-11-08', '00:00'), on('2026-11-08', '04:00')),
    record('AsleepDeep', on('2026-11-08', '03:00'), on('2026-11-08', '06:00')),
  ]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].minutes, 480);
});

test('disconnected naps and sessions keep their own dates and same-day totals', async () => {
  const app = await importer();
  const { entries } = await app.run([
    record('Asleep', on('2026-11-07', '13:00'), on('2026-11-07', '14:00')),
    record('AsleepCore', on('2026-11-07', '23:00'), on('2026-11-07', '23:30')),
    record('AsleepREM', on('2026-11-07', '23:45'), on('2026-11-08', '07:00')),
    record('Asleep', on('2026-11-08', '14:00'), on('2026-11-08', '14:30')),
  ]);
  assert.deepEqual(entries.map(({ day, minutes }) => ({ day, minutes })), [{ day: '2026-11-07', minutes: 90 }, { day: '2026-11-08', minutes: 465 }]);
});

test('invalid, backwards, zero-duration and unsupported sleep records add no time', async () => {
  const app = await importer();
  const { entries } = await app.run([
    record('AsleepCore', 'invalid', on('2026-11-08', '07:00')),
    record('AsleepCore', on('2026-11-08', '07:00'), on('2026-11-08', '06:00')),
    record('AsleepCore', on('2026-11-08', '07:00'), on('2026-11-08', '07:00')),
    record('InBed', on('2026-11-07', '22:00'), on('2026-11-08', '08:00')),
    record('Awake', on('2026-11-07', '22:00'), on('2026-11-08', '08:00')),
    record('Unknown', on('2026-11-07', '22:00'), on('2026-11-08', '08:00')),
    record('AsleepREM', on('2026-11-08', '06:00'), on('2026-11-08', '07:00')),
  ]);
  assert.deepEqual(entries.map(({ day, minutes }) => ({ day, minutes })), [{ day: '2026-11-08', minutes: 60 }]);
});

test('unrecognized Asleep-prefixed values are not interpreted as sleep', async () => {
  const app = await importer();
  const { entries } = await app.run([
    record('AsleepUnknown', on('2026-11-07', '22:00'), on('2026-11-08', '08:00')),
    record('AsleepREM', on('2026-11-08', '06:00'), on('2026-11-08', '07:00')),
  ]);
  assert.equal(entries[0].minutes, 60);
});

test('another source or device cannot bridge disconnected sessions', async () => {
  for (const extra of [{ sourceName: 'Other app' }, { device: 'Other Watch' }]) {
    const app = await importer();
    const { entries } = await app.run([
      record('InBed', on('2026-11-07', '22:00'), on('2026-11-08', '08:00'), extra),
      record('AsleepCore', on('2026-11-07', '23:00'), on('2026-11-07', '23:30')),
      record('AsleepREM', on('2026-11-08', '00:15'), on('2026-11-08', '07:00')),
    ]);
    assert.deepEqual(entries.map(({ day, minutes }) => ({ day, minutes })), [{ day: '2026-11-07', minutes: 30 }, { day: '2026-11-08', minutes: 405 }]);
  }
});

test('a source-version change does not split one connected session', async () => {
  const app = await importer();
  const { entries } = await app.run([
    record('AsleepCore', on('2026-11-07', '23:00'), on('2026-11-07', '23:30'), { sourceVersion: '1' }),
    record('AsleepREM', on('2026-11-07', '23:30'), on('2026-11-08', '07:00'), { sourceVersion: '2' }),
  ]);
  assert.deepEqual(entries.map(({ day, minutes }) => ({ day, minutes })), [{ day: '2026-11-08', minutes: 480 }]);
});

test('HKDevice process addresses and software/firmware changes do not split a connected session', async () => {
  const app = await importer();
  const { entries } = await app.run([
    record('AsleepCore', on('2026-11-07', '23:00'), on('2026-11-07', '23:30'), { device: '<<HKDevice: 0x111>, name:Apple Watch, manufacturer:Apple Inc., model:Watch, hardware:Watch6,4, software:10.0, firmware:1.0, localIdentifier:watch-one, >' }),
    record('AsleepREM', on('2026-11-07', '23:30'), on('2026-11-08', '07:00'), { device: '<<HKDevice: 0x222>, model:Watch, localIdentifier:watch-one, firmware:2.0, hardware:Watch6,4, name:Apple Watch, manufacturer:Apple Inc., software:11.0, >' }),
  ]);
  assert.deepEqual(entries.map(({ day, minutes }) => ({ day, minutes })), [{ day: '2026-11-08', minutes: 480 }]);
});

test('stable descriptive device fields work when unique identifiers are absent', async () => {
  const app = await importer();
  const { entries } = await app.run([
    record('AsleepCore', on('2026-11-07', '23:00'), on('2026-11-07', '23:30'), { device: '<<HKDevice: 0x111>, name:Apple Watch, model:Watch, hardware:Watch6,4, software:10.0, >' }),
    record('AsleepREM', on('2026-11-07', '23:30'), on('2026-11-08', '07:00'), { device: '<<HKDevice: 0x222>, hardware:Watch6,4, name:Apple Watch, software:11.0, model:Watch, >' }),
  ]);
  assert.deepEqual(entries.map(({ day, minutes }) => ({ day, minutes })), [{ day: '2026-11-08', minutes: 480 }]);
});

test('distinct stable physical device fields do not join touching phases', async () => {
  for (const [firstDevice, secondDevice] of [
    ['<<HKDevice: 0x111>, model:Watch, localIdentifier:watch-one, >', '<<HKDevice: 0x222>, model:Watch, localIdentifier:watch-two, >'],
    ['<<HKDevice: 0x111>, model:Watch, UDIDeviceIdentifier:udi-one, >', '<<HKDevice: 0x222>, model:Watch, UDIDeviceIdentifier:udi-two, >'],
    ['<<HKDevice: 0x111>, name:First Watch, model:Watch, >', '<<HKDevice: 0x222>, name:Second Watch, model:Watch, >'],
    ['<<HKDevice: 0x111>, name:Watch, model:First, >', '<<HKDevice: 0x222>, name:Watch, model:Second, >'],
    ['<<HKDevice: 0x111>, name:Watch, hardware:Watch6,4, >', '<<HKDevice: 0x222>, name:Watch, hardware:Watch6,5, >'],
  ]) {
    const app = await importer();
    const { entries } = await app.run([
      record('AsleepCore', on('2026-11-07', '23:00'), on('2026-11-07', '23:30'), { device: firstDevice }),
      record('AsleepREM', on('2026-11-07', '23:30'), on('2026-11-08', '07:00'), { device: secondDevice }),
    ]);
    assert.deepEqual(entries.map(({ day, minutes }) => ({ day, minutes })), [{ day: '2026-11-07', minutes: 30 }, { day: '2026-11-08', minutes: 450 }]);
  }
});

test('a connected session waking in the future is skipped as a whole', async () => {
  const app = await importer();
  const { entries } = await app.run([
    record('AsleepCore', on('2026-11-09', '23:00'), on('2026-11-09', '23:30')),
    record('AsleepREM', on('2026-11-09', '23:30'), on('2026-11-10', '07:00')),
  ]);
  assert.deepEqual(entries, []);
});

test('workout active duration, separate ring time and deterministic import IDs stay stable', async () => {
  const app = await importer();
  const fixture = [
    { nodeName: 'Workout', workoutActivityType: 'HKWorkoutActivityTypeBadminton', startDate: on('2026-11-08', '18:00'), endDate: on('2026-11-08', '19:30'), duration: '70', durationUnit: 'min' },
    { type: 'HKQuantityTypeIdentifierBodyMass', value: '200', unit: 'lb', startDate: on('2026-11-08', '08:00'), endDate: on('2026-11-08', '08:00') },
    record('Asleep', on('2026-11-07', '23:00'), on('2026-11-08', '07:00')),
    { type: 'HKQuantityTypeIdentifierAppleExerciseTime', value: '90', unit: 'min', startDate: on('2026-11-08', '18:00'), endDate: on('2026-11-08', '19:30') },
  ];
  const first = await app.run(fixture);
  assert.deepEqual(first.entries, [
    { id: 'apple:workout:1794132000000:1794137400000', kind: 'workout', day: '2026-11-08', minutes: 70, label: '羽毛球' },
    { id: 'apple:weight:1794096000000:1794096000000', kind: 'weight', day: '2026-11-08', kg: 90.7, label: 'Apple 健康体重' },
    { id: 'apple:activity:2026-11-08',day:'2026-11-08',kind:'activity',label:'Apple 健康活动',apple_exercise_minutes:90 },
    { id: 'apple:sleep:2026-11-08', day: '2026-11-08', kind: 'sleep', label: 'Apple 健康睡眠', minutes: 480, bed: '23:00', wake: '07:00' },
  ]);
  assert.deepEqual((await app.run(fixture)).entries, first.entries);
});

test('the import API stores parsed entries with device provenance', async () => {
  const app = await importer();
  const { entries } = await app.run([record('Asleep', on('2026-11-07', '23:00'), on('2026-11-08', '07:00'))]);
  const stored = [];
  const response = await worker.fetch(new Request('https://journal.test/api', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://journal.test', 'oai-authenticated-user-id': 'test-owner' },
    body: JSON.stringify({ name: 'import_health', args: { entries } }),
  }), { DB: {
    prepare: () => ({ bind: (_owner, _id, _day, _kind, data) => JSON.parse(data) }),
    batch: async statements => { stored.push(...statements); },
  } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { count: 1 });
  assert.equal(stored[0].source, 'device');
  assert.equal(stored[0].id, 'apple:sleep:2026-11-08');
  assert.equal(stored[0].minutes, 480);
});

const legacySleep = (day, minutes, bed, wake, extra = {}) => ({ id: 'apple:sleep:' + day, day, kind: 'sleep', label: 'Apple 健康睡眠', minutes, bed, wake, source: 'device', ...extra });
const overnightStages = [
  record('AsleepCore', on('2026-11-07', '23:00'), on('2026-11-07', '23:30')),
  record('AsleepREM', on('2026-11-07', '23:30'), on('2026-11-08', '07:00')),
];

test('reimport replaces the old split with 480 minutes and leaves another owner untouched', async t => {
  const storage = memoryDB([
    legacySleep('2026-11-07', 30, '23:00', '23:30'),
    legacySleep('2026-11-08', 450, '23:30', '07:00'),
    legacySleep('2026-11-07', 30, '23:00', '23:30', { owner: 'another-owner' }),
  ]);
  t.after(storage.close);
  const app = await importer({ storage });
  await app.run(overnightStages);
  assert.deepEqual(storage.rows(), [legacySleep('2026-11-08', 480, '23:00', '07:00')]);
  assert.deepEqual(storage.rows('another-owner'), [legacySleep('2026-11-07', 30, '23:00', '23:30')]);
});

test('cleanup preserves manual, unrelated, or changed prior-day records', async t => {
  for (const extra of [{ source: 'manual' }, { minutes: 31 }, { bed: '22:59' }, { wake: '23:31' }, { label: 'Updated sleep' }, { kind: 'workout' }]) {
    const prior = legacySleep('2026-11-07', 30, '23:00', '23:30', extra);
    const storage = memoryDB([prior]);
    t.after(storage.close);
    const app = await importer({ storage });
    await app.run(overnightStages);
    assert.deepEqual(storage.rows(), [prior, legacySleep('2026-11-08', 480, '23:00', '07:00')]);
  }
});

test('failed later import batch prevents obsolete-row cleanup', async t => {
  const oldRows = [legacySleep('2026-11-07', 30, '23:00', '23:30'), legacySleep('2026-11-08', 450, '23:30', '07:00')];
  const storage = memoryDB(oldRows);
  t.after(storage.close);
  const app = await importer({ storage, failImportBatch: 2 });
  const workouts = Array.from({ length: 500 }, (_, index) => ({ nodeName: 'Workout', workoutActivityType: 'HKWorkoutActivityTypeWalking', startDate: new Date(Date.UTC(2026, 10, 1, 0, index)).toISOString(), endDate: new Date(Date.UTC(2026, 10, 1, 0, index + 1)).toISOString() }));
  const result = await app.run([...workouts, ...overnightStages]);
  assert.match(result.status, /synthetic import batch failure/);
  assert.deepEqual(storage.rows().filter(row => row.kind === 'sleep'), oldRows);
  assert.equal(storage.rows().filter(row => row.kind === 'workout').length, 500);
});

test('cleanup validates all candidates before making any deletion', async t => {
  const prior = legacySleep('2026-11-07', 30, '23:00', '23:30');
  const storage = memoryDB([prior]);
  t.after(storage.close);
  const response = await worker.fetch(new Request('https://journal.test/api', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://journal.test', 'oai-authenticated-user-id': 'test-owner' },
    body: JSON.stringify({ name: 'reconcile_apple_sleep', args: { entries: [prior, { ...prior, id: 'manual-row' }] } }),
  }), { DB: storage.DB });
  assert.equal(response.status, 400);
  assert.deepEqual(storage.rows(), [prior]);
});


test('the actual page imports a monthly ZIP with nutrition, activity, vitals, sleep and workouts', async () => {
 const storage=memoryDB();try{
 const app=await importer({storage});
 const q=(type,value,unit,sourceName='Watch')=>({type:'HKQuantityTypeIdentifier'+type,value:String(value),unit,sourceName,startDate:on('2026-11-08','12:00'),endDate:on('2026-11-08','12:10')});
 const records=[q('StepCount',2000,'count'),q('StepCount',1500,'count','iPhone'),q('DietaryEnergyConsumed',1800,'kcal','Food'),q('DietaryProtein',100,'g','Food'),q('OxygenSaturation',0.98,'%'),record('Asleep',on('2026-11-07','23:00'),on('2026-11-08','07:00')),{nodeName:'Workout',workoutActivityType:'HKWorkoutActivityTypeWalking',startDate:on('2026-11-08','18:00'),endDate:on('2026-11-08','19:00'),duration:'50',durationUnit:'min'}];
 const file=new File([zipSync({'apple_health_export/export.xml':strToU8(xml(records))})],'export.zip');
 const result=await app.run([],file);assert.match(result.status,/已处理/);
 const rows=storage.rows();assert.equal(rows.find(r=>r.kind==='activity').steps,2000);assert.equal(rows.find(r=>r.kind==='nutrition').kcal,1800);assert.equal(rows.find(r=>r.kind==='nutrition').protein,100);assert.equal(rows.find(r=>r.kind==='vitals').spo2_percent,98);assert.equal(rows.find(r=>r.kind==='sleep').minutes,480);assert.equal(rows.find(r=>r.kind==='workout').minutes,50);
 await app.run([],file);assert.equal(storage.rows().length,5);
 }finally{storage.close();}
});
