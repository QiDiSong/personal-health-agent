import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { renderDailyActivity } from '../worker/daily-activity.js';

const activity = (day, data = {}) => ({ kind: 'activity', day, id: `apple:activity:${day}`, source: 'device', ...data });
const state = entries => ({ today: '2026-11-10', from: '2026-11-04', to: '2026-11-10', entries });
const rows = html => [...html.matchAll(/<tr data-day="([^"]+)">([\s\S]*?)<\/tr>/g)];
const cells = row => [...row[2].matchAll(/<(?:td|th)\b[^>]*>([\s\S]*?)<\/(?:td|th)>/g)].map(cell => cell[1].replace(/<[^>]*>/g, '').trim());

test('lists every activity record within inclusive real-date bounds in newest date and stable ID order', () => {
  const entries = [
    activity('2026-11-04', { id: 'activity:old', steps: 4 }),
    activity('2026-11-10', { id: 'activity:z', steps: 10 }),
    activity('2026-11-10', { id: 'activity:a', active_energy_kcal: 21 }),
    activity('2026-11-10', { id: 'activity:a', walking_distance_km: 1.25 }),
    activity('2026-11-03', { steps: 333 }),
    activity('2026-11-11', { steps: 111 }),
    activity('2026-11-31', { steps: 3131 }),
    activity('2026-11-4', { steps: 444 }),
    { kind: 'workout', day: '2026-11-10', id: 'workout:one', minutes: 45 },
    { kind: 'meal', day: '2026-11-10', id: 'meal:one', kcal: 900 },
    null,
  ];
  const original = structuredClone(entries);
  for (const entry of entries) if (entry) Object.freeze(entry);
  Object.freeze(entries);
  const html = renderDailyActivity(state(entries), { days: 7 });
  assert.deepEqual(rows(html).map(row => cells(row).slice(0, 6)), [
    ['2026-11-10', '—', '21', '—', '—', '—'],
    ['2026-11-10', '—', '—', '—', '1.25', '—'],
    ['2026-11-10', '10', '—', '—', '—', '—'],
    ['2026-11-04', '4', '—', '—', '—', '—'],
  ]);
  assert.match(html, /4 条记录/);
  assert.match(html, /2026-11-04 至 2026-11-10/);
  assert.deepEqual(entries, original);
});

test('keeps actual zeros distinct from absent or invalid activity measurements', () => {
  const html = renderDailyActivity(state([
    activity('2026-11-10', { steps: 0, active_energy_kcal: 0, apple_exercise_minutes: 0, walking_distance_km: 0, resting_energy_kcal: 0 }),
    activity('2026-11-09', { steps: null, active_energy_kcal: '0', apple_exercise_minutes: -1, walking_distance_km: NaN, resting_energy_kcal: Infinity }),
  ]));
  assert.deepEqual(rows(html).map(row => cells(row).slice(1, 6)), [
    ['0', '0', '0', '0', '0'],
    ['—', '—', '—', '—', '—'],
  ]);
  assert.doesNotMatch(html, /NaN|Infinity/);
});

test('escapes source labels and only exposes delete actions for valid IDs', () => {
  const html = renderDailyActivity(state([
    activity('2026-11-10', { id: 'activity:manual', source: 'manual' }),
    activity('2026-11-09', { id: 'activity:estimate', source: 'estimate' }),
    activity('2026-11-08', { id: '\" onclick=\"alert(1)', source: '<img src=x onerror="alert(1)">&\'' }),
    activity('2026-11-07', { id: 'a'.repeat(161), source: '__proto__' }),
    activity('2026-11-06', { id: '', source: null }),
  ]));
  assert.match(html, /手动记录/);
  assert.match(html, /估算/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;&amp;&#39;/);
  assert.match(html, /__proto__/);
  assert.match(html, /来源未标注/);
  assert.deepEqual([...html.matchAll(/data-del="([^"]+)"/g)].map(match => match[1]), ['activity:manual', 'activity:estimate']);
  assert.doesNotMatch(html, /data-edit=|<img|onclick=/);
});

test('provides 7, 30, and 90 day choices and derives an inclusive fallback window', () => {
  const html = renderDailyActivity({ today: '2026-11-10', from: '', entries: [] }, { days: 7 });
  assert.match(html, /2026-11-04 至 2026-11-10/);
  assert.match(html, /0 条记录/);
  assert.match(html, /data-activity-days="7" aria-pressed="true"/);
  assert.match(html, /data-activity-days="30" aria-pressed="false"/);
  assert.match(html, /data-activity-days="90" aria-pressed="false"/);
  assert.match(html, /暂无.*活动记录/);
  const defaultHtml = renderDailyActivity({ today: '2026-11-10', entries: [] });
  assert.match(defaultHtml, /2026-10-12 至 2026-11-10/);
  assert.throws(() => renderDailyActivity({ ...state([]), from: '2026-02-30' }), /有效日期范围/);
  assert.throws(() => renderDailyActivity({ ...state([]), from: '2026-11-11' }), /有效日期范围/);
});

test('renderer works from its source alone with an isolated browser global context', () => {
  const isolated = vm.runInNewContext('(' + renderDailyActivity.toString() + ')');
  const html = isolated(state([activity('2026-11-10', { steps: 3000 })]), { days: 90 });
  assert.equal(rows(html).length, 1);
  assert.deepEqual(cells(rows(html)[0]).slice(0, 3), ['2026-11-10', '3,000', '—']);
  assert.match(html, /Apple 健康导入/);
  assert.match(html, /data-activity-days="90" aria-pressed="true"/);
});
