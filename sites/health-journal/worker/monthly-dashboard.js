// Keep all helpers inside the export: the worker embeds this function in the page.
export function renderMonthDashboard(state, { from, to, title = '月度记录' }) {
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const validDay = day => typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(Date.parse(day)) && new Date(day).toISOString().slice(0, 10) === day;
  if (!validDay(from) || !validDay(to) || from > to) throw Error('请选择有效日期范围。');
  const known = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const format = (value, unit = '', precision = 1) => known(value) ? value.toLocaleString('zh-CN', { maximumFractionDigits: precision }) + (unit ? ' ' + unit : '') : '—';
  const isDevice = row => row.source === 'device' || String(row.id ?? '').startsWith('apple:');
  const source = row => escape(({ device: 'Apple 健康导入', estimate: '估算', manual: '手动记录' })[row.source] ?? row.source ?? (isDevice(row) ? 'Apple 健康导入' : '来源未标注'));
  const actions = row => {
    if (typeof row.id !== 'string' || !/^[-a-zA-Z0-9_:]{1,160}$/.test(row.id)) return '';
    const id = escape(row.id);
    const editable = !isDevice(row) && ['meal', 'workout', 'sleep', 'weight'].includes(row.kind);
    return '<span class="month-actions">' + (editable ? '<button type="button" data-edit="' + id + '">编辑</button>' : '') + '<button type="button" data-del="' + id + '">删除</button></span>';
  };
  const empty = message => '<p class="empty">' + escape(message) + '</p>';
  const sum = (rows, key) => {
    const values = rows.map(row => row[key]).filter(known);
    return values.length ? values.reduce((a, b) => a + b, 0) : null;
  };
  const pickValue = (rows, key) => {
    const preferred = rows.find(row => isDevice(row) && known(row[key]));
    return preferred ? preferred[key] : (rows.find(row => known(row[key]))?.[key] ?? null);
  };
  const mean = values => {
    const present = values.filter(known);
    return { value: present.length ? present.reduce((a, b) => a + b, 0) / present.length : null, count: present.length };
  };
  const selected = (Array.isArray(state?.entries) ? state.entries : []).filter(row => row && validDay(row.day) && row.day >= from && row.day <= to);
  const days = [];
  for (let timestamp = Date.parse(from); timestamp <= Date.parse(to); timestamp += 86400000) days.push(new Date(timestamp).toISOString().slice(0, 10));
  const nutritionFields = [['kcal', '热量', 'kcal'], ['protein', '蛋白质', 'g'], ['fat', '脂肪', 'g'], ['carbs', '碳水', 'g'], ['fiber', '膳食纤维', 'g'], ['sugar', '糖', 'g'], ['sodium_mg', '钠', 'mg'], ['water_ml', '饮水', 'ml']];
  const activityFields = [['steps', '步数', '步'], ['active_energy_kcal', '活动能量', 'kcal'], ['apple_exercise_minutes', 'Apple 锻炼圆环', '分钟'], ['walking_distance_km', '步行与跑步距离', 'km'], ['resting_energy_kcal', '静息能量', 'kcal']];
  const vitalFields = [['heart_rate_bpm', '心率', 'bpm'], ['resting_heart_rate_bpm', '静息心率', 'bpm'], ['hrv_ms', '心率变异性 HRV', 'ms'], ['spo2_percent', '血氧', '%'], ['respiratory_rate', '呼吸频率', '次/分钟'], ['body_fat_percent', '体脂率', '%'], ['bmi', 'BMI', '']];
  const daily = days.map(day => {
    const rows = selected.filter(row => row.day === day);
    const meals = rows.filter(row => row.kind === 'meal');
    const healthNutrition = rows.filter(row => row.kind === 'nutrition' && isDevice(row));
    const sleepRows = rows.filter(row => row.kind === 'sleep');
    // read_health returns newest rows first; retain that order within a source.
    const sleep = sleepRows.find(isDevice) ?? sleepRows[0] ?? null;
    const activityRows = rows.filter(row => row.kind === 'activity');
    const vitalsRows = rows.filter(row => row.kind === 'vitals');
    const nutrition = {}, nutritionEstimated = {};
    for (const [key] of nutritionFields) {
      const healthValue = pickValue(healthNutrition, key);
      nutrition[key] = known(healthValue) ? healthValue : sum(meals, key);
      nutritionEstimated[key] = !known(healthValue) && meals.some(row => row.source === 'estimate' && known(row[key]));
    }
    return {
      day, rows, meals, sleep,
      nutrition, nutritionEstimated,
      activity: Object.fromEntries(activityFields.map(([key]) => [key, pickValue(activityRows, key)])),
      vitals: Object.fromEntries(vitalFields.map(([key]) => [key, pickValue(vitalsRows, key)])),
      workouts: rows.filter(row => row.kind === 'workout'),
      hasNutrition: meals.length > 0 || healthNutrition.length > 0,
    };
  });
  const count = days.length;
  const coverage = number => number + ' / ' + count + ' 天';
  const kcal = mean(daily.map(day => day.nutrition.kcal));
  const estimateNote = key => daily.some(day => day.nutritionEstimated[key]) ? ' · 含估算' : '';
  const sleepHours = mean(daily.map(day => known(day.sleep?.minutes) ? day.sleep.minutes / 60 : null));
  const steps = mean(daily.map(day => day.activity.steps));
  const workouts = selected.filter(row => row.kind === 'workout');
  const workoutMinutes = sum(workouts, 'minutes');
  const latestWeight = selected.filter(row => row.kind === 'weight' && known(row.kg)).sort((a, b) => b.day.localeCompare(a.day))[0];
  const recordedDays = daily.filter(day => day.rows.length).length;
  const card = (key, label, value, detail) => '<div class="card metric" data-metric="' + key + '"><span class="muted">' + label + '</span><strong>' + value + '</strong><small>' + detail + '</small></div>';
  const table = (headers, body, label) => '<div class="month-table" role="region" aria-label="' + escape(label) + '" tabindex="0"><table><thead><tr>' + headers.map(header => '<th scope="col">' + escape(header) + '</th>').join('') + '</tr></thead><tbody>' + body + '</tbody></table></div>';
  const tableRow = (day, cells) => '<tr data-day="' + escape(day) + '"><th scope="row">' + escape(day) + '</th>' + cells.map(cell => '<td>' + cell + '</td>').join('') + '</tr>';
  const chart = (values, unit, label) => {
    const present = values.filter(point => known(point.value));
    if (!present.length) return empty('有记录后显示趋势，缺失日不补为 0。');
    const low = Math.min(...present.map(point => point.value)), high = Math.max(...present.map(point => point.value));
    const point = item => [40 + days.indexOf(item.day) / Math.max(1, count - 1) * 520, 125 - (item.value - low) / (high - low || 1) * 82];
    // Break lines at missing days rather than implying observations between them.
    const segments = [];
    let current = [];
    for (const item of values) {
      if (known(item.value)) current.push(item);
      else if (current.length) { segments.push(current); current = []; }
    }
    if (current.length) segments.push(current);
    return '<svg class="chart month-chart" viewBox="0 0 600 165" role="img" aria-label="' + escape(label + '，' + from + ' 至 ' + to) + '"><path d="M40 43H560 M40 84H560 M40 125H560" stroke="#dce5dc" fill="none"/>' + segments.map(segment => '<polyline points="' + segment.map(item => point(item).join(',')).join(' ') + '" fill="none" stroke="#237b62" stroke-width="2.5"/>').join('') + present.map(item => { const [x, y] = point(item); return '<circle cx="' + x + '" cy="' + y + '" r="4" fill="#237b62"><title>' + escape(item.day + ' · ' + format(item.value, unit)) + '</title></circle>'; }).join('') + '<text x="40" y="151">' + escape(from) + '</text><text x="560" y="151" text-anchor="end">' + escape(to) + '</text><text x="40" y="24">' + escape(format(low, unit) + ' – ' + format(high, unit)) + '</text></svg>';
  };
  const nutritionDays = daily.filter(day => day.hasNutrition);
  const nutritionAverages = nutritionFields.map(([key, label, unit]) => {
    const average = mean(daily.map(day => day.nutrition[key]));
    return '<div class="month-stat"><span>' + label + '</span><b>' + format(average.value, unit) + '</b><small>' + coverage(average.count) + estimateNote(key) + '</small></div>';
  }).join('');
  const mealDetails = daily.flatMap(day => day.meals).map(row => '<div class="entry"><div class="row"><b>' + escape(row.label || '饮食记录') + '</b><span class="pill' + (row.source === 'estimate' ? ' estimate' : '') + '">' + source(row) + '</span></div><small>' + escape(row.day) + ' · ' + nutritionFields.filter(([key]) => known(row[key])).map(([key, label, unit]) => label + ' ' + format(row[key], unit)).join(' · ') + (nutritionFields.some(([key]) => known(row[key])) ? '' : '营养数值未填写') + '</small>' + actions(row) + '</div>').join('');
  const nutritionHtml = '<article data-section="nutrition"><div class="section-title"><h3>饮食与营养</h3><span class="pill">已知日平均</span></div><p class="muted">同一天的各项营养，Apple 健康日汇总优先；该项缺失时使用补记饮食合计。两者不会相加，餐名仍保留。平均值只计算该项有数值的日期。</p><div class="month-stats">' + nutritionAverages + '</div>' + (nutritionDays.length ? table(['日期', ...nutritionFields.map(([, label, unit]) => label + (unit ? ' (' + unit + ')' : ''))], nutritionDays.map(day => tableRow(day.day, nutritionFields.map(([key]) => format(day.nutrition[key])))).join(''), '每日营养') : '') + '<h4>饮食记录</h4>' + (mealDetails || empty('健康导出里没有饮食？可点补充记录，写下食物和份量。手表不会自动识别饮食；只有已写入 Apple 健康的营养数据才会导入。')) + '</article>';
  const sleepDays = daily.filter(day => day.sleep);
  const chosenSleeps = new Set(sleepDays.map(day => day.sleep));
  const otherSleeps = selected.filter(row => row.kind === 'sleep' && !chosenSleeps.has(row));
  const otherSleepHtml = otherSleeps.length ? '<details class="month-other-sleep"><summary>其他睡眠记录 · ' + otherSleeps.length + ' 条</summary><p class="muted">以下记录未计入每日汇总，可在这里修改或删除。</p>' + otherSleeps.map(row => '<div class="entry"><div class="row"><b>' + escape(row.day) + ' · ' + escape(row.label || '睡眠') + '</b><span>' + format(known(row.minutes) ? row.minutes / 60 : null, '小时') + '</span></div><small>' + escape(row.bed || '—') + ' → ' + escape(row.wake || '—') + ' · ' + source(row) + '</small>' + actions(row) + '</div>').join('') + '</details>' : '';
  const sleepHtml = '<article data-section="sleep"><div class="section-title"><h3>睡眠趋势</h3><span class="pill">' + coverage(sleepHours.count) + '</span></div><p class="month-lead">有记录日平均 <strong>' + format(sleepHours.value, '小时') + '</strong></p>' + chart(daily.map(day => ({ day: day.day, value: known(day.sleep?.minutes) ? day.sleep.minutes / 60 : null })), '小时', '每日睡眠时长') + '<p class="muted">按起床日归档；同日优先采用设备记录，其余使用最近一次补记，每天只计一次。</p>' + (sleepDays.length ? table(['起床日', '时长 (小时)', '入睡', '起床', '来源', '操作'], sleepDays.map(day => tableRow(day.day, [format(known(day.sleep.minutes) ? day.sleep.minutes / 60 : null), escape(day.sleep.bed || '—'), escape(day.sleep.wake || '—'), source(day.sleep), actions(day.sleep)])).join(''), '睡眠与入睡起床时间') : empty('所选日期暂无睡眠记录。')) + otherSleepHtml + '</article>';
  const byType = new Map();
  for (const workout of workouts) {
    const label = workout.label || '未命名运动';
    if (!byType.has(label)) byType.set(label, []);
    byType.get(label).push(workout);
  }
  const maxWorkoutMinutes = Math.max(1, ...[...byType.values()].map(rows => sum(rows, 'minutes') ?? 0));
  const workoutTypes = [...byType].map(([label, rows]) => '<div class="month-type"><div class="row"><b>' + escape(label) + '</b><span>' + format(sum(rows, 'minutes'), '分钟') + ' · ' + rows.length + ' 次</span></div><div class="month-bar"><span style="width:' + ((sum(rows, 'minutes') ?? 0) / maxWorkoutMinutes * 100) + '%"></span></div></div>').join('');
  const workoutList = [...workouts].sort((a, b) => b.day.localeCompare(a.day)).map(row => '<div class="entry"><div class="row"><b>' + escape(row.label || '运动') + '</b><span>' + format(row.minutes, '分钟') + '</span></div><small>' + escape(row.day) + ' · ' + source(row) + (known(row.kcal) ? ' · ' + format(row.kcal, 'kcal') : '') + '</small>' + actions(row) + '</div>').join('');
  const workoutHtml = '<article data-section="workout"><div class="section-title"><h3>运动记录</h3><span class="pill">' + workouts.length + ' 次</span></div><p class="month-lead">合计 <strong>' + format(workoutMinutes, '分钟') + '</strong></p><small>仅统计具体训练记录；Apple 锻炼圆环分钟在每日活动中单列。</small>' + (workoutTypes ? '<h4>按运动项目</h4>' + workoutTypes + '<h4>训练明细</h4>' + workoutList : empty('所选日期暂无训练记录。')) + '</article>';
  const activityHtml = '<article data-section="activity"><h3>每日活动</h3><p class="muted">活动能量、步数与圆环分钟独立展示，不并入训练时长或饮食摄入。</p><p class="muted">按单一来源汇总，避免手机与手表重复相加；可能与健康 App 的统计不同。体征按最多有效样本的来源取平均。</p><div class="month-activity">' + activityFields.map(([key, label, unit]) => {
    const values = daily.map(day => day.activity[key]), average = mean(values), total = values.filter(known).reduce((a, b) => a + b, 0);
    return '<div class="month-stat"><span>' + label + '</span><b>' + format(average.count ? total : null, unit) + '</b><small>日均 ' + format(average.value, unit) + ' · ' + coverage(average.count) + '</small></div>';
  }).join('') + '</div></article>';
  const vitalsPresent = vitalFields.filter(([key]) => daily.some(day => known(day.vitals[key])));
  const vitalsHtml = vitalsPresent.length ? '<article data-section="vitals"><h3>常用身体指标</h3><p class="muted">按已上传的每日值计算，仅用于回看记录。</p>' + table(['指标', '已知日平均', '最近一次', '最近日期', '覆盖'], vitalsPresent.map(([key, label, unit]) => {
    const average = mean(daily.map(day => day.vitals[key])), latest = [...daily].reverse().find(day => known(day.vitals[key]));
    return '<tr><th scope="row">' + label + '</th><td>' + format(average.value, unit) + '</td><td>' + format(latest.vitals[key], unit) + '</td><td>' + escape(latest.day) + '</td><td>' + coverage(average.count) + '</td></tr>';
  }).join(''), '常用身体指标') + '</article>' : '';
  const weightRows = daily.map(day => ({ day: day.day, value: day.rows.find(row => row.kind === 'weight' && known(row.kg))?.kg ?? null }));
  const weightRecords = selected.filter(row => row.kind === 'weight').sort((a, b) => b.day.localeCompare(a.day));
  const weightHtml = '<article data-section="weight"><h3>体重趋势</h3>' + (latestWeight ? '<p class="month-lead">所选期间最近一次 <strong>' + format(latestWeight.kg, 'kg') + '</strong> <small>' + escape(latestWeight.day) + ' · ' + source(latestWeight) + '</small></p>' : '') + chart(weightRows, 'kg', '每日体重') + (known(state?.goal) ? '<p class="muted">记录的目标体重 ' + format(state.goal, 'kg') + '</p>' : '') + (weightRecords.length ? table(['日期', '体重 (kg)', '来源', '操作'], weightRecords.map(row => tableRow(row.day, [format(row.kg), source(row), actions(row)])).join(''), '体重记录') : '') + '</article>';
  const dailyHtml = '<article data-section="daily"><h3>每日记录一览</h3><p class="muted">— 表示未知；有数值的 0 会保留。饮食和活动能量分别统计。</p>' + table(['日期', '饮食 (kcal)', '睡眠 (小时)', '训练 (分钟)', '步数'], daily.map(day => tableRow(day.day, [format(day.nutrition.kcal), format(known(day.sleep?.minutes) ? day.sleep.minutes / 60 : null), format(sum(day.workouts, 'minutes')), format(day.activity.steps)])).join(''), '每日饮食睡眠运动与步数') + '</article>';
  const styles = '<style>.month-other-sleep{margin-top:18px}.month-other-sleep summary{cursor:pointer;font-weight:600}.month-actions{display:inline-flex;gap:6px}.month-actions button{font-size:12px;padding:5px 9px}.month-dashboard .entry .month-actions{margin-top:9px}.month-dashboard h4{margin:23px 0 10px;font-size:14px}.month-dashboard h3{margin:0}.month-dashboard article{min-width:0}.month-dashboard .section-title{margin-bottom:12px}.month-dashboard>.metrics{grid-template-columns:repeat(5,minmax(0,1fr))}.month-dashboard .metric strong{font-size:23px}.month-stats,.month-activity{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin:16px 0}.month-stat{padding:11px;border-radius:11px;background:#f4f8f0;display:grid;gap:6px;min-width:0}.month-stat span,.month-stat small{font-size:12px;color:var(--muted)}.month-stat b{font-size:17px;color:var(--ink)}.month-activity{grid-template-columns:1fr 1fr}.month-table{max-width:100%;overflow:auto;margin:14px 0 0}.month-table table{width:100%;border-collapse:collapse;white-space:nowrap;font-size:13px}.month-table th,.month-table td{padding:10px 11px;text-align:right;border-bottom:1px solid var(--line)}.month-table th:first-child{text-align:left}.month-table thead th{font-weight:600;background:#f3f7ee;color:var(--muted)}.month-table tbody th{font-weight:500}.month-table tbody tr:last-child>*{border-bottom:0}.month-lead{color:var(--muted);margin:11px 0}.month-lead strong{font-size:23px;color:var(--ink)}.month-chart{height:auto;min-height:140px}.month-chart text{font:11px system-ui;fill:#50645b}.month-type{margin:15px 0}.month-type .row{font-size:14px}.month-bar{height:7px;background:#edf3e7;border-radius:5px;margin-top:7px;overflow:hidden}.month-bar span{height:100%;display:block;background:#448465;border-radius:5px}.month-grid{align-items:start}.month-full{margin:14px 0}.month-dashboard .entry b{overflow-wrap:anywhere}@media(max-width:850px){.month-dashboard>.metrics{grid-template-columns:repeat(3,minmax(0,1fr))}.month-stats{grid-template-columns:repeat(4,minmax(0,1fr))}}@media(max-width:650px){.month-dashboard>.metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.month-stats{grid-template-columns:repeat(2,minmax(0,1fr))}.month-dashboard .metric strong{font-size:22px}.month-table th,.month-table td{padding:9px 8px}}</style>';
  return styles + '<div class="month-dashboard"><div class="section-title"><div><h2>' + escape(title) + '</h2><p class="muted">' + escape(from) + ' 至 ' + escape(to) + ' · 北京时间</p></div><span class="pill">已有记录 ' + coverage(recordedDays) + '</span></div><div class="metrics">' + card('kcal', '日均饮食摄入', format(kcal.value, 'kcal'), '热量覆盖 ' + coverage(kcal.count) + estimateNote('kcal')) + card('sleep', '日均睡眠', format(sleepHours.value, '小时'), '睡眠覆盖 ' + coverage(sleepHours.count)) + card('workout', '训练总时长', format(workoutMinutes, '分钟'), workouts.length + ' 次训练 · ' + coverage(daily.filter(day => day.workouts.length).length)) + card('steps', '日均步数', format(steps.value, '步'), '步数覆盖 ' + coverage(steps.count)) + card('weight', '期间最新体重', format(latestWeight?.kg, 'kg'), latestWeight ? escape(latestWeight.day) : '所选期间暂无记录') + '</div><p class="muted">各项只汇总所选日期的已知数值，缺失日不计为 0；覆盖天数因指标而异。</p><section class="month-full">' + nutritionHtml + '</section><section class="grid month-grid">' + sleepHtml + workoutHtml + activityHtml + weightHtml + '</section>' + (vitalsHtml ? '<section class="month-full">' + vitalsHtml + '</section>' : '') + '<section class="month-full">' + dailyHtml + '</section></div>';
}
