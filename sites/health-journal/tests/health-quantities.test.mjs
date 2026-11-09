import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { appleSleepSource } from '../worker/apple-sleep.js';
import { quantityRows } from '../worker/health-quantities.js';

const options = { today: '2026-11-09' };
const at = (day = '2026-11-08', time = '12:00') => `${day} ${time}:00 +0800`;
const sample = (type, value, unit, extra = {}) => ({
  type: 'HKQuantityTypeIdentifier' + type, value, unit,
  startDate: at(), endDate: at(), sourceName: 'Watch', device: '', ...extra,
});

test('overlapping Watch and iPhone activity uses one source total per metric', () => {
  const rows = quantityRows([
    sample('StepCount', '1200', 'count'),
    sample('StepCount', '800', 'count', { startDate: at('2026-11-08', '13:00'), endDate: at('2026-11-08', '13:00') }),
    sample('StepCount', '1500', 'count', { sourceName: 'iPhone' }),
    sample('ActiveEnergyBurned', '100', 'kcal'),
    sample('ActiveEnergyBurned', '150', 'kcal', { sourceName: 'iPhone' }),
  ], options);
  assert.deepEqual(rows, [{ id: 'apple:activity:2026-11-08', day: '2026-11-08', kind: 'activity', label: 'Apple 健康活动', steps: 2000, active_energy_kcal: 150 }]);
});

test('repeated exports deduplicate samples using stable device identity', () => {
  const device1 = '<<HKDevice: 0x111>, name:Apple Watch, model:Watch, localIdentifier:one, software:10.0, >';
  const device2 = '<<HKDevice: 0x222>, software:11.0, model:Watch, name:Apple Watch, localIdentifier:one, >';
  const records = [
    sample('StepCount', '1200', 'count', { device: device1 }),
    sample('StepCount', '1200', 'count', { device: device2 }),
    sample('StepCount', '800', 'count', { device: device2, startDate: at('2026-11-08', '13:00'), endDate: at('2026-11-08', '13:00') }),
    sample('StepCount', '1800', 'count', { device: device2.replace('localIdentifier:one', 'localIdentifier:two') }),
  ];
  assert.equal(quantityRows(records, options)[0].steps, 2000);
  assert.deepEqual(quantityRows(records, options), quantityRows([...records, ...records].reverse(), options));
});

test('activity converts known energy, duration and walking distance units', () => {
  const rows = quantityRows([
    sample('ActiveEnergyBurned', '418.4', 'kJ'),
    sample('BasalEnergyBurned', '2000', 'kcal'),
    sample('AppleExerciseTime', '1', 'hr'),
    sample('AppleExerciseTime', '600', 's', { startDate: at('2026-11-08', '13:00'), endDate: at('2026-11-08', '13:00') }),
    sample('DistanceWalkingRunning', '1000', 'm'),
    sample('DistanceWalkingRunning', '1', 'mi', { startDate: at('2026-11-08', '13:00'), endDate: at('2026-11-08', '13:00') }),
    sample('DistanceWalkingRunning', '1', 'km', { startDate: at('2026-11-08', '14:00'), endDate: at('2026-11-08', '14:00') }),
  ], options);
  assert.deepEqual(rows, [{ id: 'apple:activity:2026-11-08', day: '2026-11-08', kind: 'activity', label: 'Apple 健康活动', active_energy_kcal: 100, apple_exercise_minutes: 70, walking_distance_km: 3.609, resting_energy_kcal: 2000 }]);
});

test('dietary records convert nutrients, sodium and water without inventing absent fields', () => {
  const [row] = quantityRows([
    sample('DietaryEnergyConsumed', '4184', 'kJ'),
    sample('DietaryProtein', '25000', 'mg'),
    sample('DietaryFatTotal', '10', 'g'),
    sample('DietaryCarbohydrates', '50', 'g'),
    sample('DietaryFiber', '5', 'g'),
    sample('DietarySugar', '7', 'g'),
    sample('DietarySodium', '1.2', 'g'),
    sample('DietaryWater', '1', 'L'),
    sample('DietaryWater', '250', 'mL', { startDate: at('2026-11-08', '13:00'), endDate: at('2026-11-08', '13:00') }),
  ], options);
  assert.deepEqual(row, { id: 'apple:nutrition:2026-11-08', day: '2026-11-08', kind: 'nutrition', label: 'Apple 健康营养', kcal: 1000, protein: 25, fat: 10, carbs: 50, fiber: 5, sugar: 7, sodium_mg: 1200, water_ml: 1250 });
  const partial = quantityRows([sample('DietaryWater', '0', 'mL')], options);
  assert.deepEqual(partial, [{ id: 'apple:nutrition:2026-11-08', day: '2026-11-08', kind: 'nutrition', label: 'Apple 健康营养', water_ml: 0 }]);
});

test('vitals average the source with most unique samples rather than highest measurement', () => {
  const records = [
    sample('HeartRate', '60', 'count/min', { sourceName: 'Watch A' }),
    sample('HeartRate', '80', 'bpm', { sourceName: 'Watch A', startDate: at('2026-11-08', '13:00'), endDate: at('2026-11-08', '13:00') }),
    sample('HeartRate', '80', 'bpm', { sourceName: 'Watch A', startDate: at('2026-11-08', '13:00'), endDate: at('2026-11-08', '13:00') }),
    sample('HeartRate', '150', 'count/min', { sourceName: 'Watch B' }),
    sample('RestingHeartRate', '55', 'count/min'),
    sample('HeartRateVariabilitySDNN', '0.05', 's'),
    sample('OxygenSaturation', '0.98', '%'),
    sample('RespiratoryRate', '16', 'count/min'),
    sample('BodyFatPercentage', '0.24', '%'),
    sample('BodyMassIndex', '23.4', 'count'),
  ];
  const rows = quantityRows(records, options);
  assert.deepEqual(rows, [{ id: 'apple:vitals:2026-11-08', day: '2026-11-08', kind: 'vitals', label: 'Apple 健康体征', heart_rate_bpm: 70, resting_heart_rate_bpm: 55, hrv_ms: 50, spo2_percent: 98, respiratory_rate: 16, body_fat_percent: 24, bmi: 23.4 }]);
  assert.deepEqual(quantityRows(records.reverse(), options), rows);
});

test('vital source sample-count ties resolve deterministically by source identity', () => {
  const records = [sample('HeartRate', '150', 'bpm', { sourceName: 'Z Watch' }), sample('HeartRate', '60', 'bpm', { sourceName: 'A Watch' })];
  assert.equal(quantityRows(records, options)[0].heart_rate_bpm, 60);
  assert.deepEqual(quantityRows(records.reverse(), options), quantityRows(records, options));
});

test('Shanghai start date allocates midnight-crossing samples and inclusive date filters', () => {
  const records = [
    sample('StepCount', '1', 'count', { startDate: '2026-11-07 15:59:00 +0000', endDate: '2026-11-07 16:01:00 +0000' }),
    sample('StepCount', '2', 'count', { startDate: '2026-11-07T16:00:00Z', endDate: '2026-11-08T00:01:00+08:00' }),
    sample('StepCount', '3', 'count', { startDate: at('2026-11-09'), endDate: at('2026-11-09') }),
    sample('StepCount', '4', 'count', { startDate: at('2026-11-10'), endDate: at('2026-11-10') }),
  ];
  assert.deepEqual(quantityRows(records, { ...options, from: '2026-11-08', to: '2026-11-09' }).map(({ day, steps }) => ({ day, steps })), [{ day: '2026-11-08', steps: 2 }, { day: '2026-11-09', steps: 3 }]);
  assert.deepEqual(quantityRows(records, options).map(({ day, steps }) => ({ day, steps })), [{ day: '2026-11-07', steps: 1 }, { day: '2026-11-08', steps: 2 }, { day: '2026-11-09', steps: 3 }]);
});

test('malformed values, units, dates and unknown metrics are skipped individually', () => {
  const records = [
    ...['', ' ', 'NaN', 'Infinity', '1 step', '0x10', null, false, {}, -1].map(value => sample('StepCount', value, 'count')),
    sample('StepCount', '100', 'steps'),
    sample('DietaryWater', '100', 'g'),
    sample('OxygenSaturation', '98', '%'),
    sample('OxygenSaturation', '0.98', 'count'),
    sample('BodyFatPercentage', '24', '%'),
    sample('BodyMassIndex', '24', ''),
    sample('StepCount', '100', 'count', { startDate: '2026-02-30 12:00:00 +0800' }),
    sample('StepCount', '100', 'count', { endDate: 'invalid' }),
    sample('StepCount', '100', 'count', { startDate: '2026-11-08 25:00:00 +0800' }),
    sample('StepCount', '100', 'count', { startDate: '2026-11-08 12:00:00' }),
    sample('StepCount', '100', 'count', { endDate: at('2026-11-07') }),
    sample('UnsupportedMetric', '100', 'count'), null, [],
    sample('StepCount', '500', 'count'),
  ];
  assert.deepEqual(quantityRows(records, options), [{ id: 'apple:activity:2026-11-08', day: '2026-11-08', kind: 'activity', label: 'Apple 健康活动', steps: 500 }]);
});

test('daily bounds reject excessive source totals while retaining valid metrics and sources', () => {
  const rows = quantityRows([
    sample('AppleExerciseTime', '1000', 'min'),
    sample('AppleExerciseTime', '1000', 'min', { startDate: at('2026-11-08', '13:00'), endDate: at('2026-11-08', '13:00') }),
    sample('AppleExerciseTime', '60', 'min', { sourceName: 'iPhone' }),
    sample('StepCount', '1000001', 'count'),
    sample('DietaryWater', '20001', 'mL'),
    sample('HeartRate', '999', 'bpm'),
    sample('BodyMassIndex', '0', 'count'),
    sample('DietaryProtein', '20', 'g'),
  ], options);
  assert.deepEqual(rows, [
    { id: 'apple:activity:2026-11-08', day: '2026-11-08', kind: 'activity', label: 'Apple 健康活动', apple_exercise_minutes: 60 },
    { id: 'apple:nutrition:2026-11-08', day: '2026-11-08', kind: 'nutrition', label: 'Apple 健康营养', protein: 20 },
  ]);
});

test('invalid collection and date-range configuration fail before processing records', () => {
  for (const records of [null, {}, 'xml']) assert.throws(() => quantityRows(records, options), TypeError);
  for (const config of [{}, { today: '2026-02-30' }, { ...options, from: 'invalid' }, { ...options, to: '2026-11-07', from: '2026-11-08' }]) assert.throws(() => quantityRows([], config));
});

test('quantity normalization works in the browser injection context', () => {
  const context = vm.createContext({ records: [sample('StepCount', '123', 'count')], options });
  vm.runInContext(appleSleepSource.toString() + '\n' + quantityRows.toString() + '\nresult = quantityRows(records, options)', context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.result)), [{ id: 'apple:activity:2026-11-08', day: '2026-11-08', kind: 'activity', label: 'Apple 健康活动', steps: 123 }]);
});
