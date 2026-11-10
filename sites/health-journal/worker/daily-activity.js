// Keep helpers inside this function: the worker embeds its source in the page.
export function renderDailyActivity(state, { days = 30 } = {}) {
  const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const validDay = day => typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(Date.parse(day)) && new Date(day).toISOString().slice(0, 10) === day;
  const selectedDays = [7, 30, 90].includes(days) ? days : 30;
  const to = state?.to || state?.today;
  if (!validDay(to)) throw Error('请选择有效日期范围。');
  const from = state?.from || new Date(Date.parse(to) - (selectedDays - 1) * 86400000).toISOString().slice(0, 10);
  if (!validDay(from) || from > to) throw Error('请选择有效日期范围。');
  const fields = [
    ['steps', '步数', 0],
    ['active_energy_kcal', '活动能量 (kcal)', 1],
    ['apple_exercise_minutes', 'Apple 锻炼时间 (min)', 1],
    ['walking_distance_km', '步行跑步距离 (km)', 3],
    ['resting_energy_kcal', '静息能量 (kcal)', 1],
  ];
  const format = (value, precision) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value.toLocaleString('zh-CN', { maximumFractionDigits: precision }) : '—';
  const source = row => {
    if (row.source === 'device') return 'Apple 健康导入';
    if (row.source === 'manual') return '手动记录';
    if (row.source === 'estimate') return '估算';
    return escape(row.source || '来源未标注');
  };
  const actions = row => typeof row.id === 'string' && /^[-a-zA-Z0-9_:]{1,160}$/.test(row.id) ? '<button type="button" class="activity-delete" data-del="' + escape(row.id) + '">删除</button>' : '';
  const records = (Array.isArray(state?.entries) ? state.entries : [])
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row?.kind === 'activity' && validDay(row.day) && row.day >= from && row.day <= to)
    .sort((a, b) => {
      if (a.row.day !== b.row.day) return a.row.day < b.row.day ? 1 : -1;
      const aId = String(a.row.id ?? ''), bId = String(b.row.id ?? '');
      return aId === bId ? a.index - b.index : aId < bId ? -1 : 1;
    })
    .map(({ row }) => row);
  const controls = [7, 30, 90].map(range => '<button type="button" data-activity-days="' + range + '" aria-pressed="' + (selectedDays === range) + '">最近 ' + range + ' 天</button>').join('');
  const table = records.length ? '<div class="activity-table" role="region" aria-label="每日活动记录，可横向滚动查看完整数据" tabindex="0"><table><thead><tr><th scope="col">日期</th>' + fields.map(([, label]) => '<th scope="col">' + label + '</th>').join('') + '<th scope="col">来源</th><th scope="col">操作</th></tr></thead><tbody>' + records.map(row => '<tr data-day="' + escape(row.day) + '"><th scope="row">' + escape(row.day) + '</th>' + fields.map(([key, , precision]) => '<td>' + format(row[key], precision) + '</td>').join('') + '<td class="activity-source">' + source(row) + '</td><td>' + actions(row) + '</td></tr>').join('') + '</tbody></table></div>' : '<p class="activity-empty">所选日期暂无每日活动记录。导入健康文件后，可在这里逐条查看。</p>';
  const styles = '<style>.activity-panel{width:100%;max-width:100%;min-width:0}.activity-card{width:100%;max-width:100%;min-width:0;box-sizing:border-box;background:#fff;border:1px solid var(--line,#dce5dc);border-radius:16px;padding:20px}.activity-heading{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap}.activity-heading h2{margin:0;font-size:20px;color:var(--ink,#173f35)}.activity-count{margin:8px 0 0;font-size:13px;color:var(--muted,#50645b)}.activity-controls{display:flex;flex-wrap:wrap;gap:7px}.activity-controls button,.activity-delete{font:inherit;border:1px solid var(--line,#dce5dc);background:#fff;border-radius:9px;color:var(--ink,#173f35);padding:8px 12px;cursor:pointer}.activity-controls button[aria-pressed=true]{background:#1c5947;color:#fff;border-color:#1c5947}.activity-note{margin:17px 0 0;line-height:1.7;font-size:13px;color:var(--muted,#50645b)}.activity-table{width:100%;max-width:100%;min-width:0;overflow:auto;margin-top:18px;border:1px solid var(--line,#dce5dc);border-radius:11px}.activity-table:focus-visible{outline:2px solid #237b62;outline-offset:3px}.activity-table table{width:100%;min-width:1100px;table-layout:fixed;border-collapse:separate;border-spacing:0;font-size:13px}.activity-table th,.activity-table td{box-sizing:border-box;padding:12px 10px;text-align:right;vertical-align:middle;border-bottom:1px solid var(--line,#dce5dc);white-space:nowrap}.activity-table thead th{font-weight:600;background:#f3f7ee;color:var(--muted,#50645b)}.activity-table th:first-child{width:118px;text-align:left;position:sticky;left:0;background:#fff;z-index:1}.activity-table thead th:first-child{background:#f3f7ee;z-index:2}.activity-table tbody th{font-weight:500}.activity-table th:nth-child(7){width:170px;text-align:left}.activity-table th:last-child{width:78px}.activity-table .activity-source{text-align:left;white-space:normal;overflow-wrap:anywhere}.activity-table tbody tr:last-child>*{border-bottom:0}.activity-delete{font-size:12px;padding:5px 9px}.activity-empty{padding:20px;margin:18px 0 0;background:#f5f8f2;color:var(--muted,#50645b);border-radius:10px;line-height:1.7}@media(max-width:650px){.activity-card{padding:16px}.activity-heading{align-items:flex-start;gap:14px}.activity-controls{width:100%}.activity-controls button{flex:1;padding:8px 7px}.activity-table th,.activity-table td{padding:11px 9px}}</style>';
  return '<section class="activity-panel">' + styles + '<div class="activity-card"><div class="activity-heading"><div><h2>每日活动</h2><p class="activity-count">' + records.length + ' 条记录 · ' + escape(from) + ' 至 ' + escape(to) + '</p></div><div class="activity-controls" role="group" aria-label="每日活动日期范围">' + controls + '</div></div><p class="activity-note">这里只显示已导入的每日活动条目；每条记录单独保留。— 表示空白或未知，不是 0；已记录的 0 会保留。Apple 锻炼圆环分钟与具体训练的时长不同，不合并计算。导入时按单一来源汇总，来源优先级算法可能与 Apple 健康 App 不同。</p>' + table + '</div></section>';
}
