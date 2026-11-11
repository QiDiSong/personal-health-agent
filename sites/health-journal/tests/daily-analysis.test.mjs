import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { analyzeHealthDay } from '../worker/daily-analysis.js';

const day = '2026-11-09';
const row = (kind, date = day, data = {}) => ({ id: kind + ':' + date, kind, day: date, label: kind, source: 'manual', ...data });
const state = entries => ({ today: day, entries, goal: 65, latestWeight: { day: '2026-11-08', kg: 75 }, baselineKg: 80, heightCm: 170 });
const analyze = entries => analyzeHealthDay(state(entries), { day });
const section = (report, key) => {
  const found = report.sections.find(item => item.key === key);
  assert.ok(found, 'section ' + key);
  return found;
};
const metric = (report, area, key) => {
  const found = section(report, area).metrics.find(item => item.key === key);
  assert.ok(found, 'metric ' + area + '/' + key);
  return found;
};
const prose = report => JSON.stringify(report.sections.map(item => [item.facts, item.interpretation, item.suggestions]).concat([report.summary]));

test('empty days preserve unknowns and explain coverage without borrowing latest weight', () => {
  const report = analyze([]);
  assert.equal(report.recordCount, 0);
  assert.equal(report.latestDataDay, null);
  assert.equal(report.coverage.totalSections, 6);
  assert.equal(report.coverage.missingSections, 6);
  for (const item of report.sections) {
    assert.equal(item.status, 'missing');
    for (const value of item.metrics) assert.equal(value.value, null);
  }
  assert.equal(metric(report, 'weight', 'kg').value, null);
  assert.ok(report.summary.priorities.length > 0);
  assert.match(prose(report), /缺失|未记录|没有/);
  assert.doesNotMatch(prose(report), /75 kg|80 kg|BMI.*正常|摄入不足/);
});

test('genuine numeric zero is retained while nonfinite, negative and string values stay unknown', () => {
  const report = analyze([
    row('nutrition', day, { source: 'device', kcal: 0, protein: -1, fat: '3', carbs: Infinity }),
    row('activity', day, { source: 'device', steps: 0, apple_exercise_minutes: 0 }),
    row('vitals', day, { source: 'device', hrv_ms: 0 }),
  ]);
  assert.equal(metric(report, 'nutrition', 'kcal').value, 0);
  assert.equal(metric(report, 'nutrition', 'protein').value, null);
  assert.equal(metric(report, 'nutrition', 'fat').value, null);
  assert.equal(metric(report, 'nutrition', 'carbs').value, null);
  assert.equal(metric(report, 'activity', 'steps').value, 0);
  assert.equal(metric(report, 'vitals', 'hrv_ms').value, 0);
  assert.equal(section(report, 'exercise').status, 'missing');
});

test('per-field Apple nutrition wins without adding meals or duplicate daily summaries', () => {
  const report = analyze([
    row('nutrition', day, { source: 'device', kcal: 1800, protein: 80 }),
    row('nutrition', day, { id: 'older:daily', source: 'device', kcal: 9999, protein: 999 }),
    row('meal', day, { id: 'lunch', label: '午餐', source: 'estimate', kcal: 600, protein: 20, fat: 12 }),
    row('meal', day, { id: 'dinner', label: '晚餐', kcal: 400, fat: 8 }),
    row('nutrition', day, { id: 'manual:daily', source: 'manual', carbs: 999 }),
  ]);
  assert.equal(metric(report, 'nutrition', 'kcal').value, 1800);
  assert.equal(metric(report, 'nutrition', 'kcal').estimated, false);
  assert.equal(metric(report, 'nutrition', 'protein').value, 80);
  assert.equal(metric(report, 'nutrition', 'fat').value, 20);
  assert.equal(metric(report, 'nutrition', 'fat').estimated, true);
  assert.equal(metric(report, 'nutrition', 'carbs').value, null);
  assert.match(section(report, 'nutrition').facts.join(' '), /Apple 健康.*优先|优先.*Apple 健康/);
});

test('partial meal fields disclose known versus missing and never imply complete daily intake', () => {
  const report = analyze([
    row('meal', day, { id: 'lunch', kcal: 600, protein: 20 }),
    row('meal', day, { id: 'dinner', kcal: 400 }),
    row('activity', day, { source: 'device', active_energy_kcal: 700 }),
  ]);
  const protein = metric(report, 'nutrition', 'protein');
  assert.equal(protein.value, 20);
  assert.deepEqual(protein.coverage, { known: 1, total: 2, missing: 1 });
  assert.equal(section(report, 'nutrition').status, 'partial');
  assert.match(section(report, 'nutrition').facts.join(' '), /蛋白质.*1\s*\/\s*2|1\s*\/\s*2.*蛋白质/);
  assert.match(prose(report), /全天|完整/);
  const conclusions = report.sections.flatMap(item => [...item.interpretation, ...item.suggestions]).join('\n');
  assert.doesNotMatch(conclusions, /热量缺口|热量赤字|能量缺口|摄入不足|蛋白质不足|减[^。\n]*卡|(?:建议|应当|目标|需要)(?:摄入|补充|控制|达到)[^。\n]*\d+\s*(?:kcal|g)/);
});

test('estimated input is qualified in numeric facts and summary advice', () => {
  const report = analyze([row('meal', day, { source: 'estimate', kcal: 600, protein: 20 })]);
  assert.equal(metric(report, 'nutrition', 'kcal').estimated, true);
  assert.match(section(report, 'nutrition').facts.join(' '), /约.*600.*kcal|600.*kcal.*估算/);
  assert.match(prose(report), /估算/);
});

test('Apple nutrient-only days are acknowledged even when calories and meals are unknown', () => {
  const report = analyze([row('nutrition', day, { source: 'device', protein: 80, water_ml: 1500 })]);
  const advice = section(report, 'nutrition').suggestions.join(' ') + ' ' + report.summary.priorities.map(item => item.detail).join(' ');
  assert.equal(metric(report, 'nutrition', 'kcal').value, null);
  assert.match(advice, /蛋白质.*80.*g|2 项.*营养|营养.*2 项/);
  assert.doesNotMatch(advice, /尚无饮食营养记录/);
});

test('estimates in prior personal means qualify the derived difference in advice', () => {
  const report = analyze([
    row('sleep', day, { minutes: 420 }),
    row('sleep', '2026-11-08', { source: 'estimate', minutes: 480 }),
    row('sleep', '2026-11-07', { minutes: 480 }),
    row('sleep', '2026-11-06', { minutes: 480 }),
  ]);
  const sleep = section(report, 'sleep');
  assert.equal(sleep.metrics[0].baseline.estimated, true);
  assert.match(sleep.interpretation.join(' '), /日均约\s*480/);
  assert.match(sleep.suggestions.join(' '), /少约\s*60 分钟/);
});

test('one preferred sleep is used per waking day and current day is excluded from personal baseline', () => {
  const report = analyze([
    row('sleep', day, { minutes: 600 }),
    row('sleep', day, { source: 'device', minutes: 420, bed: '00:30', wake: '07:30' }),
    row('sleep', '2026-11-08', { minutes: 800 }),
    row('sleep', '2026-11-08', { source: 'device', minutes: 480 }),
    row('sleep', '2026-11-07', { minutes: 420 }),
    row('sleep', '2026-11-06', { minutes: 360 }),
    row('sleep', '2026-11-01', { minutes: 900 }),
    row('sleep', '2026-11-10', { minutes: 900 }),
  ]);
  const sleep = metric(report, 'sleep', 'minutes');
  assert.equal(sleep.value, 420);
  assert.equal(sleep.baseline.value, 420);
  assert.equal(sleep.baseline.days, 3);
  assert.equal(sleep.baseline.delta, 0);
  assert.equal(sleep.baseline.from, '2026-11-02');
  assert.equal(sleep.baseline.to, '2026-11-08');
  assert.match(section(report, 'sleep').facts.join(' '), /00:30.*07:30/);
  assert.doesNotMatch(prose(report), /睡眠不足|正常睡眠|7[–—-]9|规律性.*\d/);
});

test('actual workout sessions and minutes do not add activity ring or active energy', () => {
  const report = analyze([
    row('workout', day, { id: 'run', label: '跑步', minutes: 30, kcal: 200 }),
    row('workout', day, { id: 'walk', label: '步行', minutes: 20 }),
    row('activity', day, { source: 'device', apple_exercise_minutes: 60, active_energy_kcal: 600 }),
  ]);
  assert.equal(metric(report, 'exercise', 'sessions').value, 2);
  assert.equal(metric(report, 'exercise', 'minutes').value, 50);
  assert.equal(metric(report, 'activity', 'apple_exercise_minutes').value, 60);
  assert.match(section(report, 'exercise').facts.join(' '), /跑步.*30|30.*跑步/);
  assert.doesNotMatch(prose(report), /中高强度|达标|110 分钟|消耗.*800/);
});

test('unknown workout minutes do not make a complete duration', () => {
  const report = analyze([
    row('workout', day, { id: 'run', minutes: 30 }),
    row('workout', day, { id: 'unknown' }),
  ]);
  assert.equal(metric(report, 'exercise', 'sessions').value, 2);
  assert.equal(metric(report, 'exercise', 'minutes').value, 30);
  assert.equal(section(report, 'exercise').status, 'partial');
  assert.match(section(report, 'exercise').facts.join(' '), /1\s*\/\s*2|1.*未.*时长|时长.*1.*缺/);
});

test('steps use known daily values in the preceding seven calendar days, retaining zero', () => {
  const report = analyze([
    row('activity', day, { source: 'device', steps: 5000 }),
    row('activity', '2026-11-08', { source: 'device', steps: 0 }),
    row('activity', '2026-11-08', { id: 'older', source: 'device', steps: 99999 }),
    row('activity', '2026-11-05', { source: 'device', steps: 3000 }),
    row('activity', '2026-11-02', { source: 'device', steps: 6000 }),
    row('activity', '2026-11-01', { source: 'device', steps: 99999 }),
    row('activity', '2026-11-10', { source: 'device', steps: 99999 }),
  ]);
  const steps = metric(report, 'activity', 'steps');
  assert.equal(steps.baseline.value, 3000);
  assert.equal(steps.baseline.days, 3);
  assert.equal(steps.baseline.windowDays, 7);
  assert.equal(steps.baseline.delta, 2000);
  assert.match(section(report, 'activity').interpretation.join(' '), /3\s*\/\s*7|3.*天/);
  assert.equal(report.latestDataDay, day);
});

test('fewer than three prior known dates does not produce a baseline comparison', () => {
  const report = analyze([
    row('activity', day, { source: 'device', steps: 5000 }),
    row('activity', '2026-11-08', { source: 'device', steps: 1000 }),
    row('activity', '2026-11-07', { source: 'device', steps: 2000 }),
  ]);
  assert.equal(metric(report, 'activity', 'steps').baseline, undefined);
  assert.match(section(report, 'activity').interpretation.join(' '), /2\s*\/\s*7|2.*天/);
  assert.doesNotMatch(section(report, 'activity').interpretation.join(' '), /高于|低于|增加|减少/);
});

test('weight uses newest provided measurement each day without substituting a profile value', () => {
  const report = analyze([
    row('weight', day, { kg: 72 }),
    row('weight', day, { id: 'older', kg: 79 }),
    row('weight', '2026-11-08', { kg: 73 }),
    row('weight', '2026-11-08', { id: 'older:prior', kg: 99 }),
    row('weight', '2026-11-07', { kg: 74 }),
    row('weight', '2026-11-06', { kg: 75 }),
  ]);
  const weight = metric(report, 'weight', 'kg');
  assert.equal(weight.value, 72);
  assert.equal(weight.baseline.value, 74);
  assert.equal(weight.baseline.days, 3);
  assert.equal(weight.baseline.delta, -2);
  assert.doesNotMatch(prose(report), /超重|肥胖|正常体重|减重[^。"]*\d|BMI\s*[：:]?\s*\d/);
});

test('each vital has its own personal baseline coverage without diagnostic thresholds', () => {
  const report = analyze([
    row('vitals', day, { source: 'device', heart_rate_bpm: 80, hrv_ms: 50, spo2_percent: 95, bmi: 25 }),
    row('vitals', '2026-11-08', { source: 'device', heart_rate_bpm: 60, hrv_ms: 40 }),
    row('vitals', '2026-11-07', { source: 'device', heart_rate_bpm: 70, hrv_ms: 50 }),
    row('vitals', '2026-11-06', { source: 'device', heart_rate_bpm: 80 }),
  ]);
  assert.equal(metric(report, 'vitals', 'heart_rate_bpm').baseline.value, 70);
  assert.equal(metric(report, 'vitals', 'heart_rate_bpm').baseline.days, 3);
  assert.equal(metric(report, 'vitals', 'heart_rate_bpm').baseline.delta, 10);
  assert.equal(metric(report, 'vitals', 'hrv_ms').baseline, undefined);
  assert.equal(metric(report, 'vitals', 'bmi').value, 25);
  assert.match(section(report, 'vitals').interpretation.join(' '), /日汇总|日均|每天.*平均/);
  assert.doesNotMatch(prose(report), /缺氧|心动过速|心动过缓|肥胖|超重|正常范围|有氧能力|增加.*运动.*心率|低于.*95/);
});

test('historical selected day controls records and baseline instead of today', () => {
  const report = analyzeHealthDay(state([
    row('weight', '2026-11-08', { kg: 70 }),
    row('weight', '2026-11-04', { kg: 74 }),
    row('weight', '2026-11-03', { kg: 75 }),
    row('weight', '2026-11-02', { kg: 76 }),
    row('weight', '2026-11-01', { kg: 77 }),
  ]), { day: '2026-11-04' });
  assert.equal(report.day, '2026-11-04');
  assert.equal(report.recordCount, 1);
  assert.equal(report.coverage.isToday, false);
  assert.equal(metric(report, 'weight', 'kg').value, 74);
  assert.equal(metric(report, 'weight', 'kg').baseline.value, 76);
  assert.equal(metric(report, 'weight', 'kg').baseline.days, 3);
});

test('missing-data reminders leave one summary priority for the day\'s recorded observation', () => {
  const report = analyze([
    row('weight', day, { kg: 72 }),
    row('weight', '2026-11-08', { kg: 73 }),
    row('weight', '2026-11-07', { kg: 74 }),
    row('weight', '2026-11-06', { kg: 75 }),
  ]);
  assert.equal(report.summary.priorities.length, 3);
  assert.ok(report.summary.priorities.some(item => /72 kg/.test(item.detail)));
  assert.ok(report.summary.priorities.some(item => /补齐.*记录/.test(item.title)));
});

test('analysis is immutable, repeatable and works when injected from source alone', () => {
  const input = state([row('meal', day, { source: 'estimate', kcal: 500 }), row('weight', day, { kg: 72 })]);
  const before = JSON.stringify(input);
  Object.freeze(input.entries[0]); Object.freeze(input.entries[1]); Object.freeze(input.entries); Object.freeze(input);
  const first = analyzeHealthDay(input, { day });
  const second = analyzeHealthDay(input, { day });
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(first, second);
  const isolated = vm.runInNewContext('(' + analyzeHealthDay.toString() + ')');
  assert.equal(JSON.stringify(isolated(input, { day })), JSON.stringify(first));
  assert.equal(metric(first, 'nutrition', 'kcal').value, 500);
  const corrected = analyzeHealthDay(state([row('meal', day, { kcal: 800 })]), { day });
  assert.equal(metric(corrected, 'nutrition', 'kcal').value, 800);
});

test('invalid and future analysis days are rejected and malformed rows ignored', () => {
  for (const invalid of ['2026-02-30', '2026-1-01', '2026-11-10']) assert.throws(() => analyzeHealthDay(state([]), { day: invalid }), /日期/);
  const report = analyze([null, {}, row('meal', '2026-02-30', { kcal: 900 }), row('meal', day, { kcal: 400 })]);
  assert.equal(report.recordCount, 1);
  assert.equal(metric(report, 'nutrition', 'kcal').value, 400);
});
