import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { renderMonthDashboard } from '../worker/monthly-dashboard.js';

const render = renderMonthDashboard;
const entry = (kind, day, data = {}) => ({ id: `${kind}:${day}`, kind, day, label: kind, source: 'manual', ...data });
const state = entries => ({ today: '2026-11-09', entries, latestWeight: { day: '2026-11-09', kg: 99 } });
const window = { from: '2026-10-01', to: '2026-10-31' };
const metric = (html, name) => {
  const match = html.match(new RegExp('<div[^>]*data-metric="' + name + '"[^>]*>([\\s\\S]*?)<\\/div>'));
  assert.ok(match, 'rendered metric ' + name);
  return match[1].replace(/<[^>]*>/g, ' ');
};
const section = (html, name) => {
  const match = html.match(new RegExp('<article[^>]*data-section="' + name + '"[^>]*>([\\s\\S]*?)<\\/article>'));
  assert.ok(match, 'rendered section ' + name);
  return match[1];
};
const row = (html, day) => {
  const match = html.match(new RegExp('<tr[^>]*data-day="' + day + '"[^>]*>([\\s\\S]*?)<\\/tr>'));
  assert.ok(match, 'rendered day ' + day);
  return match[1].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
};

test('selected calendar window is inclusive and uses its own latest weight', () => {
  const html = render(state([
    entry('weight', '2026-09-30', { kg: 91 }),
    entry('weight', '2026-10-01', { kg: 90 }),
    entry('weight', '2026-10-31', { kg: 88 }),
    entry('weight', '2026-11-01', { kg: 87 }),
    entry('meal', '2026-10-01', { kcal: 1600 }),
    entry('meal', '2026-10-31', { kcal: 2000 }),
    entry('meal', '2026-11-01', { kcal: 9000 }),
  ]), window);
  assert.match(html, /2026-10-01 至 2026-10-31/);
  assert.match(metric(html, 'weight'), /88\s*kg/);
  assert.doesNotMatch(metric(html, 'weight'), /99|87|91/);
  assert.match(metric(html, 'kcal'), /1,800\s*kcal/);
  assert.match(metric(html, 'kcal'), /2\s*\/\s*31 天/);
});

test('weight chart agrees with the latest selected measurement when sources share a day', () => {
  const html = render(state([
    entry('weight', '2026-10-20', { kg: 80 }),
    entry('weight', '2026-10-20', { source: 'device', kg: 90 }),
  ]), window);
  assert.match(metric(html, 'weight'), /80\s*kg/);
  assert.match(section(html, 'weight'), /<title>2026-10-20 · 80 kg<\/title>/);
  assert.doesNotMatch(section(html, 'weight'), /90\s*kg/);
});

test('Apple nutrition takes precedence per field and keeps manual meal names', () => {
  const html = render(state([
    entry('nutrition', '2026-10-02', { source: 'device', kcal: 1800, protein: 90 }),
    entry('meal', '2026-10-02', { label: '午餐米饭', source: 'estimate', kcal: 600, protein: 20, fat: 12, carbs: 75 }),
    entry('meal', '2026-10-02', { label: '晚餐豆腐', kcal: 400, fat: 8, carbs: 25 }),
    entry('meal', '2026-10-03', { kcal: 1200, protein: 60 }),
    entry('nutrition', '2026-10-03', { source: 'manual', kcal: 9999 }),
  ]), window);
  assert.match(metric(html, 'kcal'), /1,500\s*kcal/);
  const nutrition = section(html, 'nutrition');
  assert.match(row(nutrition, '2026-10-02'), /1,800.*90.*20.*100/);
  assert.match(row(nutrition, '2026-10-03'), /1,200/);
  assert.match(nutrition, /午餐米饭/);
  assert.match(nutrition, /晚餐豆腐/);
  assert.match(nutrition, /Apple 健康.*优先/);
  assert.doesNotMatch(nutrition, /9,999/);
});

test('nutrition averages disclose estimates only when those meal fields contribute', () => {
  const estimated = render(state([
    entry('meal', '2026-10-02', { source: 'estimate', kcal: 600, protein: 20 }),
  ]), window);
  assert.match(metric(estimated, 'kcal'), /含估算/);
  const measured = render(state([
    entry('nutrition', '2026-10-02', { source: 'device', kcal: 1800 }),
    entry('meal', '2026-10-02', { source: 'estimate', kcal: 600, protein: 20 }),
  ]), window);
  assert.doesNotMatch(metric(measured, 'kcal'), /含估算/);
  assert.match(section(measured, 'nutrition'), /蛋白质[\s\S]*含估算/);
});

test('missing fields stay unknown while genuine zeros count toward known-day averages', () => {
  const html = render(state([
    entry('meal', '2026-10-01', { label: '只记了名称' }),
    entry('nutrition', '2026-10-02', { source: 'device', kcal: 0, water_ml: 0 }),
    entry('activity', '2026-10-01', { source: 'device', steps: 0 }),
    entry('activity', '2026-10-02', { source: 'device', steps: 3000 }),
    entry('activity', '2026-10-03', { source: 'device', active_energy_kcal: 400 }),
  ]), window);
  assert.match(metric(html, 'kcal'), /0\s*kcal/);
  assert.match(metric(html, 'kcal'), /1\s*\/\s*31 天/);
  assert.match(metric(html, 'steps'), /1,500\s*步/);
  assert.match(metric(html, 'steps'), /2\s*\/\s*31 天/);
  assert.match(row(section(html, 'nutrition'), '2026-10-01'), /—/);
  assert.match(row(section(html, 'nutrition'), '2026-10-02'), /0/);
  assert.match(row(section(html, 'daily'), '2026-10-03'), /—.*—.*—.*—/);
});

test('device sleep wins once per waking day and sparse trends keep selected date bounds', () => {
  const html = render(state([
    entry('sleep', '2026-10-03', { minutes: 600, bed: '21:00', wake: '07:00' }),
    entry('sleep', '2026-10-03', { source: 'device', minutes: 420, bed: '00:00', wake: '07:00' }),
    entry('sleep', '2026-10-04', { minutes: 480, bed: '23:00', wake: '07:00' }),
    entry('sleep', '2026-10-04', { minutes: 720, bed: '19:00', wake: '07:00' }),
  ]), window);
  assert.match(metric(html, 'sleep'), /7\.5\s*小时/);
  assert.match(metric(html, 'sleep'), /2\s*\/\s*31 天/);
  const sleep = section(html, 'sleep');
  assert.match(sleep, /2026-10-01/);
  assert.match(sleep, /2026-10-31/);
  assert.match(row(sleep, '2026-10-03'), /7.*00:00.*07:00/);
  assert.doesNotMatch(row(sleep, '2026-10-03'), /21:00/);
  assert.doesNotMatch(row(sleep, '2026-10-04'), /19:00/);
  assert.equal((sleep.match(/data-day="2026-10-03"/g) || []).length, 1);
});

test('workout sessions and types exclude Apple exercise ring minutes and active energy', () => {
  const html = render(state([
    entry('workout', '2026-10-05', { label: '羽毛球', minutes: 90, kcal: 650 }),
    entry('workout', '2026-10-06', { label: '跑步', minutes: 30 }),
    entry('activity', '2026-10-05', { source: 'device', apple_exercise_minutes: 100, active_energy_kcal: 1000 }),
  ]), window);
  assert.match(metric(html, 'workout'), /120\s*分钟/);
  assert.match(metric(html, 'workout'), /2 次/);
  assert.doesNotMatch(metric(html, 'workout'), /220/);
  assert.match(section(html, 'workout'), /羽毛球/);
  assert.match(section(html, 'workout'), /跑步/);
  assert.match(section(html, 'activity'), /Apple 锻炼圆环.*100\s*分钟/);
  assert.match(section(html, 'activity'), /1,000\s*kcal/);
});

test('optional vitals report each metric with its own known-day coverage', () => {
  const html = render(state([
    entry('vitals', '2026-10-01', { source: 'device', heart_rate_bpm: 70, hrv_ms: 40, spo2_percent: 98 }),
    entry('vitals', '2026-10-02', { source: 'device', heart_rate_bpm: 80, resting_heart_rate_bpm: 55, respiratory_rate: 14, body_fat_percent: 20, bmi: 23 }),
  ]), window);
  const vitals = section(html, 'vitals');
  assert.match(vitals, /心率[\s\S]*75\s*bpm[\s\S]*2\s*\/\s*31 天/);
  assert.match(vitals, /静息心率[\s\S]*55\s*bpm[\s\S]*1\s*\/\s*31 天/);
  assert.match(vitals, /心率变异性|HRV/);
  assert.match(vitals, /血氧/);
  assert.match(vitals, /呼吸频率/);
  assert.match(vitals, /体脂/);
  assert.match(vitals, /BMI/);
});

test('untrusted labels, source names, title, and meal edit IDs cannot inject markup', () => {
  const html = render(state([
    entry('meal', '2026-10-01', { id: '\" onclick=\"alert(1)', label: '<img src=x onerror=alert(1)>', source: '<script>alert(1)</script>', kcal: 200 }),
    entry('workout', '2026-10-02', { label: '<svg onload=alert(1)>', minutes: 30 }),
  ]), { ...window, title: '<script>title</script>' });
  assert.doesNotMatch(html, /<script>|<img|<svg onload| onclick=/);
  assert.match(html, /&lt;img/);
  assert.match(html, /&lt;script&gt;title/);
  assert.match(html, /&lt;script&gt;alert/);
  assert.doesNotMatch(html, /data-edit="&quot;|data-del="&quot;/);
});

test('manual records remain editable and recorded device sleep can be deleted for correction', () => {
  const html = render(state([
    entry('meal', '2026-10-01', { id: 'meal:one', kcal: 400 }),
    entry('workout', '2026-10-02', { id: 'workout:one', minutes: 30 }),
    entry('sleep', '2026-10-03', { id: 'apple:sleep:2026-10-03', source: 'device', minutes: 420 }),
    entry('sleep', '2026-10-03', { id: 'sleep:manual:hidden', minutes: 480 }),
    entry('sleep', '2026-10-04', { id: 'sleep:manual', minutes: 480 }),
    entry('weight', '2026-10-05', { id: 'weight:one', kg: 80 }),
  ]), window);
  assert.match(section(html, 'nutrition'), /data-edit="meal:one"/);
  assert.match(section(html, 'nutrition'), /data-del="meal:one"/);
  assert.match(section(html, 'workout'), /data-edit="workout:one"/);
  assert.match(section(html, 'sleep'), /data-del="apple:sleep:2026-10-03"/);
  assert.doesNotMatch(section(html, 'sleep'), /data-edit="apple:sleep:/);
  assert.match(section(html, 'sleep'), /data-edit="sleep:manual"/);
  assert.match(section(html, 'sleep'), /data-edit="sleep:manual:hidden"/);
  assert.match(section(html, 'weight'), /data-edit="weight:one"/);
});

test('empty months explain missing diet data and never invent sleep, steps, or body values', () => {
  const html = render(state([]), window);
  for (const name of ['kcal', 'sleep', 'steps', 'weight']) assert.match(metric(html, name), /—/);
  assert.match(html, /健康导出里没有饮食？可点补充记录/);
  assert.match(html, /手表.*不会.*饮食|不会.*自动.*饮食/);
  assert.match(metric(html, 'kcal'), /0\s*\/\s*31 天/);
  assert.doesNotMatch(html, /NaN|Infinity|99\s*kg/);
});

test('exported renderer runs from its source alone in the browser without external helpers', () => {
  render(state([]), window);
  const isolated = vm.runInNewContext('(' + renderMonthDashboard.toString() + ')');
  const html = isolated(state([entry('meal', '2026-10-01', { kcal: 500 })]), window);
  assert.match(metric(html, 'kcal'), /500\s*kcal/);
});
