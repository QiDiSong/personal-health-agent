import assert from 'node:assert/strict';
import test from 'node:test';
import { SaxesParser } from 'saxes';
import { createHealthXMLWindow } from '../worker/health-xml-window.js';
const range = { from: '2026-10-01', to: '2026-10-31' };
const quantity = (attributes = '') => '<Record type="HKQuantityTypeIdentifierStepCount" startDate="2026-10-05 10:00:00 +0800" endDate="2026-10-05 10:01:00 +0800" value="120" unit="count" ' + attributes + '/>';
const sleep = (start, end) => '<Record type="HKCategoryTypeIdentifierSleepAnalysis" value="HKCategoryValueSleepAnalysisAsleepCore" startDate="' + start + '" endDate="' + end + '"/>';
const document = records => '<HealthData locale="zh_CN">' + records + '</HealthData>';

function read(xml, chunkSize = 19, options = range) {
  const filter = createHealthXMLWindow(options);
  for (let offset = 0; offset < xml.length; offset += chunkSize) filter.write(xml.slice(offset, offset + chunkSize));
  return { xml: filter.end(), stats: filter.stats };
}

function records(xml) {
  const result = [];
  const parser = new SaxesParser();
  parser.on('opentag', tag => { if (tag.name === 'Record' || tag.name === 'Workout') result.push({ name: tag.name, ...tag.attributes }); });
  parser.write(xml).close();
  return result;
}

test('keeps supported records for the selected month when every character is a separate chunk', () => {
  const { xml, stats } = read('<?xml version="1.0" encoding="UTF-8"?>' + document(quantity('sourceName="手表 😀"')), 1);
  assert.deepEqual(records(xml), [{ name: 'Record', type: 'HKQuantityTypeIdentifierStepCount', startDate: '2026-10-05 10:00:00 +0800', endDate: '2026-10-05 10:01:00 +0800', value: '120', unit: 'count', sourceName: '手表 😀' }]);
  assert.deepEqual(stats, { keptRecords: 1, scannedRecords: 1 });
});

test('filters inclusive Shanghai start days regardless of the timestamp offset', () => {
  const points = [
    ['2026-09-30T15:59:59Z', 'excluded-before'],
    ['2026-09-30T16:00:00Z', 'included-first'],
    ['2026-10-31T15:59:59Z', 'included-last'],
    ['2026-10-31T16:00:00Z', 'excluded-after'],
  ];
  const input = points.map(([date, value]) => '<Record type="HKQuantityTypeIdentifierBodyMass" value="' + value + '" startDate="' + date + '" endDate="' + date + '"/>').join('');
  const { xml, stats } = read(document(input));
  assert.deepEqual(records(xml).map(record => record.value), ['included-first', 'included-last']);
  assert.deepEqual(stats, { keptRecords: 2, scannedRecords: 4 });
});

test('keeps overlapping sleep intervals with two prior days of cross-midnight context', () => {
  const { xml } = read(document([
    sleep('2026-09-28T23:00:00+08:00', '2026-09-29T00:00:00+08:00'),
    sleep('2026-09-28T23:00:00+08:00', '2026-09-29T00:00:01+08:00'),
    sleep('2026-10-31 22:00:00 +0800', '2026-11-01 07:00:00 +0800'),
    sleep('2026-11-02T23:00:00+08:00', '2026-11-03T07:00:00+08:00'),
    sleep('2026-11-03T00:00:00+08:00', '2026-11-03T07:00:00+08:00'),
  ].join('')));
  assert.deepEqual(records(xml).map(record => record.startDate), ['2026-09-28T23:00:00+08:00', '2026-10-31 22:00:00 +0800', '2026-11-02T23:00:00+08:00']);
});

test('does not retain unsupported samples, nested metadata, or non-sleep context records', () => {
  const { xml, stats } = read(document([
    '<Record type="HKQuantityTypeIdentifierUnsupported" startDate="2026-10-05T00:00:00Z"><MetadataEntry key="private" value="omit"/></Record>',
    '<Record type="HKQuantityTypeIdentifierStepCount" startDate="2026-09-30T00:00:00+08:00" endDate="2026-09-30T00:00:01+08:00"/>',
    '<MetadataEntry><Record type="HKQuantityTypeIdentifierStepCount" startDate="2026-10-05T00:00:00Z" endDate="2026-10-05T00:00:01Z"/></MetadataEntry>',
    quantity(),
  ].join('')));
  assert.equal(records(xml).length, 1);
  assert.doesNotMatch(xml, /Metadata|Unsupported|private/);
  assert.deepEqual(stats, { keptRecords: 1, scannedRecords: 3 });
});

test('preserves supported Food Correlation records while filtering dates and deeper nested records', () => {
  const food = quantity().replace('HKQuantityTypeIdentifierStepCount', 'HKQuantityTypeIdentifierDietaryEnergyConsumed').replace('value="120" unit="count"', 'value="600" unit="kcal"');
  const { xml, stats } = read(document([
    '<Correlation type="HKCorrelationTypeIdentifierFood">',
    food,
    food.replaceAll('2026-10-05', '2026-09-30'),
    '<MetadataEntry>' + food + '</MetadataEntry>',
    '<Workout startDate="2026-10-05T00:00:00Z" endDate="2026-10-05T01:00:00Z"/>',
    '</Correlation>',
    '<ClinicalRecord><Correlation>' + food + '</Correlation></ClinicalRecord>',
  ].join('')), 1);
  assert.deepEqual(records(xml).map(record => [record.type, record.value, record.unit]), [['HKQuantityTypeIdentifierDietaryEnergyConsumed', '600', 'kcal']]);
  assert.deepEqual(stats, { keptRecords: 1, scannedRecords: 2 });
  assert.doesNotMatch(xml, /Correlation|MetadataEntry|ClinicalRecord|Workout/);
  assert.throws(() => read('<HealthData><Correlation>' + food + '</HealthData>', 1), /XML|损坏|完整/i);
  assert.throws(() => read('<HealthData><Correlation>' + food, 1), /XML|损坏|完整/i);
});

test('keeps every supported quantity type without requiring numeric validity during streaming', () => {
  const types = ['StepCount', 'ActiveEnergyBurned', 'AppleExerciseTime', 'DistanceWalkingRunning', 'BasalEnergyBurned', 'DietaryEnergyConsumed', 'DietaryProtein', 'DietaryFatTotal', 'DietaryCarbohydrates', 'DietaryFiber', 'DietarySugar', 'DietarySodium', 'DietaryWater', 'HeartRate', 'RestingHeartRate', 'HeartRateVariabilitySDNN', 'OxygenSaturation', 'RespiratoryRate', 'BodyFatPercentage', 'BodyMassIndex', 'BodyMass'];
  const { xml } = read(document(types.map(type => quantity().replace('IdentifierStepCount', 'Identifier' + type)).join('')));
  assert.equal(records(xml).length, 21);
});

test('preserves workout attributes while omitting its child statistics', () => {
  const input = '<Workout workoutActivityType="HKWorkoutActivityTypeRunning" startDate="2026-10-31T10:00:00+08:00" endDate="2026-11-01T11:00:00+08:00" duration="90" durationUnit="min" totalEnergyBurned="600" totalEnergyBurnedUnit="kcal" totalDistance="10" totalDistanceUnit="km"><WorkoutStatistics type="other"/><MetadataEntry key="private" value="omit"/></Workout>';
  const { xml, stats } = read(document(input));
  assert.deepEqual(records(xml), [{ name: 'Workout', workoutActivityType: 'HKWorkoutActivityTypeRunning', startDate: '2026-10-31T10:00:00+08:00', endDate: '2026-11-01T11:00:00+08:00', duration: '90', durationUnit: 'min', totalEnergyBurned: '600', totalEnergyBurnedUnit: 'kcal', totalDistance: '10', totalDistanceUnit: 'km' }]);
  assert.doesNotMatch(xml, /Statistics|Metadata|private/);
  assert.deepEqual(stats, { keptRecords: 1, scannedRecords: 1 });
});

test('round trips escaped attribute values without introducing XML markup', () => {
  const { xml } = read(document(quantity('sourceName="A &amp; B &quot;Watch&quot; &lt;手表&gt; &#10;&#9;&#13;"')));
  assert.equal(records(xml)[0].sourceName, 'A & B "Watch" <手表> \n\t\r');
  assert.equal(records(xml).length, 1);
});

test('rejects XML 1.1 input whose decoded controls cannot appear in the XML 1.0 result', () => {
  assert.throws(() => read('<?xml version="1.1"?>' + document(quantity('sourceName="&#1;"')), 1), /XML|版本/i);
});

test('drops invalid, missing, or reverse timestamps instead of allowing date parsing guesses', () => {
  const input = [
    '<Record type="HKQuantityTypeIdentifierBodyMass" startDate="2026-10-05" endDate="2026-10-05"/>',
    '<Record type="HKQuantityTypeIdentifierBodyMass" startDate="2026-10-05T24:00:00Z" endDate="2026-10-06T01:00:00Z"/>',
    '<Record type="HKQuantityTypeIdentifierBodyMass" startDate="2026-10-05T23:60:00Z" endDate="2026-10-06T01:00:00Z"/>',
    '<Record type="HKQuantityTypeIdentifierBodyMass" startDate="2026-10-05T23:00:00+24:00" endDate="2026-10-06T01:00:00Z"/>',
    '<Record type="HKQuantityTypeIdentifierBodyMass" startDate="2026-10-05T23:00:00Z" endDate="2026-10-05T22:00:00Z"/>',
    sleep('2026-09-31T23:00:00Z', '2026-10-01T01:00:00Z'),
    sleep('2026-10-05T23:00:00Z', 'invalid'),
    quantity().replace('2026-10-05 10:01:00 +0800', ''),
  ].join('');
  assert.equal(read(document(input)).xml, '<HealthData/>');
});

test('accepts the internal Apple Health DTD without copying it into the result', () => {
  const doctype = '<!DOCTYPE HealthData [\n<!ELEMENT HealthData (ExportDate?,Me?,(Record|Workout)*)>\n<!ATTLIST HealthData locale CDATA #REQUIRED>\n<!ELEMENT Record EMPTY>\n<!ATTLIST Record type CDATA #REQUIRED>\n]>';
  const { xml } = read('<?xml version="1.0"?>' + doctype + document(quantity()), 1);
  assert.equal(records(xml).length, 1);
  assert.doesNotMatch(xml, /DOCTYPE|ELEMENT|ATTLIST/);
});

test('rejects custom entities and external DTD references even when chunked character by character', () => {
  for (const doctype of ['<!DOCTYPE HealthData [<!ENTITY named "value">]>', '<!DOCTYPE HealthData SYSTEM "https://example.invalid/health.dtd">', '<!DOCTYPE HealthData PUBLIC "health" "https://example.invalid/health.dtd">']) {
    assert.throws(() => read(doctype + document(quantity()), 1), /XML|实体|DTD|DOCTYPE/i);
  }
  assert.throws(() => read(document(quantity('sourceName="&unknown;"')), 1), /XML|实体/i);
});

test('rejects malformed or truncated tails after selected records rather than returning partial XML', () => {
  for (const input of ['<HealthData>' + quantity(), document(quantity()) + '<HealthData/>', '<Other>' + quantity() + '</Other>', '<HealthData>' + quantity() + '<Bad></HealthData>', document(quantity()) + 'trailing text']) {
    assert.throws(() => read(input), /XML|Apple|HealthData|损坏|完整/i);
  }
});

test('discards long unsupported history while retaining only the selected month', () => {
  const filter = createHealthXMLWindow({ ...range, maxOutputBytes: 2048 });
  filter.write('<HealthData>');
  const old = quantity().replaceAll('2026-10-05', '2010-01-01');
  for (let index = 0; index < 30000; index++) filter.write(old);
  filter.write(quantity());
  filter.write('</HealthData>');
  const xml = filter.end();
  assert.equal(records(xml).length, 1);
  assert.ok(Buffer.byteLength(xml) < 2048);
  assert.deepEqual(filter.stats, { keptRecords: 1, scannedRecords: 30001 });
});

test('preserves supported nutrition records within a food Correlation in the selected month', () => {
  const food = '<Record type="HKQuantityTypeIdentifierDietaryEnergyConsumed" value="600" unit="kcal" startDate="2026-10-05 12:00:00 +0800" endDate="2026-10-05 12:00:00 +0800"/>';
  const old = food.replaceAll('2026-10-05', '2010-01-01');
  const input = '<Correlation type="HKCorrelationTypeIdentifierFood">' + old + food + '</Correlation>';
  const result = read(document(input), 1);
  assert.equal(records(result.xml).length, 1);
  assert.match(result.xml, /value="600"/);
  assert.doesNotMatch(result.xml, /Correlation|2010-01-01/);
  assert.deepEqual(result.stats, { keptRecords: 1, scannedRecords: 2 });
});

test('bounds records and UTF-8 output size with selected-month errors', () => {
  assert.throws(() => read(document(quantity() + quantity()), 1, { ...range, maxRecords: 1 }), /所选|月份|日期范围/);
  const unicodeRecord = quantity('sourceName="' + '手表'.repeat(30) + '"');
  const singleBytes = Buffer.byteLength(read(document(unicodeRecord)).xml);
  assert.equal(records(read(document(unicodeRecord), 1, { ...range, maxOutputBytes: singleBytes }).xml).length, 1);
  assert.throws(() => read(document(unicodeRecord), 1, { ...range, maxOutputBytes: singleBytes - 1 }), /所选|月份|日期范围/);
});

test('rejects oversized XML tokens and nesting without retaining unbounded parser data', () => {
  for (const input of [document(quantity('sourceName="' + 'x'.repeat(16385) + '"')), '<HealthData><!--' + 'x'.repeat(1024 * 1024 + 1) + '--></HealthData>', '<HealthData><!' + 'x'.repeat(1024 * 1024 + 1), '<HealthData>' + '<MetadataEntry>'.repeat(257)]) {
    assert.throws(() => read(input, 4096), /XML|长度|过大|嵌套/i);
  }
});

test('rejects CDATA payloads instead of carrying raw exported data into the filtered XML', () => {
  assert.throws(() => read(document('<![CDATA[private raw data]]>' + quantity()), 1), /XML|CDATA/i);
});

test('requires a valid ordered calendar range and usable selected-month limits', () => {
  for (const options of [{}, { from: '2026-02-30', to: '2026-03-01' }, { from: '2026-10-31', to: '2026-10-01' }, { ...range, maxRecords: -1 }, { ...range, maxOutputBytes: 1 }]) {
    assert.throws(() => createHealthXMLWindow(options), /日期|范围|limit|Invalid/i);
  }
});
