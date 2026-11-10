import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { crc32, createDeflateRaw, deflateRawSync } from 'node:zlib';
import { MAX_HEALTH_FILE_BYTES, MAX_XML_BYTES, readHealthFile } from '../worker/health-archive.js';

const xml = '<?xml version="1.0" encoding="UTF-8"?><HealthData><Record value="睡眠"/></HealthData>';

// Independent ZIP fixtures include local headers, central records and the end
// record. Node zlib supplies compression and checksums, not the browser reader.
function zip(entries, { comment = '', disk = 0 } = {}) {
  const locals = [], central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), localName = Buffer.from(entry.localName ?? entry.name);
    const data = Buffer.from(entry.text ?? xml);
    const method = entry.method ?? 8, flags = entry.flags ?? 0x800;
    const compressed = entry.compressed ?? (method === 8 ? deflateRawSync(data) : data);
    const checksum = entry.checksum ?? crc32(data);
    const size = entry.size ?? data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(flags & 8 ? 0 : checksum, 14);
    local.writeUInt32LE(flags & 8 ? 0 : compressed.length, 18);
    local.writeUInt32LE(flags & 8 ? 0 : size, 22);
    local.writeUInt16LE(localName.length, 26);
    let descriptor = Buffer.alloc(0);
    if (flags & 8) {
      descriptor = Buffer.alloc(16);
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(checksum, 4);
      descriptor.writeUInt32LE(compressed.length, 8);
      descriptor.writeUInt32LE(size, 12);
    }
    locals.push(local, localName, compressed, descriptor);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(flags, 8);
    record.writeUInt16LE(method, 10);
    record.writeUInt32LE(checksum, 16);
    record.writeUInt32LE(compressed.length, 20);
    record.writeUInt32LE(size, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(offset, 42);
    central.push(record, name);
    offset += local.length + localName.length + compressed.length + descriptor.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22), commentBytes = Buffer.from(comment);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(disk, 4);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(commentBytes.length, 20);
  return Buffer.concat([...locals, directory, end, commentBytes]);
}

const file = (bytes, name = 'export.zip') => new File([bytes], name);

test('reads an XML file locally and preserves its Unicode content', async () => {
  assert.equal(await readHealthFile(file(xml, 'export.XML')), xml);
});

test('reads stored and deflated export.xml without inflating unrelated ZIP members', async () => {
  for (const method of [0, 8]) {
    const bytes = zip([
      { name: 'apple_health_export/export.xml', method },
      { name: 'apple_health_export/workout-routes/route.gpx', method: 99, compressed: Buffer.from('not compressed') },
    ], { comment: 'Health export' });
    assert.equal(await readHealthFile(file(bytes)), xml);
  }
});

test('accepts export.xml at the root, case-insensitive names and streamed ZIP data descriptors', async () => {
  assert.equal(await readHealthFile(file(zip([{ name: 'EXPORT.XML', flags: 0x808 }]))), xml);
});

test('reads the Chinese Apple Health 导出.xml member in 导出.zip', async () => {
  for (const method of [0, 8]) {
    const bytes = zip([
      { name: 'apple_health_export/导出.xml', method, flags: 0x808 },
      { name: 'apple_health_export/export_cda.xml', text: '<ClinicalDocument/>' },
    ]);
    assert.equal(await readHealthFile(file(bytes, '导出.zip')), xml);
  }
});

test('rejects ambiguous English and Chinese health XML members', async () => {
  await assert.rejects(readHealthFile(file(zip([
    { name: 'apple_health_export/export.xml' },
    { name: 'apple_health_export/导出.xml' },
  ]))), /多个|唯一/i);
});

test('rejects missing or ambiguous export.xml before choosing an entry', async () => {
  await assert.rejects(readHealthFile(file(zip([{ name: 'export_cda.xml' }]))), /export\.xml/i);
  await assert.rejects(readHealthFile(file(zip([{ name: 'export.xml' }, { name: 'backup/export.xml' }]))), /多个|multiple|唯一/i);
});

test('rejects traversal, absolute and backslash ZIP paths', async () => {
  for (const name of ['../export.xml', '/export.xml', 'C:/export.xml', 'folder/../export.xml', 'folder\\export.xml']) {
    await assert.rejects(readHealthFile(file(zip([{ name }]))), /路径|path/i, name);
  }
});

test('rejects encrypted and unsupported export compression', async () => {
  await assert.rejects(readHealthFile(file(zip([{ name: 'export.xml', flags: 0x801 }]))), /加密|encrypted/i);
  await assert.rejects(readHealthFile(file(zip([{ name: 'export.xml', method: 99 }]))), /压缩|compression/i);
});

test('checks CRC and exact uncompressed size rather than trusting ZIP declarations', async () => {
  await assert.rejects(readHealthFile(file(zip([{ name: 'export.xml', checksum: 0 }]))), /损坏|校验|CRC/i);
  await assert.rejects(readHealthFile(file(zip([{ name: 'export.xml', size: 1 }]))), /大小|长度|size|limit/i);
  await assert.rejects(readHealthFile(file(zip([{ name: 'export.xml', size: 1000 }]))), /大小|长度|size|limit/i);
});

test('enforces file and declared XML limits before loading or inflating large data', async () => {
  const oversized = { name: 'export.zip', size: MAX_HEALTH_FILE_BYTES + 1, slice() { assert.fail('oversized input was read'); } };
  await assert.rejects(readHealthFile(oversized), /4 GiB|大|limit/i);
  const oversizedXML = { name: 'export.xml', size: MAX_XML_BYTES + 1, slice() { assert.fail('oversized XML was read'); } };
  await assert.rejects(readHealthFile(oversizedXML, { from: '2026-11-01', to: '2026-11-30' }), /4 GiB|大|limit/i);
  const legacyLimit = 150 * 1024 * 1024;
  const legacyXML = { name: 'export.xml', size: legacyLimit + 1, slice() { assert.fail('unfiltered XML was read'); } };
  await assert.rejects(readHealthFile(legacyXML), /月份|150|大|limit/i);
  await assert.rejects(readHealthFile(file(zip([{ name: 'export.xml', size: legacyLimit + 1 }]))), /月份|150|大|limit/i);
});

test('rejects malformed, truncated, multi-disk and ZIP64 archives with useful errors', async () => {
  const valid = zip([{ name: 'export.xml' }]);
  const zip64 = Buffer.from(valid);
  zip64.writeUInt16LE(0xffff, zip64.length - 12);
  for (const bytes of [Buffer.from('not a zip'), valid.subarray(0, valid.length - 5), zip([{ name: 'export.xml' }], { disk: 1 }), zip64]) {
    await assert.rejects(readHealthFile(file(bytes)), /ZIP|压缩|解压|损坏/i);
  }
});

test('rejects inconsistent local headers and invalid compressed bytes', async () => {
  await assert.rejects(readHealthFile(file(zip([{ name: 'export.xml', localName: 'another.xml' }]))), /损坏|不一致|header/i);
  await assert.rejects(readHealthFile(file(zip([{ name: 'export.xml', compressed: Buffer.from([255, 255]) }]))), /损坏|压缩|deflate/i);
});

test('only accepts XML or ZIP files and rejects invalid UTF-8', async () => {
  await assert.rejects(readHealthFile(file(xml, 'export.json')), /XML|ZIP/i);
  await assert.rejects(readHealthFile(file(Buffer.from([0xff, 0xfe]), 'export.xml')), /UTF|编码|encoding/i);
});

const month = { from: '2026-11-01', to: '2026-11-30' };
const oldRecord = '<Record type="HKQuantityTypeIdentifierStepCount" value="999" unit="count" sourceName="old-history" startDate="2016-01-01 12:00:00 +0800" endDate="2016-01-01 12:01:00 +0800"/>';
const recentRecord = '<Record type="HKQuantityTypeIdentifierStepCount" value="3210" unit="count" sourceName="手表" startDate="2026-11-08 12:00:00 +0800" endDate="2026-11-08 12:01:00 +0800"/>';

test('streams only the requested month from XML and localized stored or deflated ZIP exports', async () => {
  const history = '<HealthData>' + oldRecord + recentRecord + oldRecord + '</HealthData>';
  for (const source of [file(history, 'export.xml'), ...[0, 8].map(method => file(zip([{ name: 'apple_health_export/导出.xml', text: history, method }]), '导出.zip'))]) {
    const selected = await readHealthFile(source, month);
    assert.match(selected, /value="3210"/);
    assert.match(selected, /手表/);
    assert.doesNotMatch(selected, /old-history/);
    assert.match(selected, /^<\?xml|^<HealthData/);
  }
});

function largeHistoryParts() {
  const prefix = Buffer.from('<HealthData>'), suffix = Buffer.from(recentRecord + oldRecord + '</HealthData>');
  const repeat = Buffer.from(oldRecord + '<!--' + 'x'.repeat(16 * 1024) + '-->');
  const count = Math.ceil(151 * 1024 * 1024 / repeat.length);
  return { prefix, suffix, repeat, count };
}

// A virtual File produces real bytes for each bounded read. Its 151 MiB XML is
// never assembled in memory, mirroring a full iPhone export with old history.
function largeHistoryFile() {
  const { prefix, suffix, repeat, count } = largeHistoryParts(), repeatedBytes = count * repeat.length;
  let totalRead = 0, largestRead = 0;
  const source = {
    name: 'export.xml', size: prefix.length + repeatedBytes + suffix.length,
    get totalRead() { return totalRead; }, get largestRead() { return largestRead; },
    slice(start, end) {
      const size = end - start;
      largestRead = Math.max(largestRead, size);
      assert.ok(size <= 64 * 1024, 'full history must be read in bounded chunks');
      return { async arrayBuffer() {
        totalRead += size;
        const output = Buffer.alloc(size);
        let offset = start, written = 0;
        while (offset < end) {
          let bytes, position;
          if (offset < prefix.length) { bytes = prefix; position = offset; }
          else if (offset < prefix.length + repeatedBytes) { bytes = repeat; position = (offset - prefix.length) % repeat.length; }
          else { bytes = suffix; position = offset - prefix.length - repeatedBytes; }
          const length = Math.min(bytes.length - position, end - offset);
          bytes.copy(output, written, position, position + length);
          offset += length; written += length;
        }
        return output.buffer;
      } };
    },
  };
  return source;
}

test('imports a real byte stream larger than 150 MiB without retaining full history or blocking tasks', async () => {
  const source = largeHistoryFile(), progress = [];
  const initialHeap = process.memoryUsage().heapUsed;
  let peakHeap = initialHeap;
  let taskRan = false;
  const task = setTimeout(() => { taskRan = true; }, 0);
  try {
    const selected = await readHealthFile(source, { ...month, onProgress: update => {
      progress.push(update);
      peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
    } });
    assert.ok(source.totalRead > 150 * 1024 * 1024);
    assert.equal(source.totalRead, source.size, 'read through the tail even after finding recent data');
    assert.ok(source.largestRead <= 64 * 1024);
    assert.ok(selected.length < 2048, 'retain only the selected month');
    assert.ok(peakHeap - initialHeap < 80 * 1024 * 1024, 'working heap stays below half the full export size');
    assert.match(selected, /value="3210"/);
    assert.doesNotMatch(selected, /old-history/);
    assert.ok(taskRan, 'yield to browser tasks while scanning history');
    assert.ok(progress.length >= 2);
    assert.equal(progress.at(-1).readBytes, source.size);
    assert.equal(progress.at(-1).totalBytes, source.size);
    assert.equal(progress.at(-1).xmlBytes, source.size);
    assert.equal(progress.at(-1).keptRecords, 1);
    assert.ok(progress.every(update => Object.keys(update).every(key => ['readBytes', 'totalBytes', 'xmlBytes', 'keptRecords'].includes(key))), 'progress exposes counters only');
  } finally { clearTimeout(task); }
});

test('streams and validates a ZIP whose expanded XML exceeds 150 MiB', async () => {
  const { prefix, suffix, repeat, count } = largeHistoryParts();
  const deflater = createDeflateRaw({ level: 1 }), compressed = [];
  let checksum = 0, size = 0;
  deflater.on('data', chunk => compressed.push(chunk));
  const completion = once(deflater, 'end');
  const write = async bytes => {
    checksum = crc32(bytes, checksum); size += bytes.length;
    if (!deflater.write(bytes)) await once(deflater, 'drain');
  };
  await write(prefix);
  for (let index = 0; index < count; index++) await write(repeat);
  await write(suffix);
  deflater.end();
  await completion;
  const source = file(zip([{ name: 'apple_health_export/导出.xml', compressed: Buffer.concat(compressed), checksum, size }]));
  let finalProgress;
  const selected = await readHealthFile(source, { ...month, onProgress: update => { finalProgress = update; } });
  assert.ok(size > 150 * 1024 * 1024);
  assert.match(selected, /value="3210"/);
  assert.doesNotMatch(selected, /old-history/);
  assert.ok(selected.length < 2048);
  assert.equal(finalProgress.xmlBytes, size);
  assert.equal(finalProgress.readBytes, finalProgress.totalBytes);
  assert.equal(finalProgress.keptRecords, 1);
});

test('checks the entire ZIP CRC and XML tail after selecting recent records', async () => {
  const history = '<HealthData>' + recentRecord + oldRecord + '</HealthData>';
  await assert.rejects(readHealthFile(file(zip([{ name: 'export.xml', text: history, checksum: 0 }])), month), /CRC|校验/i);
  await assert.rejects(readHealthFile(file(zip([{ name: 'export.xml', text: history + '<broken' }])), month), /XML|格式|完整|解析/i);
});

test('can cancel a streaming import before reading more health bytes', async () => {
  const controller = new AbortController();
  controller.abort();
  const source = { name: 'export.xml', size: 100, slice() { assert.fail('cancelled import was read'); } };
  await assert.rejects(readHealthFile(source, { ...month, signal: controller.signal }), { name: 'AbortError' });
  const afterStart = new AbortController();
  await assert.rejects(readHealthFile(source, { ...month, signal: afterStart.signal, onProgress() { afterStart.abort(); } }), { name: 'AbortError' });
});
