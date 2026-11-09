import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { normalizePhonePayload as normalize } from '../worker/native-payload.js';
import * as sleepModule from '../worker/apple-sleep.js';

const now = new Date('2026-11-09T04:00:00Z');
const collected_at = '2026-11-09T12:00:00+08:00';
const base = extra => ({ version: 1, collected_at, ...extra });
const run = payload => normalize(payload, { now });
const sample = (state = 'Asleep', extra = {}) => ({ start: '2026-11-07T23:00:00+08:00', end: '2026-11-08T07:00:00+08:00', state, ...extra });

test('native quantities preserve measured zero, missing fields, units and stable activity IDs', () => {
  assert.deepEqual(run(base({ activities: [
    { date: '2026-11-08', steps: 0, apple_exercise_minutes: 25, owner: 'ignored', kind: 'workout' },
    { date: '2026-11-09', active_energy_kcal: 154.25 },
  ] })), {
    collectedAt: '2026-11-09T04:00:00.000Z',
    rows: [
      { id: 'apple:activity:2026-11-08', day: '2026-11-08', kind: 'activity', label: 'Apple 健康活动', source: 'device', steps: 0, apple_exercise_minutes: 25, collectedAt: '2026-11-09T04:00:00.000Z' },
      { id: 'apple:activity:2026-11-09', day: '2026-11-09', kind: 'activity', label: 'Apple 健康活动', source: 'device', active_energy_kcal: 154.25, collectedAt: '2026-11-09T04:00:00.000Z' },
    ],
    latestDataDay: '2026-11-09',
  });
});

test('activity values must be finite nonnegative numbers without string or null coercion', () => {
  for (const key of ['steps', 'active_energy_kcal', 'apple_exercise_minutes']) {
    for (const value of ['12', '', null, undefined, true, NaN, Infinity, -1]) {
      assert.throws(() => run(base({ activities: [{ date: '2026-11-08', [key]: value }] })), { name: 'Error' });
    }
  }
  assert.throws(() => run(base({ activities: [{ date: '2026-11-08' }] })), { name: 'Error' });
});

test('daily quantities reject impossible magnitudes while preserving finite fractional measurements', () => {
  for (const [key, limit] of [['steps', 1000000], ['active_energy_kcal', 100000], ['apple_exercise_minutes', 1440]]) {
    assert.equal(run(base({ activities: [{ date: '2026-11-08', [key]: limit }] })).rows[0][key], limit);
    assert.throws(() => run(base({ activities: [{ date: '2026-11-08', [key]: limit + 0.1 }] })), { name: 'Error' });
    assert.equal(run(base({ activities: [{ date: '2026-11-08', [key]: 0.5 }] })).rows[0][key], 0.5);
  }
});

test('activity snapshots reject duplicate days rather than overwrite quantities', () => {
  assert.throws(() => run(base({ activities: [
    { date: '2026-11-08', steps: 10 },
    { date: '2026-11-08', active_energy_kcal: 20 },
  ] })), { name: 'Error' });
});

test('native dates require real calendar dates and do not admit future activity days', () => {
  for (const date of ['2026-02-30', '2026-13-01', '2026-11-10', '11/08/2026', '2026-11-08T00:00:00Z']) {
    assert.throws(() => run(base({ activities: [{ date, steps: 10 }] })), { name: 'Error' });
  }
});

test('collection timestamps must be offset-aware, real and within five minutes of the server clock', () => {
  for (const timestamp of ['2026-11-09T04:00:00', '2026-02-30T04:00:00Z', '2026-11-09T25:00:00Z', '2026-11-09T04:05:00.001Z', 1794196800000, null]) {
    assert.throws(() => run(base({ collected_at: timestamp })), { name: 'Error' });
  }
  assert.equal(run(base({ collected_at: '2026-11-09T04:05:00Z' })).collectedAt, '2026-11-09T04:05:00.000Z');
});

test('native sleep keeps the XML sleep ID, waking date and overlap union across devices', () => {
  const result = run(base({ sleep_samples: [
    sample('Asleep', { source: 'Phone' }),
    sample('AsleepCore', { start: '2026-11-08T00:00:00+08:00', end: '2026-11-08T04:00:00+08:00', source: 'Watch' }),
    sample('AsleepDeep', { start: '2026-11-08T03:00:00+08:00', end: '2026-11-08T06:00:00+08:00', source: 'Watch' }),
  ] }));
  assert.deepEqual(result, {
    collectedAt: '2026-11-09T04:00:00.000Z',
    rows: [{ id: 'apple:sleep:2026-11-08', day: '2026-11-08', kind: 'sleep', label: 'Apple 健康睡眠', minutes: 480, bed: '23:00', wake: '07:00', source: 'device', collectedAt: '2026-11-09T04:00:00.000Z' }],
    latestDataDay: '2026-11-08',
  });
});

test('explicit English, HealthKit enum and Chinese sleep states normalize without guessing', () => {
  for (const state of [1, 3, 4, 5, '1', '3', '4', '5', 'Asleep', 'AsleepUnspecified', 'AsleepCore', 'AsleepDeep', 'AsleepREM', 'Core', 'Deep', 'REM', 'Asleep (Core)', 'HKCategoryValueSleepAnalysisAsleepREM', '核心睡眠', '深度睡眠', '快速眼动睡眠', '已入睡']) {
    assert.equal(run(base({ sleep_samples: [sample(state)] })).rows[0].minutes, 480, String(state));
  }
  for (const state of [0, 2, '0', '2', 'InBed', 'In Bed', 'Awake', '卧床', '清醒']) {
    assert.deepEqual(run(base({ sleep_samples: [sample(state)] })).rows, [], String(state));
  }
  for (const state of [true, 6, 'asleepUnknown', 'HKCategoryValueSleepAnalysisAsleepUnknown', 'something asleep', '新睡眠状态', null]) {
    assert.throws(() => run(base({ sleep_samples: [sample(state)] })), { name: 'Error' }, String(state));
  }
});

test('awake and in-bed intervals bridge midnight without adding asleep minutes', () => {
  const result = run(base({ range_start: '2026-11-07', sleep_samples: [
    sample('卧床', { start: '2026-11-07T22:30:00+08:00', end: '2026-11-08T07:30:00+08:00' }),
    sample('核心睡眠', { end: '2026-11-07T23:30:00+08:00' }),
    sample('清醒', { start: '2026-11-07T23:30:00+08:00', end: '2026-11-08T00:15:00+08:00' }),
    sample('快速眼动睡眠', { start: '2026-11-08T00:15:00+08:00' }),
  ] }));
  assert.deepEqual(result.rows.map(({ day, minutes, bed, wake }) => ({ day, minutes, bed, wake })), [{ day: '2026-11-08', minutes: 435, bed: '23:00', wake: '07:00' }]);
});

test('a source or device cannot bridge another source disconnected sleep stages', () => {
  for (const identity of [{ source: 'Other app' }, { device: 'Other Watch' }]) {
    const result = run(base({ range_start: '2026-11-07', sleep_samples: [
      sample('InBed', { ...identity, start: '2026-11-07T22:00:00+08:00', end: '2026-11-08T08:00:00+08:00' }),
      sample('AsleepCore', { end: '2026-11-07T23:30:00+08:00' }),
      sample('AsleepREM', { start: '2026-11-08T00:15:00+08:00' }),
    ] }));
    assert.deepEqual(result.rows.map(({ day, minutes }) => ({ day, minutes })), [{ day: '2026-11-07', minutes: 30 }, { day: '2026-11-08', minutes: 405 }]);
  }
});

test('volatile HealthKit device metadata does not split connected sleep phases', () => {
  const result = run(base({ sleep_samples: [
    sample('AsleepCore', { end: '2026-11-07T23:30:00+08:00', device: '<<HKDevice: 0x111>, name:Apple Watch, model:Watch, software:10.0, localIdentifier:watch-one, >' }),
    sample('AsleepREM', { start: '2026-11-07T23:30:00+08:00', device: '<<HKDevice: 0x222>, model:Watch, localIdentifier:watch-one, software:11.0, name:Apple Watch, >' }),
  ] }));
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].minutes, 480);
});

test('sleep range_start filters waking days after complete session normalization', () => {
  const sleep_samples = [
    sample('Asleep', { start: '2026-11-06T23:00:00+08:00', end: '2026-11-07T07:00:00+08:00' }),
    sample('Asleep'),
  ];
  assert.deepEqual(run(base({ sleep_samples })).rows.map(row => row.day), ['2026-11-08']);
  assert.deepEqual(run(base({ range_start: '2026-11-07', sleep_samples })).rows.map(row => row.day), ['2026-11-07', '2026-11-08']);
  assert.deepEqual(run(base({ range_start: '2026-11-09', sleep_samples })).rows, []);
  assert.throws(() => run(base({ range_start: '2026-02-30', sleep_samples })), { name: 'Error' });
});

test('a month catchup includes its earliest complete overnight and drops the query buffer day', () => {
  const result = run(base({ range_start: '2026-10-11', sleep_samples: [
    sample('Asleep', { start: '2026-10-09T23:00:00+08:00', end: '2026-10-10T07:00:00+08:00' }),
    sample('Asleep', { start: '2026-10-10T23:00:00+08:00', end: '2026-10-11T07:00:00+08:00' }),
    sample('Asleep', { start: '2026-11-08T23:00:00+08:00', end: '2026-11-09T07:00:00+08:00' }),
  ] }));
  assert.deepEqual(result.rows.map(({ day, minutes }) => ({ day, minutes })), [{ day: '2026-10-11', minutes: 480 }, { day: '2026-11-09', minutes: 480 }]);
  assert.equal(result.latestDataDay, '2026-11-09');
});

test('delayed snapshots default their earliest waking day relative to phone collection time', () => {
  const result = run(base({ collected_at: '2026-11-08T12:00:00+08:00', sleep_samples: [
    sample('Asleep', { start: '2026-11-06T23:00:00+08:00', end: '2026-11-07T07:00:00+08:00' }),
    sample('Asleep'),
  ] }));
  assert.deepEqual(result.rows.map(row => row.day), ['2026-11-07', '2026-11-08']);
});

test('sleep timestamps reject missing offsets, impossible dates, nonpositive intervals and future ends', () => {
  for (const extra of [
    { start: '2026-11-07T23:00:00' },
    { end: '2026-02-30T07:00:00+08:00' },
    { end: '2026-11-07T23:00:00+08:00' },
    { end: '2026-11-07T22:00:00+08:00' },
    { end: '2026-11-09T12:00:01+08:00' },
    { source: 5 },
    { device: {} },
  ]) assert.throws(() => run(base({ sleep_samples: [sample('Asleep', extra)] })), { name: 'Error' });
});

test('sleep source and device metadata have a bounded length without truncating identities', () => {
  for (const key of ['source', 'device']) {
    assert.equal(run(base({ sleep_samples: [sample('Asleep', { [key]: 'x'.repeat(512) })] })).rows[0].minutes, 480);
    assert.throws(() => run(base({ sleep_samples: [sample('Asleep', { [key]: 'x'.repeat(513) })] })), { name: 'Error' });
  }
});

test('payload shape, version, bounded arrays and their items are validated before producing rows', () => {
  for (const payload of [null, [], {}, base({ version: '1' }), base({ activities: {} }), base({ sleep_samples: {} }), base({ activities: [null] }), base({ sleep_samples: [null] })]) {
    assert.throws(() => run(payload), { name: 'Error' });
  }
  const activities = Array.from({ length: 366 }, (_, n) => ({ date: new Date(Date.UTC(2025, 0, n + 1)).toISOString().slice(0, 10), steps: 1 }));
  assert.equal(run(base({ activities })).rows.length, 366);
  assert.throws(() => run(base({ activities: Array.from({ length: 367 }, (_, n) => ({ date: new Date(Date.UTC(2025, 0, n + 1)).toISOString().slice(0, 10), steps: 1 })) })), { name: 'Error' });
  const supported = Array.from({ length: 12000 }, () => sample());
  assert.equal(run(base({ sleep_samples: supported })).rows[0].minutes, 480);
  assert.throws(() => run(base({ sleep_samples: [...supported, sample()] })), { name: 'Error' });
});

test('an empty upload reports no measurement day', () => {
  assert.deepEqual(run(base({ activities: [], sleep_samples: [] })), { collectedAt: '2026-11-09T04:00:00.000Z', rows: [], latestDataDay: null });
});

test('exported XML helpers execute in an isolated browser context and keep unknown-state behavior', () => {
  const names = ['bjDate', 'round', 'appleSleepSource', 'appleSleepRows', 'appleSleepDayRows', 'appleLegacySleepRows'];
  for (const name of names) assert.equal(typeof sleepModule[name], 'function', name + ' is exported');
  const context = vm.createContext({});
  vm.runInContext(names.map(name => sleepModule[name].toString()).join('\n'), context);
  const result = vm.runInContext(`appleSleepRows([
    {value:'HKCategoryValueSleepAnalysisAsleepUnknown',start:1794074400000,end:1794110400000,source:'Watch'},
    {value:'HKCategoryValueSleepAnalysisAsleepREM',start:1794088800000,end:1794092400000,source:'Watch'}
  ],'2026-11-09')`, context);
  assert.deepEqual(structuredClone(result).map(({ day, minutes }) => ({ day, minutes })), [{ day: '2026-11-08', minutes: 60 }]);
});
