// Keep these functions compatible with function.toString() browser injection.
// XML and native uploads share the same source grouping and interval union.
export function bjDate(t) {
  return new Date(t + 8 * 3600000).toISOString();
}

export function round(x) {
  return Math.round(x * 10) / 10;
}

export function appleSleepSource(name, device) {
  const fields = new Map();
  for (const [, key, value] of device.matchAll(/(?:^|,\s*)(name|manufacturer|model|hardware|localIdentifier|UDIDeviceIdentifier)\s*:\s*([\s\S]*?)(?=,\s*[A-Za-z][A-Za-z0-9]*\s*:|,\s*>|>\s*$|$)/gi)) fields.set(key.toLowerCase(), value.trim());
  // HKDevice descriptions contain process addresses and OS/firmware metadata.
  // Keep only stable named fields; field order and volatile metadata are irrelevant.
  const identity = fields.size ? ['localidentifier', 'udideviceidentifier', 'name', 'manufacturer', 'model', 'hardware'].map(key => fields.get(key) || '') : /HKDevice\s*:/i.test(device) ? 'HKDevice:unknown' : device.trim();
  return JSON.stringify([name, identity]);
}

export function appleSleepRows(records, today) {
  const streams = new Map(), days = new Map();
  for (const r of records) {
    const asleep = /^HKCategoryValueSleepAnalysisAsleep(?:Unspecified|Core|Deep|REM)?$/.test(r.value);
    if ((!asleep && !/^HKCategoryValueSleepAnalysis(?:InBed|Awake)$/.test(r.value)) || !Number.isFinite(r.start) || !Number.isFinite(r.end) || r.end <= r.start) continue;
    if (!streams.has(r.source)) streams.set(r.source, []);
    streams.get(r.source).push({ ...r, asleep });
  }
  const addSession = segments => {
    if (!segments.length) return;
    let wake = segments[0][1];
    for (const [, end] of segments) wake = Math.max(wake, end);
    const day = bjDate(wake).slice(0, 10);
    if (day > today) return;
    if (!days.has(day)) days.set(day, []);
    for (const segment of segments) days.get(day).push(segment);
  };
  // Only touching/overlapping records from one source/device establish a session.
  // InBed/Awake may bridge stages, but only asleep intervals contribute minutes.
  for (const records of streams.values()) {
    records.sort((a, b) => a.start - b.start);
    let stop = -Infinity, segments = [];
    for (const r of records) {
      if (r.start > stop) { addSession(segments); segments = []; }
      stop = Math.max(stop, r.end);
      if (r.asleep) segments.push([r.start, r.end]);
    }
    addSession(segments);
  }
  return appleSleepDayRows(days);
}

export function appleSleepDayRows(days) {
  const rows = [];
  for (const [day, segments] of days) {
    segments.sort((a, b) => a[0] - b[0]);
    let stop = segments[0][0], duration = 0;
    for (const [start, end] of segments) { duration += Math.max(0, end - Math.max(stop, start)); stop = Math.max(stop, end); }
    const minutes = round(duration / 60000);
    if (minutes >= 1 && minutes <= 1440) rows.push({ id: 'apple:sleep:' + day, day, kind: 'sleep', label: 'Apple 健康睡眠', minutes, bed: bjDate(segments[0][0]).slice(11, 16), wake: bjDate(stop).slice(11, 16) });
  }
  return rows;
}

export function appleLegacySleepRows(records, today) {
  const days = new Map();
  for (const r of records) {
    if (!/^HKCategoryValueSleepAnalysisAsleep/.test(r.value) || !Number.isFinite(r.start) || !Number.isFinite(r.end) || r.end < r.start) continue;
    const day = bjDate(r.end).slice(0, 10);
    if (day > today) continue;
    if (!days.has(day)) days.set(day, []);
    days.get(day).push([r.start, r.end]);
  }
  return appleSleepDayRows(days);
}
