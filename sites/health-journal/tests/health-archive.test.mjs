import assert from 'node:assert/strict';
import test from 'node:test';
import { crc32, deflateRawSync } from 'node:zlib';
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
  await assert.rejects(readHealthFile(oversized), /200|大|limit/i);
  const oversizedXML = { name: 'export.xml', size: MAX_XML_BYTES + 1, slice() { assert.fail('oversized XML was read'); } };
  await assert.rejects(readHealthFile(oversizedXML), /150|大|limit/i);
  await assert.rejects(readHealthFile(file(zip([{ name: 'export.xml', size: MAX_XML_BYTES + 1 }]))), /150|大|limit/i);
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
