import { appleSleepRows, appleSleepSource, bjDate } from './apple-sleep.js';

const quantityLimits = { steps: 1000000, active_energy_kcal: 100000, apple_exercise_minutes: 1440 };
const sleepStates = new Map();
for (const [canonical, aliases] of [
  ['InBed', ['0', 'InBed', 'In Bed', '卧床']],
  ['Asleep', ['1', 'Asleep', '已入睡']],
  ['Awake', ['2', 'Awake', '清醒']],
  ['AsleepCore', ['3', 'AsleepCore', 'Core', 'Asleep (Core)', '核心睡眠']],
  ['AsleepDeep', ['4', 'AsleepDeep', 'Deep', 'Asleep (Deep)', '深度睡眠']],
  ['AsleepREM', ['5', 'AsleepREM', 'REM', 'Asleep (REM)', '快速眼动睡眠']],
  ['AsleepUnspecified', ['AsleepUnspecified', 'Asleep (Unspecified)']],
]) {
  const value = 'HKCategoryValueSleepAnalysis' + canonical;
  for (const alias of [...aliases, value]) sleepStates.set(alias.toLowerCase(), value);
}

function invalid() {
  throw new Error('Invalid native phone payload');
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function calendarDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) invalid();
  const time = Date.parse(value + 'T00:00:00Z');
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) invalid();
  return value;
}

function timestamp(value) {
  if (typeof value !== 'string') invalid();
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-](\d{2}):(\d{2}))$/i.exec(value);
  if (!match) invalid();
  calendarDay(match[1]);
  if (Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59 || Number(match[6] || 0) > 23 || Number(match[7] || 0) > 59) invalid();
  const time = Date.parse(value);
  if (!Number.isFinite(time)) invalid();
  return time;
}

function sampleState(state) {
  if (typeof state !== 'string' && typeof state !== 'number') invalid();
  const value = sleepStates.get(String(state).trim().toLowerCase());
  if (!value) invalid();
  return value;
}

/** Validate a complete phone snapshot before any database writes occur. */
export function normalizePhonePayload(payload, { now = new Date() } = {}) {
  if (!object(payload) || payload.version !== 1 || !(now instanceof Date) || !Number.isFinite(now.getTime())) invalid();
  const collected = timestamp(payload.collected_at);
  if (collected > now.getTime() + 5 * 60000) invalid();
  const collectedAt = new Date(collected).toISOString();
  const today = bjDate(now.getTime()).slice(0, 10);
  const rangeStart = Object.hasOwn(payload, 'range_start') ? calendarDay(payload.range_start) : bjDate(collected - 86400000).slice(0, 10);
  const activities = Object.hasOwn(payload, 'activities') ? payload.activities : [];
  const samples = Object.hasOwn(payload, 'sleep_samples') ? payload.sleep_samples : [];
  if (!Array.isArray(activities) || activities.length > 366 || !Array.isArray(samples) || samples.length > 12000) invalid();

  const rows = [], activityDays = new Set();
  for (const activity of activities) {
    if (!object(activity)) invalid();
    const day = calendarDay(activity.date);
    if (day > today || activityDays.has(day)) invalid();
    activityDays.add(day);
    const quantities = {};
    for (const [key, limit] of Object.entries(quantityLimits)) {
      if (!Object.hasOwn(activity, key)) continue;
      const value = activity[key];
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > limit) invalid();
      quantities[key] = value;
    }
    if (!Object.keys(quantities).length) invalid();
    rows.push({ id: 'apple:activity:' + day, day, kind: 'activity', label: 'Apple 健康活动', source: 'device', ...quantities, collectedAt });
  }

  const sleepRecords = [];
  for (const sample of samples) {
    if (!object(sample)) invalid();
    const start = timestamp(sample.start), end = timestamp(sample.end);
    if (end <= start || end > now.getTime()) invalid();
    for (const key of ['source', 'device']) if (Object.hasOwn(sample, key) && (typeof sample[key] !== 'string' || sample[key].length > 512)) invalid();
    sleepRecords.push({ start, end, value: sampleState(sample.state), source: appleSleepSource(sample.source ?? '', sample.device ?? '') });
  }
  for (const row of appleSleepRows(sleepRecords, today)) {
    if (row.day >= rangeStart) rows.push({ ...row, source: 'device', collectedAt });
  }
  let latestDataDay = null;
  for (const row of rows) if (latestDataDay === null || row.day > latestDataDay) latestDataDay = row.day;
  return { collectedAt, rows, latestDataDay };
}
