// Keep every helper inside the export: the worker embeds this function in the page.
export function renderDailyAnalysis(report, { today, availableDays = [] } = {}) {
  const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const validDay = day => typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) && day >= '0001-01-01' && Number.isFinite(Date.parse(day)) && new Date(day).toISOString().slice(0, 10) === day;
  const day = report?.day;
  const currentDay = today === undefined ? day : today;
  if (!validDay(day) || !validDay(currentDay) || day > currentDay) throw Error('请选择有效的解析日期。');
  const known = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const integer = value => Number.isSafeInteger(value) && value >= 0;
  const number = value => value.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  const format = (value, unit = '') => known(value) ? number(value) + (unit ? ' ' + escape(unit) : '') : '—';
  const textList = values => Array.isArray(values) ? values.filter(value => typeof value === 'string' && value.trim()) : [];
  const list = values => '<ul>' + values.map(value => '<li>' + escape(value) + '</li>').join('') + '</ul>';
  const defaults = [
    ['nutrition', '饮食与营养', '补记食物、份量和用餐时间，让营养记录更完整。'],
    ['sleep', '睡眠', '导入睡眠记录，或补记入睡、起床时间和时长。'],
    ['exercise', '运动训练', '有训练时补记项目和时长，便于回看具体训练。'],
    ['activity', '日常活动', '导入包含步数与活动能量的健康记录。'],
    ['weight', '体重', '有测量时记录体重，并尽量保持相近的测量条件。'],
    ['vitals', '常用身体指标', '导入已有的身体指标记录，再按同一指标连续回看。'],
  ];
  const sections = Array.isArray(report?.sections) ? report.sections.filter(item => item && typeof item === 'object') : [];
  const sourceName = source => {
    const names = { device: 'Apple 健康导入', manual: '手动记录', estimate: '估算', mixed: '包含多种来源' };
    return Object.hasOwn(names, source) ? names[source] : source;
  };
  const baselineHtml = metric => {
    const baseline = metric.baseline;
    if (!known(metric.value) || !baseline || !known(baseline.value) || !integer(baseline.days) || !integer(baseline.windowDays) || baseline.days < 3 || baseline.days > baseline.windowDays || baseline.windowDays > 366) return '';
    const period = validDay(baseline.from) && validDay(baseline.to) && baseline.from <= baseline.to && baseline.to < day ? '<small>' + escape(baseline.from) + ' 至 ' + escape(baseline.to) + '</small>' : '';
    const delta = typeof baseline.delta === 'number' && Number.isFinite(baseline.delta) ? '<small>较参考均值 ' + (baseline.delta > 0 ? '+' : '') + number(baseline.delta) + (metric.unit ? ' ' + escape(metric.unit) : '') + '</small>' : '';
    return '<small class="analysis-baseline">前 ' + baseline.windowDays + ' 天有记录日均值 ' + format(baseline.value, metric.unit) + (baseline.estimated === true ? '（含估算）' : '') + ' · 覆盖 ' + baseline.days + ' / ' + baseline.windowDays + ' 天</small>' + period + delta;
  };
  const metricHtml = metric => {
    if (!metric || typeof metric !== 'object') return '';
    const coverage = metric.coverage;
    const coverageHtml = coverage && integer(coverage.known) && integer(coverage.total) && coverage.total > 0 && coverage.known <= coverage.total ? '<small>数值覆盖 ' + coverage.known + ' / ' + coverage.total + ' 条记录</small>' : '';
    const source = typeof metric.source === 'string' && metric.source ? '<small>' + escape(sourceName(metric.source)) + '</small>' : '';
    const estimated = metric.estimated === true && known(metric.value) ? '<span class="analysis-estimate">含估算</span>' : '';
    return '<div class="analysis-metric" data-analysis-metric="' + escape(metric.key) + '"><span class="analysis-metric-label">' + escape(metric.label || '记录数值') + '</span><strong>' + format(metric.value, metric.unit) + '</strong>' + estimated + source + coverageHtml + baselineHtml(metric) + '</div>';
  };
  const sectionHtml = ([key, title, suggestion]) => {
    const item = sections.find(section => section.key === key) ?? {};
    const status = ['recorded', 'partial', 'missing'].includes(item.status) ? item.status : 'missing';
    const statusText = { recorded: '已有记录', partial: '记录不完整', missing: '暂无记录' }[status];
    const metrics = (Array.isArray(item.metrics) ? item.metrics : []).map(metricHtml).join('');
    const facts = textList(item.facts);
    const interpretation = textList(item.interpretation);
    const suggestions = textList(item.suggestions);
    return '<article class="analysis-section" data-analysis-section="' + escape(key) + '"><div class="analysis-section-heading"><h3>' + escape(item.title || title) + '</h3><span class="analysis-status analysis-status-' + status + '">' + statusText + '</span></div>' + (metrics ? '<div class="analysis-metrics">' + metrics + '</div>' : '') + '<div class="analysis-copy"><h4>记录情况</h4>' + list(facts.length ? facts : [status === 'missing' ? '当天暂无这类记录，空白不表示 0。' : '依据当天已保存的记录，未提供的数值保持未知。']) + (interpretation.length ? '<h4>如何理解</h4>' + list(interpretation) : '') + '<h4>可以这样做</h4>' + list(suggestions.length ? suggestions : [suggestion]) + '</div></article>';
  };
  const count = integer(report?.recordCount) ? '当日 ' + report.recordCount + ' 条记录' : '当日记录数未提供';
  const latestDay = validDay(report?.latestDataDay) && report.latestDataDay <= currentDay ? report.latestDataDay : null;
  const latest = latestDay ? '最近有记录的日期：' + escape(latestDay) + '。本页依据已上传或补记的数据；Apple 健康新增记录需要再次导入。' : '尚无可用的已保存记录。导入健康文件或补记后，可查看对应日期的解析。';
  const recentDays = [...new Set((Array.isArray(availableDays) ? availableDays : []).filter(value => validDay(value) && value <= currentDay))].sort().reverse().slice(0, 14);
  const chips = recentDays.length ? '<div class="analysis-dates" role="group" aria-label="最近有记录的日期"><span>有记录的日期</span>' + recentDays.map(value => '<button type="button" data-analysis-date="' + escape(value) + '" aria-pressed="' + (value === day) + '">' + escape(value) + '</button>').join('') + '</div>' : '';
  const summary = report?.summary && typeof report.summary === 'object' ? report.summary : {};
  const summaryText = typeof summary.text === 'string' && summary.text.trim() ? summary.text : '先补齐当天记录，再结合连续几天的变化回看。';
  const suppliedPriorities = Array.isArray(summary.priorities) ? summary.priorities.filter(item => item && typeof item.title === 'string' && item.title.trim() && typeof item.detail === 'string' && item.detail.trim()).slice(0, 3) : [];
  const priorities = suppliedPriorities.length ? suppliedPriorities : [
    { title: '导入已有记录', detail: '选择包含这一天的健康文件，让解析有实际记录可依据。' },
    { title: '补齐当天信息', detail: '补记饮食份量、训练或睡眠；未知数值可以留空。' },
    { title: '连续记录后再回看', detail: '保留连续几天的记录，逐步建立自己的比较参考。' },
  ];
  const limitations = textList(summary.limitations);
  const styles = '<style>.analysis-panel{width:100%;min-width:0;color:var(--ink,#173f35)}.analysis-panel *{box-sizing:border-box}.analysis-header,.analysis-section,.analysis-priorities{background:#fff;border:1px solid var(--line,#dce5dc);border-radius:16px;padding:20px;min-width:0}.analysis-heading,.analysis-section-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.analysis-heading h2{margin:0;font-size:22px}.analysis-day{margin:7px 0 0;font-size:14px;color:var(--muted,#50645b)}.analysis-count,.analysis-status{border-radius:20px;padding:5px 10px;background:#edf4e7;color:#3f604b;font-size:12px;white-space:nowrap}.analysis-status-partial{background:#f4f2e4;color:#655e37}.analysis-status-missing{background:#f0f3ee;color:#607164}.analysis-intro,.analysis-latest,.analysis-summary,.analysis-legend,.analysis-limitations{line-height:1.75;font-size:13px;color:var(--muted,#50645b)}.analysis-intro{margin:17px 0 4px}.analysis-latest{margin:4px 0 18px}.analysis-help{color:#237b62;text-underline-offset:3px;white-space:nowrap}.analysis-help:focus-visible{outline:2px solid #237b62;outline-offset:3px}.analysis-controls{display:flex;align-items:flex-end;gap:9px;flex-wrap:wrap}.analysis-controls label{display:grid;gap:5px;font-size:12px;color:var(--muted,#50645b)}.analysis-controls input{font:inherit;font-size:14px;width:178px;border:1px solid #bdcdc0;background:white;color:var(--ink,#173f35);border-radius:8px;padding:8px}.analysis-panel button{font:inherit;font-size:13px;border:1px solid var(--line,#dce5dc);background:#fff;border-radius:9px;color:var(--ink,#173f35);padding:8px 12px;cursor:pointer}.analysis-panel button[aria-pressed=true]{background:#1c5947;color:white;border-color:#1c5947}.analysis-panel button:disabled{opacity:.45;cursor:default}.analysis-panel button:focus-visible,.analysis-controls input:focus-visible{outline:2px solid #237b62;outline-offset:3px}.analysis-dates{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-top:16px}.analysis-dates>span{font-size:12px;color:var(--muted,#50645b);margin-right:2px}.analysis-dates button{font-size:12px;padding:6px 9px}.analysis-summary{margin:18px 0 3px;font-size:14px;color:var(--ink,#173f35)}.analysis-legend{margin:0 0 16px}.analysis-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;align-items:start}.analysis-section[data-analysis-section=nutrition],.analysis-section[data-analysis-section=vitals]{grid-column:1/-1}.analysis-section[data-analysis-section=nutrition] .analysis-metrics,.analysis-section[data-analysis-section=vitals] .analysis-metrics{grid-template-columns:repeat(4,minmax(0,1fr))}.analysis-section-heading h3{font-size:17px;margin:0}.analysis-metrics{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-top:16px}.analysis-metric{display:flex;flex-direction:column;align-items:flex-start;gap:6px;background:#f5f8f1;border-radius:11px;padding:12px;min-width:0;overflow-wrap:anywhere}.analysis-metric-label{font-size:12px;color:var(--muted,#50645b)}.analysis-metric strong{font-size:21px;line-height:1.35;font-weight:650}.analysis-metric small{display:block;font-size:11px;line-height:1.6;color:var(--muted,#50645b)}.analysis-baseline{border-top:1px solid #e0e9dc;padding-top:7px;margin-top:2px;width:100%}.analysis-estimate{font-size:11px;background:#fff1d4;color:#6b5d39;border-radius:20px;padding:2px 7px}.analysis-copy{font-size:13px;line-height:1.8;overflow-wrap:anywhere}.analysis-copy h4{font-size:12px;color:var(--muted,#50645b);margin:18px 0 6px;font-weight:650}.analysis-copy ul{padding-left:18px;margin:0}.analysis-copy li+li{margin-top:5px}.analysis-priorities{margin-top:18px;background:#f9fcf6}.analysis-priorities h3{font-size:18px;margin:0 0 15px}.analysis-priority-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.analysis-priority{background:#fff;border:1px solid #e0e9dc;border-radius:12px;padding:15px;min-width:0;overflow-wrap:anywhere}.analysis-priority-number{display:inline-flex;width:25px;height:25px;border-radius:50%;align-items:center;justify-content:center;background:#e7f0df;color:#2b634c;font-size:12px;margin-bottom:10px}.analysis-priority h4{margin:0;font-size:14px;line-height:1.6}.analysis-priority p{font-size:13px;line-height:1.8;color:var(--muted,#50645b);margin:7px 0 0}.analysis-limitations{margin:16px 3px 0;overflow-wrap:anywhere}@media(max-width:760px){.analysis-grid{grid-template-columns:1fr}.analysis-section[data-analysis-section=nutrition] .analysis-metrics,.analysis-section[data-analysis-section=vitals] .analysis-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.analysis-priority-grid{grid-template-columns:1fr}.analysis-header,.analysis-section,.analysis-priorities{padding:16px}}@media(max-width:420px){.analysis-controls{gap:7px}.analysis-controls label{width:100%}.analysis-controls input{width:100%}.analysis-controls button{flex:1}.analysis-metric{padding:10px}.analysis-metric strong{font-size:19px}.analysis-heading{align-items:flex-start}}</style>';
  return '<section class="analysis-panel">' + styles + '<div class="analysis-header"><div class="analysis-heading"><div><h2>每日解析</h2><p class="analysis-day">' + escape(day) + ' 的记录解析</p></div><span class="analysis-count">' + escape(count) + '</span></div><p class="analysis-intro">基于已保存记录的规则解析，导入或补记后会重新计算。</p><p class="analysis-latest">' + latest + ' <a class="analysis-help" href="/daily-analysis/help">了解解析依据</a></p><div class="analysis-controls" role="group" aria-label="选择解析日期"><label for="analysis-date">查看日期<input type="date" id="analysis-date" value="' + escape(day) + '" max="' + escape(currentDay) + '" min="0001-01-01"></label><button type="button" data-analysis-offset="-1"' + (day === '0001-01-01' ? ' disabled' : '') + '>前一天</button><button type="button" data-analysis-offset="1"' + (day >= currentDay ? ' disabled' : '') + '>后一天</button><button type="button" data-analysis-today="true"' + (day === currentDay ? ' disabled' : '') + '>今天</button><button type="button" data-analysis-latest="true"' + (!latestDay ? ' disabled' : '') + '>最新记录</button></div>' + chips + '</div><p class="analysis-summary">' + escape(summaryText) + '</p><p class="analysis-legend">— 表示未记录或未知，已记录的 0 会保留；含估算的数值会单独标注。</p><div class="analysis-grid">' + defaults.map(sectionHtml).join('') + '</div><section class="analysis-priorities"><h3>优先建议</h3><div class="analysis-priority-grid">' + priorities.map((item, index) => '<div class="analysis-priority"><span class="analysis-priority-number" aria-hidden="true">' + (index + 1) + '</span><h4>' + escape(item.title) + '</h4><p>' + escape(item.detail) + '</p></div>').join('') + '</div></section>' + (limitations.length ? '<p class="analysis-limitations">' + limitations.map(escape).join(' ') + '</p>' : '') + '</section>';
}
