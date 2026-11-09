import { appleSleepSource } from './apple-sleep.js';

export const QUANTITY_IMPORT_POLICY = '按北京时间开始日汇总；跨日样本完整计入开始日。相同来源与稳定设备标识的重复样本仅计一次。步数、能量、锻炼时间、距离和营养按来源分别相加，各指标取单一来源最大日总量，不叠加 iPhone 与 Watch。体征取有效样本最多来源的算术平均值，同数时按来源标识排序选择。此规则是导出记录摘要，可能与 Apple 健康的来源优先级和界面统计不同；缺失指标留空。';

// Keep this function compatible with function.toString() browser injection.
// Its only external dependency, appleSleepSource, is shared with sleep imports.
export function quantityRows(records, { today, from, to } = {}) {
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const calendarDay = value => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const time = Date.parse(value + 'T00:00:00Z');
    return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
  };
  if (!Array.isArray(records)) throw new TypeError('Apple quantity records must be an array');
  if (!calendarDay(today) || from !== undefined && !calendarDay(from) || to !== undefined && !calendarDay(to)) throw new TypeError('Invalid Apple quantity date range');
  if (from !== undefined && to !== undefined && from > to) throw new RangeError('Invalid Apple quantity date range');

  const timestamp = value => {
    if (typeof value !== 'string') return NaN;
    const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?\s?(Z|[+-](\d{2}):?(\d{2}))$/i.exec(value);
    if (!match || !calendarDay(match[1]) || +match[2] > 23 || +match[3] > 59 || +match[4] > 59 || +(match[7] || 0) > 23 || +(match[8] || 0) > 59) return NaN;
    const zone = match[6].toUpperCase() === 'Z' ? 'Z' : match[6][0] + match[7] + ':' + match[8];
    return Date.parse(match[1] + 'T' + match[2] + ':' + match[3] + ':' + match[4] + (match[5] || '') + zone);
  };
  const numeric = value => {
    if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
    if (typeof value !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim())) return NaN;
    return Number(value);
  };
  const energy = { kcal: 1, kJ: 1 / 4.184 }, grams = { g: 1, mg: 0.001 };
  // [HealthKit identifier suffix, kind, output field, unit multipliers, minimum, daily maximum]
  const definitions = [
    ['StepCount', 'activity', 'steps', { count: 1 }, 0, 1000000],
    ['ActiveEnergyBurned', 'activity', 'active_energy_kcal', energy, 0, 100000],
    ['AppleExerciseTime', 'activity', 'apple_exercise_minutes', { min: 1, hr: 60, s: 1 / 60 }, 0, 1440],
    ['DistanceWalkingRunning', 'activity', 'walking_distance_km', { m: 0.001, km: 1, mi: 1.609344 }, 0, 1000],
    ['BasalEnergyBurned', 'activity', 'resting_energy_kcal', energy, 0, 100000],
    ['DietaryEnergyConsumed', 'nutrition', 'kcal', energy, 0, 20000],
    ['DietaryProtein', 'nutrition', 'protein', grams, 0, 2000],
    ['DietaryFatTotal', 'nutrition', 'fat', grams, 0, 2000],
    ['DietaryCarbohydrates', 'nutrition', 'carbs', grams, 0, 2000],
    ['DietaryFiber', 'nutrition', 'fiber', grams, 0, 500],
    ['DietarySugar', 'nutrition', 'sugar', grams, 0, 2000],
    ['DietarySodium', 'nutrition', 'sodium_mg', { g: 1000, mg: 1 }, 0, 50000],
    ['DietaryWater', 'nutrition', 'water_ml', { mL: 1, L: 1000 }, 0, 20000],
    ['HeartRate', 'vitals', 'heart_rate_bpm', { 'count/min': 1, bpm: 1 }, 20, 300],
    ['RestingHeartRate', 'vitals', 'resting_heart_rate_bpm', { 'count/min': 1, bpm: 1 }, 20, 300],
    ['HeartRateVariabilitySDNN', 'vitals', 'hrv_ms', { ms: 1, s: 1000 }, 0, 1000],
    // Apple exports these percentages as fractions: value="0.98" unit="%".
    ['OxygenSaturation', 'vitals', 'spo2_percent', { '%': 100 }, 0, 100],
    ['RespiratoryRate', 'vitals', 'respiratory_rate', { 'count/min': 1 }, 1, 100],
    ['BodyFatPercentage', 'vitals', 'body_fat_percent', { '%': 100 }, 0, 100],
    ['BodyMassIndex', 'vitals', 'bmi', { count: 1 }, 1, 150],
  ];
  const byType = new Map(definitions.map(definition => ['HKQuantityTypeIdentifier' + definition[0], definition]));
  const days = new Map(), seen = new Set();
  for (const record of records) {
    if (!object(record)) continue;
    const definition = byType.get(record.type);
    if (!definition) continue;
    const [, , field, units, minimum, maximum] = definition;
    if (typeof record.unit !== 'string' || !Object.hasOwn(units, record.unit)) continue;
    const value = numeric(record.value) * units[record.unit];
    if (!Number.isFinite(value) || value < minimum || value > maximum) continue;
    const start = timestamp(record.startDate), end = timestamp(record.endDate);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
    const day = new Date(start + 8 * 3600000).toISOString().slice(0, 10);
    if (day > today || from !== undefined && day < from || to !== undefined && day > to) continue;
    if (record.sourceName !== undefined && typeof record.sourceName !== 'string' || record.device !== undefined && typeof record.device !== 'string') continue;
    const source = appleSleepSource(record.sourceName || '', record.device || '');
    const key = JSON.stringify([field, source, start, end, value]);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!days.has(day)) days.set(day, new Map());
    const metrics = days.get(day);
    if (!metrics.has(field)) metrics.set(field, new Map());
    const sources = metrics.get(field);
    if (!sources.has(source)) sources.set(source, []);
    sources.get(source).push(value);
  }

  const rows = [], labels = { activity: 'Apple 健康活动', nutrition: 'Apple 健康营养', vitals: 'Apple 健康体征' };
  for (const day of [...days.keys()].sort()) {
    const metrics = days.get(day), grouped = new Map();
    for (const [, kind, field, , minimum, maximum] of definitions) {
      if (!metrics.has(field)) continue;
      let chosen;
      for (const [source, samples] of metrics.get(field)) {
        // Sorting values makes floating point summation independent of XML order.
        const total = samples.sort((a, b) => a - b).reduce((sum, value) => sum + value, 0);
        const value = kind === 'vitals' ? total / samples.length : total;
        if (!Number.isFinite(value) || value < minimum || value > maximum) continue;
        const candidate = { value, count: samples.length, source };
        if (!chosen || (kind === 'vitals' ? candidate.count > chosen.count || candidate.count === chosen.count && source < chosen.source : value > chosen.value)) chosen = candidate;
      }
      if (!chosen) continue;
      if (!grouped.has(kind)) grouped.set(kind, { id: 'apple:' + kind + ':' + day, day, kind, label: labels[kind] });
      // Preserve useful distance and measurement precision without float noise.
      grouped.get(kind)[field] = Math.round(chosen.value * 1000) / 1000;
    }
    rows.push(...grouped.values());
  }
  return rows;
}
