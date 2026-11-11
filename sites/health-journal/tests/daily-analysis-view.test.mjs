import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { renderDailyAnalysis } from '../worker/daily-analysis-view.js';

const section = (key, fields = {}) => ({ key, title: key, status: 'recorded', facts: [], interpretation: [], suggestions: [], metrics: [], ...fields });
const report = fields => ({
  day: '2026-11-09', latestDataDay: '2026-11-09', recordCount: 3,
  sections: [], summary: { text: '根据这一天已保存的记录回看。', priorities: [{ title: '补齐饮食', detail: '记下晚餐的份量。' }], limitations: [] },
  ...fields,
});
const options = { today: '2026-11-11' };
const getSection = (html, key) => {
  const match = html.match(new RegExp('<article[^>]*data-analysis-section="' + key + '"[^>]*>([\\s\\S]*?)<\\/article>'));
  assert.ok(match, 'renders section ' + key);
  return match[1];
};
const getMetric = (html, key) => {
  const match = html.match(new RegExp('<div[^>]*data-analysis-metric="' + key + '"[^>]*>([\\s\\S]*?)<\\/div>'));
  assert.ok(match, 'renders metric ' + key);
  return match[1].replace(/<[^>]*>/g, ' ');
};

test('analysis keeps the actual report date and exposes safe date navigation for every saved day', () => {
  const html = renderDailyAnalysis(report({}), {
    today: '2026-11-11',
    availableDays: ['2026-11-08', '2026-11-09', '2026-11-08', '2026-02-30', '2026-11-12', '"><svg onload=alert(1)>'],
  });
  assert.match(html, /每日解析/);
  assert.match(html, /<input[^>]*type="date"[^>]*id="analysis-date"[^>]*value="2026-11-09"[^>]*max="2026-11-11"/);
  assert.match(html, /data-analysis-offset="-1"/);
  assert.match(html, /data-analysis-offset="1"/);
  assert.match(html, /data-analysis-today="true"/);
  assert.match(html, /data-analysis-latest="true"/);
  assert.match(html, /href="\/daily-analysis\/help"/);
  assert.equal((html.match(/data-analysis-date="2026-11-08"/g) ?? []).length, 1);
  assert.ok(html.indexOf('data-analysis-date="2026-11-09"') < html.indexOf('data-analysis-date="2026-11-08"'));
  assert.doesNotMatch(html, /data-analysis-date="2026-02-30"|data-analysis-date="2026-11-12"|<svg/);
  assert.match(html, /最近有记录的日期[\s\S]*2026-11-09/);
  assert.match(html, /已上传|已保存/);
  assert.match(html, /导入或补记后会重新计算/);
  assert.doesNotMatch(html, /今日已完成|实时同步|健康评分/);
});

test('same-day navigation cannot advance beyond today and date validation rejects malformed controls', () => {
  const html = renderDailyAnalysis(report({ day: '2026-11-11' }), options);
  assert.match(html, /<button[^>]*data-analysis-offset="1"[^>]*disabled/);
  for (const day of ['2026-02-30', '0000-01-01', '2026-11-12', '\"><img src=x>']) {
    assert.throws(() => renderDailyAnalysis(report({ day }), options), /日期/);
  }
  assert.throws(() => renderDailyAnalysis(report({}), { today: '2026-02-30' }), /日期/);
});

test('empty reports preserve all daily sections and suggest filling record coverage without inventing values', () => {
  const html = renderDailyAnalysis(report({ recordCount: 0, latestDataDay: null, summary: { text: '', priorities: [], limitations: [] } }), options);
  for (const key of ['nutrition', 'sleep', 'exercise', 'activity', 'weight', 'vitals']) {
    assert.match(getSection(html, key), /暂无记录/);
  }
  assert.match(html, /当日 0 条记录/);
  assert.match(html, /优先建议/);
  assert.match(html, /导入|补记/);
  assert.doesNotMatch(html, /NaN|undefined|已达标|完成率|健康评分/);
  assert.equal((html.match(/class="analysis-priority"/g) ?? []).length, 3);
});

test('partial metrics distinguish actual zeros, unknown fields, estimates, and source coverage', () => {
  const html = renderDailyAnalysis(report({ sections: [section('nutrition', {
    title: '饮食与营养', status: 'partial',
    facts: ['早餐来自手动记录，热量由份量估算。'], interpretation: ['缺失项不能代表全天摄入。'], suggestions: ['补记晚餐份量。'],
    metrics: [
      { key: 'kcal', label: '饮食热量', value: 0, unit: 'kcal', source: 'device' },
      { key: 'protein', label: '蛋白质', value: null, unit: 'g' },
      { key: 'fat', label: '脂肪', value: 12.5, unit: 'g', estimated: true, source: 'manual', coverage: { known: 1, total: 2, missing: 1 } },
      { key: 'carbs', label: '碳水', value: NaN, unit: 'g' },
    ],
  })] }), options);
  assert.match(getSection(html, 'nutrition'), /记录不完整/);
  assert.match(getMetric(html, 'kcal'), /0\s*kcal/);
  assert.match(getMetric(html, 'kcal'), /Apple 健康导入/);
  assert.match(getMetric(html, 'protein'), /—/);
  assert.doesNotMatch(getMetric(html, 'protein'), /0\s*g/);
  assert.match(getMetric(html, 'fat'), /12\.5\s*g/);
  assert.match(getMetric(html, 'fat'), /估算/);
  assert.match(getMetric(html, 'fat'), /手动记录/);
  assert.match(getMetric(html, 'fat'), /1\s*\/\s*2 条记录/);
  assert.match(getMetric(html, 'carbs'), /—/);
  assert.doesNotMatch(html, /NaN/);
  assert.ok(html.indexOf('早餐来自手动记录') < html.indexOf('缺失项不能代表全天摄入'));
  assert.ok(html.indexOf('缺失项不能代表全天摄入') < html.indexOf('补记晚餐份量'));
});

test('personal baselines disclose known-day coverage and never turn sparse or missing values into comparisons', () => {
  const html = renderDailyAnalysis(report({ sections: [section('sleep', { metrics: [
    { key: 'sleep', label: '睡眠时长', value: 7.5, unit: '小时', baseline: { value: 7, days: 3, windowDays: 7, delta: 0.5, estimated: true, from: '2026-11-02', to: '2026-11-08' } },
    { key: 'sparse', label: '稀疏记录', value: 6, unit: '小时', baseline: { value: 8, days: 2, windowDays: 7, delta: -2 } },
    { key: 'missing', label: '缺失记录', value: null, unit: '小时', baseline: { value: 8, days: 7, windowDays: 7, delta: NaN } },
  ] })] }), options);
  const enough = getMetric(html, 'sleep');
  assert.match(enough, /前 7 天.*均值[\s\S]*7\s*小时/);
  assert.match(enough, /3\s*\/\s*7 天/);
  assert.match(enough, /2026-11-02 至 2026-11-08/);
  assert.match(enough, /\+0\.5\s*小时/);
  assert.match(enough, /均值[\s\S]*含估算/);
  assert.doesNotMatch(getMetric(html, 'sparse'), /均值|参考/);
  assert.doesNotMatch(getMetric(html, 'missing'), /均值|参考|NaN/);
});

test('all report text and attribute keys are escaped, including source names and final suggestions', () => {
  const attack = '\"><img src=x onerror=alert(1)><script>alert(2)</script>&\'';
  const html = renderDailyAnalysis(report({
    sections: [section('nutrition', { title: attack, facts: [attack], interpretation: [attack], suggestions: [attack], metrics: [{ key: attack, label: attack, value: 1, unit: attack, source: attack }] })],
    summary: { text: attack, priorities: [{ title: attack, detail: attack }], limitations: [attack] },
  }), options);
  assert.doesNotMatch(html, /<img|<script| onerror="|data-analysis-metric=""><img/);
  assert.deepEqual(html.match(/href="[^"]*"/g), ['href="/daily-analysis/help"']);
  assert.match(html, /&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&amp;&#39;/);
  assert.ok(html.indexOf('优先建议') > html.indexOf('data-analysis-section="vitals"'));
});

test('unrecognized source names remain literal even when they match object prototype properties', () => {
  const html = renderDailyAnalysis(report({ sections: [section('vitals', { metrics: [
    { key: 'first', label: '第一项', value: 1, source: '__proto__' },
    { key: 'second', label: '第二项', value: 2, source: 'constructor' },
  ] })] }), options);
  assert.match(getMetric(html, 'first'), /__proto__/);
  assert.match(getMetric(html, 'second'), /constructor/);
  assert.doesNotMatch(html, /\[object Object\]|function Object/);
});

test('the embedded function runs without module helpers and does not mutate the report', () => {
  const input = report({ sections: [section('weight', { metrics: [{ key: 'weight', label: '体重', value: 72.3, unit: 'kg' }] })] });
  const before = structuredClone(input);
  const context = vm.createContext({ input, options });
  const html = vm.runInContext('(' + renderDailyAnalysis.toString() + ')(input, options)', context);
  assert.match(html, /72\.3/);
  assert.match(html, /每日解析/);
  assert.deepEqual(input, before);
});
