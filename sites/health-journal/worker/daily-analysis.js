// Keep all helpers inside this export so the worker can inject its source.
export function analyzeHealthDay(state, { day = state?.today } = {}) {
  const validDay = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
  if (!validDay(day) || !validDay(state?.today) || day > state.today) throw Error('请选择有效且不晚于今天的日期。');
  const known = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const format = value => value.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  const isDevice = entry => entry.source === 'device' || String(entry.id ?? '').startsWith('apple:');
  const sourceName = source => ({ device: 'Apple 健康', estimate: '估算记录', manual: '手动记录', mixed: '补记饮食' })[source] ?? '记录';
  const rowSource = entry => isDevice(entry) ? 'device' : entry?.source === 'estimate' ? 'estimate' : 'manual';
  const sum = (entries, key) => {
    const values = entries.map(entry => entry[key]).filter(known);
    return values.length ? values.reduce((total, value) => total + value, 0) : null;
  };
  const atDay = offset => new Date(Date.parse(day + 'T00:00:00Z') + offset * 86400000).toISOString().slice(0, 10);
  const baselineWindow = { from: atDay(-7), to: atDay(-1), windowDays: 7 };
  const nutritionFields = [['kcal', '热量', 'kcal'], ['protein', '蛋白质', 'g'], ['fat', '脂肪', 'g'], ['carbs', '碳水', 'g'], ['fiber', '膳食纤维', 'g'], ['sugar', '糖', 'g'], ['sodium_mg', '钠', 'mg'], ['water_ml', '饮水', 'ml']];
  const activityFields = [['steps', '步数', '步'], ['active_energy_kcal', '活动能量', 'kcal'], ['apple_exercise_minutes', 'Apple 锻炼圆环', '分钟'], ['walking_distance_km', '步行与跑步距离', 'km'], ['resting_energy_kcal', '静息能量', 'kcal']];
  const vitalFields = [['heart_rate_bpm', '平均心率', 'bpm'], ['resting_heart_rate_bpm', '静息心率', 'bpm'], ['hrv_ms', '心率变异性 HRV', 'ms'], ['spo2_percent', '血氧', '%'], ['respiratory_rate', '呼吸频率', '次/分钟'], ['body_fat_percent', '体脂率', '%'], ['bmi', 'BMI', '']];
  const kinds = ['meal', 'nutrition', 'sleep', 'workout', 'activity', 'weight', 'vitals'];
  const entries = (Array.isArray(state?.entries) ? state.entries : []).filter(entry => entry && validDay(entry.day) && entry.day <= state.today && kinds.includes(entry.kind));
  const pick = (rows, key) => rows.find(entry => isDevice(entry) && known(entry[key])) ?? rows.find(entry => known(entry[key])) ?? null;
  const createMetric = ([key, label, unit], value = null, extra = {}) => ({ key, label, value: known(value) ? value : null, unit, estimated: false, ...extra });
  const daily = date => {
    const rows = entries.filter(entry => entry.day === date);
    const meals = rows.filter(entry => entry.kind === 'meal');
    const healthNutrition = rows.filter(entry => entry.kind === 'nutrition' && isDevice(entry));
    const sleepRows = rows.filter(entry => entry.kind === 'sleep');
    // read_health returns newest rows first. Preserve that order within each source.
    const sleep = sleepRows.find(isDevice) ?? sleepRows[0] ?? null;
    const nutrition = nutritionFields.map(field => {
      const [key] = field, health = pick(healthNutrition, key);
      if (health) return createMetric(field, health[key], { source: 'device' });
      const count = meals.filter(entry => known(entry[key])).length;
      return createMetric(field, sum(meals, key), {
        estimated: meals.some(entry => entry.source === 'estimate' && known(entry[key])),
        source: meals.length ? 'mixed' : null,
        coverage: { known: count, total: meals.length, missing: meals.length - count },
      });
    });
    const fromKind = (kind, fields) => fields.map(field => {
      const entry = pick(rows.filter(row => row.kind === kind), field[0]);
      return createMetric(field, entry?.[field[0]], entry ? { source: rowSource(entry), estimated: entry.source === 'estimate' } : {});
    });
    const weight = rows.find(entry => entry.kind === 'weight' && known(entry.kg));
    return {
      rows, meals, nutrition, sleep, sleepCount: sleepRows.length,
      healthNutritionCount: healthNutrition.length,
      workouts: rows.filter(entry => entry.kind === 'workout'),
      activity: fromKind('activity', activityFields), vitals: fromKind('vitals', vitalFields),
      weight: createMetric(['kg', '体重', 'kg'], weight?.kg, weight ? { source: rowSource(weight), estimated: weight.source === 'estimate' } : {}),
      sleepMetric: createMetric(['minutes', '睡眠时长', '分钟'], sleep?.minutes, sleep ? { source: rowSource(sleep), estimated: sleep.source === 'estimate' } : {}),
    };
  };
  const current = daily(day), previous = Array.from({ length: 7 }, (_, index) => daily(atDay(index - 7)));
  const present = metric => known(metric.value);
  const observed = metric => (metric.estimated ? '约 ' : '') + format(metric.value) + (metric.unit ? ' ' + metric.unit : '');
  const baselineValues = getter => previous.map(getter).filter(metric => metric && present(metric));
  const attachBaseline = (metric, getter) => {
    const values = baselineValues(getter);
    if (present(metric) && values.length >= 3) {
      const value = values.reduce((total, item) => total + item.value, 0) / values.length;
      metric.baseline = { value, days: values.length, ...baselineWindow, delta: metric.value - value, estimated: values.some(item => item.estimated) };
    }
    return values.length;
  };
  const compare = (metric, count) => {
    if (!present(metric)) return null;
    if (!metric.baseline) return metric.label + '在此前 7 天有 ' + count + ' / 7 天记录，少于 3 天时暂不作日均比较。';
    const baseline = metric.baseline, difference = Math.abs(baseline.delta);
    const direction = baseline.delta > 0 ? '多 ' : '少 ';
    return metric.label + '：此前 7 天已知日均' + (baseline.estimated ? '约 ' : ' ') + format(baseline.value) + (metric.unit ? ' ' + metric.unit : '') + '（' + baseline.days + ' / 7 天）；当日' + (difference === 0 ? '与该均值相同' : (metric.estimated || baseline.estimated ? '约' : '') + direction + format(difference) + (metric.unit ? ' ' + metric.unit : '')) + '。';
  };
  const sections = [], candidates = [];
  const priority = (score, title, detail, observation = false) => candidates.push({ score, title, detail, observation });
  const makeSection = (key, title, status, metrics) => ({ key, title, status, facts: [], interpretation: [], suggestions: [], metrics });

  const nutritionKnown = current.nutrition.filter(present);
  const nutrition = makeSection('nutrition', '饮食与营养', current.meals.length || current.healthNutritionCount ? (nutritionKnown.length === nutritionFields.length && current.nutrition.every(metric => metric.source === 'device') ? 'recorded' : 'partial') : 'missing', current.nutrition);
  if (current.meals.length) nutrition.facts.push('当日有 ' + current.meals.length + ' 条饮食记录' + (current.meals.some(entry => entry.source === 'estimate') ? '，其中含估算记录' : '') + '。');
  if (current.healthNutritionCount) nutrition.facts.push('Apple 健康日汇总按营养项目优先采用；该项没有健康数值时，才合计补记饮食，不叠加两种来源。');
  for (const metric of nutritionKnown) {
    const coverage = metric.coverage;
    nutrition.facts.push(metric.label + '：' + observed(metric) + '；' + (metric.source === 'device' ? 'Apple 健康已上传日汇总' : '补记饮食中 ' + coverage.known + ' / ' + coverage.total + ' 条有此数值' + (coverage.missing ? '，其余 ' + coverage.missing + ' 条未知' : '')) + (metric.estimated ? '，含估算' : '') + '。');
  }
  if (!nutritionKnown.length) nutrition.facts.push(current.meals.length ? '饮食条目尚无可汇总的营养数值。' : '当日没有已上传的饮食营养数值。');
  nutrition.interpretation.push('已记录摄入不能证明覆盖全天；营养项目缺失表示未知，不能据此判断摄入是否足够。');
  if (current.meals.length && current.nutrition.some(metric => metric.coverage?.missing)) nutrition.interpretation.push('补记合计只包含各项已知数值，部分条目缺少营养字段；不同项目的覆盖条数可能不同。');
  if (nutritionKnown.some(metric => metric.estimated)) nutrition.interpretation.push('含估算的项目用于回顾食物和份量，数值带有不确定性。');
  const kcal = current.nutrition.find(metric => metric.key === 'kcal');
  const nutritionEvidence = present(kcal) ? '当前已记录热量 ' + observed(kcal) + '，' : current.meals.length ? '已有 ' + current.meals.length + ' 条饮食记录，' : nutritionKnown.length ? '已有 ' + nutritionKnown.length + ' 项营养数值（' + nutritionKnown[0].label + ' ' + observed(nutritionKnown[0]) + '），' : '当天尚无饮食营养记录，';
  nutrition.suggestions.push(nutritionEvidence + '可先补齐食物、份量和漏记餐次，再回看蔬菜、主食与蛋白质食物的搭配。');
  if (nutrition.status !== 'recorded') priority(100, '先补齐饮食记录', nutrition.suggestions[0], nutritionKnown.length > 0);
  else priority(35, '结合餐次回看饮食', nutrition.suggestions[0], true);
  sections.push(nutrition);

  const sleepMetric = current.sleepMetric, sleepCount = attachBaseline(sleepMetric, snapshot => snapshot.sleepMetric);
  const sleep = makeSection('sleep', '睡眠', current.sleep ? (present(sleepMetric) ? 'recorded' : 'partial') : 'missing', [sleepMetric]);
  if (present(sleepMetric)) sleep.facts.push('按起床日统计，睡眠' + (sleepMetric.estimated ? '约 ' : ' ') + format(sleepMetric.value / 60) + ' 小时（' + observed(sleepMetric) + '），采用' + sourceName(sleepMetric.source) + '。');
  else sleep.facts.push('当日没有已知睡眠时长。');
  const validTime = value => typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
  if (current.sleep && (validTime(current.sleep.bed) || validTime(current.sleep.wake))) sleep.facts.push('记录的入睡时间 ' + (validTime(current.sleep.bed) ? current.sleep.bed : '未知') + ' → 起床时间 ' + (validTime(current.sleep.wake) ? current.sleep.wake : '未知') + '。');
  if (current.sleepCount > 1) sleep.facts.push('当日共有 ' + current.sleepCount + ' 条睡眠记录；优先设备记录，否则采用最近一次补记，每天只计一次。');
  sleep.interpretation.push(compare(sleepMetric, sleepCount) ?? '缺少当日时长，暂不能与个人此前记录比较。');
  sleep.interpretation.push('时长和钟点用于回看作息；设备识别与补记可能有差异，单日记录不代表睡眠质量。');
  if (sleepMetric.baseline?.delta < 0) {
    sleep.suggestions.push('当日睡眠 ' + observed(sleepMetric) + '，比个人此前已知日均少' + (sleepMetric.estimated || sleepMetric.baseline.estimated ? '约 ' : ' ') + format(Math.abs(sleepMetric.baseline.delta)) + ' 分钟；可为接下来的休息预留时间，并观察后续几天的作息与感受。');
    priority(85, '留意睡眠变化', sleep.suggestions[0], true);
  } else if (present(sleepMetric)) {
    sleep.suggestions.push('已记录睡眠 ' + observed(sleepMetric) + '；可继续记录起床后的感受，尽量维持自己可持续的入睡与起床安排。');
    priority(40, '继续观察作息', sleep.suggestions[0], true);
  } else {
    sleep.suggestions.push('当天睡眠时长未知；可同步设备睡眠，或按起床日补记时长与入睡、起床时间。');
    priority(95, '补齐睡眠记录', sleep.suggestions[0]);
  }
  sections.push(sleep);

  const workouts = current.workouts, knownWorkoutCount = workouts.filter(entry => known(entry.minutes)).length;
  const workoutMinutes = createMetric(['minutes', '训练时长', '分钟'], sum(workouts, 'minutes'), { estimated: workouts.some(entry => entry.source === 'estimate' && known(entry.minutes)), coverage: { known: knownWorkoutCount, total: workouts.length, missing: workouts.length - knownWorkoutCount } });
  const exercise = makeSection('exercise', '具体运动与训练', workouts.length ? (knownWorkoutCount === workouts.length ? 'recorded' : 'partial') : 'missing', [createMetric(['sessions', '训练次数', '次'], workouts.length ? workouts.length : null), workoutMinutes]);
  if (workouts.length) {
    exercise.facts.push('当日有 ' + workouts.length + ' 次具体训练记录；已知时长合计 ' + (present(workoutMinutes) ? observed(workoutMinutes) : '未知') + '（' + knownWorkoutCount + ' / ' + workouts.length + ' 次有时长）' + (workoutMinutes.estimated ? '，含估算' : '') + '。');
    for (const workout of workouts) exercise.facts.push((typeof workout.label === 'string' && workout.label ? workout.label : '未命名运动') + '：' + (known(workout.minutes) ? (workout.source === 'estimate' ? '约 ' : '') + format(workout.minutes) + ' 分钟' : '时长未知') + '。');
  } else exercise.facts.push('当日没有具体训练记录；不能据此认定没有活动。');
  exercise.interpretation.push('仅合计具体训练时长，Apple 锻炼圆环分钟和活动能量在每日活动中单列；时长本身不能说明运动强度。');
  exercise.suggestions.push(workouts.length ? '已有 ' + workouts.length + ' 次训练记录；' + (knownWorkoutCount < workouts.length ? '先补齐缺失时长，再' : '') + '结合项目和身体感受回看训练，按自己平常的能力安排后续活动。' : '若当天做过训练，可补记项目、时长和感受；日常步行仍可在每日活动中查看。');
  if (knownWorkoutCount < workouts.length) priority(80, '补齐训练时长', exercise.suggestions[0]);
  else if (workouts.length) priority(25, '补充运动感受', exercise.suggestions[0], true);
  sections.push(exercise);

  const activityKnown = current.activity.filter(present);
  const activity = makeSection('activity', '每日活动', activityKnown.length ? (activityKnown.length === activityFields.length ? 'recorded' : 'partial') : 'missing', current.activity);
  for (const metric of activityKnown) activity.facts.push(metric.label + '：' + observed(metric) + '，采用' + sourceName(metric.source) + (metric.estimated ? '，含估算' : '') + '。');
  if (!activityKnown.length) activity.facts.push('当日步数、活动能量及圆环等活动数值未上传。');
  const steps = current.activity.find(metric => metric.key === 'steps'), stepCount = attachBaseline(steps, snapshot => snapshot.activity.find(metric => metric.key === 'steps'));
  activity.interpretation.push(compare(steps, stepCount) ?? '当日步数未知，暂不能比较个人活动量。');
  activity.interpretation.push('每日指标按单一来源取已上传日汇总，不叠加手机和手表；活动能量与饮食摄入分别展示。');
  if (steps.baseline?.delta < 0) {
    activity.suggestions.push('当日步数 ' + observed(steps) + '，比此前已知日均少' + (steps.estimated || steps.baseline.estimated ? '约 ' : ' ') + format(Math.abs(steps.baseline.delta)) + ' 步；可先结合当天安排理解变化，若身体感觉适合，再按平常能力散步或伸展。');
    priority(75, '结合安排回看活动量', activity.suggestions[0], true);
  } else if (present(steps)) {
    activity.suggestions.push('已记录步数 ' + observed(steps) + '；可结合通勤、训练和休息安排持续观察，选择自己能舒适完成的日常活动。');
    priority(30, '保持可持续的日常活动', activity.suggestions[0], true);
  } else {
    activity.suggestions.push('当天步数未知；可先检查设备佩戴与同步，已有具体训练时也请保留训练记录。');
    priority(90, '检查活动同步', activity.suggestions[0]);
  }
  sections.push(activity);

  const weightMetric = current.weight, weightCount = attachBaseline(weightMetric, snapshot => snapshot.weight);
  const weight = makeSection('weight', '体重', present(weightMetric) ? 'recorded' : 'missing', [weightMetric]);
  weight.facts.push(present(weightMetric) ? '当日最近一次体重：' + observed(weightMetric) + '，采用' + sourceName(weightMetric.source) + '；同日其他测量不重复计入日均。' : '当日没有体重测量；不以其他日期的体重或自述约值代替。');
  weight.interpretation.push(compare(weightMetric, weightCount) ?? '缺少当日测量，暂不能比较个人此前体重。');
  if (present(weightMetric)) {
    weight.interpretation.push('单日体重会受测量时点、饮食饮水等影响，当前差异不能直接说明身体成分变化。');
    weight.suggestions.push('当日体重 ' + observed(weightMetric) + '；后续尽量在相近时间、相似衣着与同一设备条件下测量，再回看连续记录。');
    priority(weightMetric.baseline?.delta ? 55 : 20, '保持体重测量条件一致', weight.suggestions[0], true);
  } else weight.suggestions.push('如果有当天的测量，可补记日期与数值；没有测量时保留未知即可。');
  sections.push(weight);

  const vitalsKnown = current.vitals.filter(present);
  const vitals = makeSection('vitals', '身体指标', vitalsKnown.length ? (vitalsKnown.length === vitalFields.length ? 'recorded' : 'partial') : 'missing', current.vitals);
  let changedVital = null;
  for (const metric of vitalsKnown) {
    vitals.facts.push(metric.label + '：' + observed(metric) + '，采用' + sourceName(metric.source) + (metric.estimated ? '，含估算' : '') + '。');
    const count = attachBaseline(metric, snapshot => snapshot.vitals.find(item => item.key === metric.key));
    vitals.interpretation.push(compare(metric, count));
    if (!changedVital && metric.baseline?.delta) changedVital = metric;
  }
  if (!vitalsKnown.length) vitals.facts.push('当日没有已上传的身体指标；各项保留未知。');
  vitals.interpretation.push('设备体征为已上传样本的日汇总平均值，可能受测量条件影响；与个人均值的差异不构成诊断。体脂率和 BMI 仅展示已有记录值。');
  if (changedVital) {
    vitals.suggestions.push(changedVital.label + '当日 ' + observed(changedVital) + '，此前已知日均 ' + (changedVital.baseline.estimated ? '约 ' : '') + format(changedVital.baseline.value) + (changedVital.unit ? ' ' + changedVital.unit : '') + '；若要核对变化，可先检查设备佩戴、采样和测量条件，再观察后续记录。');
    priority(60, '核对身体指标的测量条件', vitals.suggestions[0], true);
  } else if (vitalsKnown.length) {
    vitals.suggestions.push('当日已上传 ' + vitalsKnown.length + ' 项身体指标，' + vitalsKnown[0].label + '为 ' + observed(vitalsKnown[0]) + '；保持测量方式一致，积累各指标自己的连续记录后再比较。');
    priority(20, '继续积累身体指标记录', vitals.suggestions[0], true);
  }
  else vitals.suggestions.push('如果已有设备测量，可同步后再回看；未记录的指标不需要补成零。');
  sections.push(vitals);

  const recordedSections = sections.filter(section => section.status === 'recorded').length;
  const partialSections = sections.filter(section => section.status === 'partial').length;
  const missingSections = sections.filter(section => section.status === 'missing').length;
  const ranked = candidates.sort((a, b) => b.score - a.score), selectedPriorities = ranked.slice(0, 3);
  const observation = ranked.find(candidate => candidate.observation);
  // Keep one available observation when missing-data reminders would fill the summary.
  if (observation && !selectedPriorities.some(candidate => candidate.observation)) selectedPriorities[selectedPriorities.length - 1] = observation;
  const priorities = selectedPriorities.map(({ title, detail }) => ({ title, detail }));
  const limitations = [
    '基于已保存记录的规则解析；缺失值不当作零，有数值的零会保留。',
    '个人比较使用所选日期之前 7 个日历日，每项至少 3 个有值日期才计算均值；不含所选日和之后的数据。',
    '摄入记录与活动能量分别回顾；不据此计算热量缺口或设定热量、蛋白质目标。',
    '未记录年龄、身体状况及测量场景，无法仅凭日汇总判断是否适合某个健康目标。',
  ];
  if (day === state.today) limitations.push('今天仍在记录中；当前同步内容可能只是当日的一部分。');
  if (current.nutrition.some(metric => metric.estimated) || sections.some(section => section.metrics.some(metric => metric.baseline?.estimated))) limitations.push('带“约”或“含估算”的数值包含估算，个人均值也可能受估算影响。');
  return {
    day, latestDataDay: entries.length ? entries.reduce((latest, entry) => entry.day > latest ? entry.day : latest, entries[0].day) : null,
    recordCount: current.rows.length, method: '基于记录的规则解析',
    coverage: { recordedSections, partialSections, missingSections, totalSections: sections.length, isToday: day === state.today, baselineWindow },
    sections,
    summary: { text: current.rows.length ? day + ' 有 ' + current.rows.length + ' 条记录，' + (recordedSections + partialSections) + ' / ' + sections.length + ' 类已有内容；以下建议依据已知记录和个人此前的覆盖情况生成。' : day + ' 尚无记录，先补齐可获得的数据，再进行当日回顾。', priorities, limitations },
  };
}
