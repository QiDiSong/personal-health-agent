import { SaxesParser } from 'saxes';

const DAY = 86400000;
const SHANGHAI_OFFSET = 8 * 3600000;
const MAX_TOKEN_LENGTH = 1024 * 1024;
const MAX_ATTRIBUTE_LENGTH = 16384;
const PARSER_CHUNK_LENGTH = 16384;
const SUPPORTED_QUANTITY = /^HKQuantityTypeIdentifier(?:BodyMass|StepCount|ActiveEnergyBurned|BasalEnergyBurned|AppleExerciseTime|DistanceWalkingRunning|Dietary(?:EnergyConsumed|Protein|FatTotal|Carbohydrates|Fiber|Sugar|Sodium|Water)|HeartRate|RestingHeartRate|HeartRateVariabilitySDNN|OxygenSaturation|RespiratoryRate|BodyFatPercentage|BodyMassIndex)$/;
const SLEEP_TYPE = 'HKCategoryTypeIdentifierSleepAnalysis';
const ATTRIBUTES = new Set(['type', 'value', 'unit', 'startDate', 'endDate', 'sourceName', 'sourceVersion', 'device', 'creationDate', 'workoutActivityType', 'duration', 'durationUnit', 'totalEnergyBurned', 'totalEnergyBurnedUnit', 'totalDistance', 'totalDistanceUnit']);
const ROOT_OPEN = '<HealthData>';
const ROOT_CLOSE = '</HealthData>';
const XML_ERROR = 'Apple 健康 XML 损坏或不完整，请重新选择导出文件。';

function calendarDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

// Match the quantity normalizer's strict Apple and ISO timestamps. Date.parse
// alone accepts impossible dates and browser-dependent timezone guesses.
function timestamp(value) {
  if (typeof value !== 'string') return NaN;
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?\s?(Z|[+-](\d{2}):?(\d{2}))$/i.exec(value);
  if (!match || !calendarDay(match[1]) || +match[2] > 23 || +match[3] > 59 || +match[4] > 59 || +(match[7] || 0) > 23 || +(match[8] || 0) > 59) return NaN;
  const zone = match[6].toUpperCase() === 'Z' ? 'Z' : match[6][0] + match[7] + ':' + match[8];
  return Date.parse(match[1] + 'T' + match[2] + ':' + match[3] + ':' + match[4] + (match[5] || '') + zone);
}

function escapeAttribute(value) {
  return value.replace(/[&<>"\n\r\t]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\n': '&#10;', '\r': '&#13;', '\t': '&#9;' })[character]);
}

/** Keep only a bounded date window while validating the entire Health XML. */
export function createHealthXMLWindow({ from, to, maxOutputBytes = 64 * 1024 * 1024, maxRecords = 200000 } = {}) {
  if (!calendarDay(from) || !calendarDay(to) || from > to) throw new TypeError('请选择有效的健康导入日期范围。');
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < '<HealthData/>'.length || !Number.isSafeInteger(maxRecords) || maxRecords < 0) throw new RangeError('Invalid selected-month XML limits');
  const first = Date.parse(from + 'T00:00:00Z') - SHANGHAI_OFFSET;
  const after = Date.parse(to + 'T00:00:00Z') - SHANGHAI_OFFSET + DAY;
  // Preserve complete connected nights before the normalizer assigns a wake
  // day. Filtering either side at midnight can create a partial sleep session.
  const sleepFirst = first - 2 * DAY, sleepAfter = after + 2 * DAY;
  const stats = { keptRecords: 0, scannedRecords: 0 };
  const encoder = new TextEncoder();
  const parser = new SaxesParser({ position: false });
  const parents = [];
  let depth = 0, sawRoot = false, closedRoot = false, attributes = 0;
  let pieces = [], outputBytes = ROOT_OPEN.length + ROOT_CLOSE.length;
  let failure, ended = false, result;

  const fail = message => { throw new Error(message); };
  const monthLimit = () => fail('所选月份的健康记录过多，请缩短导入日期范围后重试。');
  parser.on('error', () => fail(XML_ERROR));
  parser.on('xmldecl', declaration => {
    if (declaration.version !== '1.0') fail('Apple 健康导入仅支持 XML 1.0 版本。');
  });
  parser.on('opentagstart', tag => {
    attributes = 0;
    if (tag.name.length > 256) fail('Apple 健康 XML 标签名称过长。');
    if (depth >= 256) fail('Apple 健康 XML 嵌套过深。');
  });
  parser.on('attribute', attribute => {
    if (++attributes > 128 || attribute.name.length > 256 || attribute.value.length > MAX_ATTRIBUTE_LENGTH) fail('Apple 健康 XML 属性过多或长度过大。');
  });
  parser.on('doctype', doctype => {
    if (doctype.length > MAX_TOKEN_LENGTH || !/^\s*HealthData(?:\s|\[|$)/.test(doctype) || /<!ENTITY\b|\b(?:SYSTEM|PUBLIC)\b/i.test(doctype)) fail('Apple 健康 XML 包含不支持的 DTD 或实体声明。');
  });
  parser.on('comment', comment => {
    if (comment.length > MAX_TOKEN_LENGTH) fail('Apple 健康 XML 注释长度过大。');
  });
  parser.on('processinginstruction', instruction => {
    if (instruction.target.length > 256 || instruction.body.length > MAX_TOKEN_LENGTH) fail('Apple 健康 XML 指令长度过大。');
  });
  parser.on('cdata', () => fail('Apple 健康 XML 不支持 CDATA 数据。'));
  parser.on('opentag', tag => {
    const parent = parents.at(-1);
    parents.push(tag.name);
    depth++;
    if (depth === 1) {
      if (sawRoot || closedRoot || tag.name !== 'HealthData') fail('请选择 Apple 健康导出的 HealthData XML 文件。');
      sawRoot = true;
    } else if ((depth === 2 && (tag.name === 'Record' || tag.name === 'Workout'))
      || (depth === 3 && parent === 'Correlation' && tag.name === 'Record')) {
      stats.scannedRecords++;
      const attrs = tag.attributes;
      const sleeping = tag.name === 'Record' && attrs.type === SLEEP_TYPE;
      if (tag.name === 'Workout' || sleeping || SUPPORTED_QUANTITY.test(attrs.type || '')) {
        const start = timestamp(attrs.startDate), end = timestamp(attrs.endDate);
        const valid = Number.isFinite(start) && Number.isFinite(end) && end >= start;
        const selected = sleeping ? end > start && start < sleepAfter && end > sleepFirst : start >= first && start < after;
        if (valid && selected) {
          if (stats.keptRecords >= maxRecords) monthLimit();
          const record = '<' + tag.name + Object.entries(attrs).filter(([key]) => ATTRIBUTES.has(key)).map(([key, value]) => ' ' + key + '="' + escapeAttribute(value) + '"').join('') + '/>';
          const bytes = encoder.encode(record).byteLength;
          if (outputBytes + bytes > maxOutputBytes) monthLimit();
          outputBytes += bytes;
          stats.keptRecords++;
          pieces.push(record);
        }
      }
    }
    // Saxes retains open tag objects on its stack. Once selected attributes
    // have been serialized, discarded metadata must not stay on that stack.
    tag.attributes = Object.create(null);
  });
  parser.on('closetag', () => {
    parents.pop();
    if (--depth === 0) closedRoot = true;
  });

  function checkBuffers() {
    // Saxes 6 has no configurable token limit. Feed small pieces and inspect
    // its token buffers so an unfinished comment, DTD or attribute stays bounded.
    for (const key of ['text', 'name', 'piTarget', 'entity', 'openWakaBang']) {
      if (parser[key].length > MAX_TOKEN_LENGTH) fail('Apple 健康 XML 单个标记长度过大。');
    }
  }

  function guarded(action) {
    if (failure) throw failure;
    try { return action(); }
    catch (error) {
      failure = error;
      pieces = [];
      throw error;
    }
  }

  return {
    stats,
    write(textChunk) {
      return guarded(() => {
        if (ended || typeof textChunk !== 'string') fail(XML_ERROR);
        for (let offset = 0; offset < textChunk.length; offset += PARSER_CHUNK_LENGTH) {
          parser.write(textChunk.slice(offset, offset + PARSER_CHUNK_LENGTH));
          checkBuffers();
        }
      });
    },
    end() {
      return guarded(() => {
        if (ended) return result;
        parser.close();
        if (!sawRoot || !closedRoot || depth !== 0) fail(XML_ERROR);
        ended = true;
        result = pieces.length ? ROOT_OPEN + pieces.join('') + ROOT_CLOSE : '<HealthData/>';
        pieces = [];
        return result;
      });
    },
  };
}
