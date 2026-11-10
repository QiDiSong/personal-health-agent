import { Inflate } from 'fflate';

export const MAX_HEALTH_FILE_BYTES = 200 * 1024 * 1024;
export const MAX_XML_BYTES = 150 * 1024 * 1024;
const MAX_DIRECTORY_BYTES = 16 * 1024 * 1024;
const CHUNK_BYTES = 16 * 1024;
const invalidZIP = () => new Error('ZIP 压缩文件已损坏或格式不受支持，请重新从 Apple 健康导出。');
const zip64Error = () => new Error('暂不支持 ZIP64 或分卷 ZIP，请先在本机解压，再选择 150 MB 以内的 export.xml。');

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});

async function readSlice(file, start, end) {
  const bytes = new Uint8Array(await file.slice(start, end).arrayBuffer());
  if (bytes.length !== end - start) throw invalidZIP();
  return bytes;
}

function view(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function decodeName(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw invalidZIP(); }
}

function checkPath(name) {
  const segments = name.split('/');
  if (!name || name.startsWith('/') || /^[a-z]:/i.test(name) || /[\\\0]/.test(name)
    || segments.some((segment, index) => segment === '..' || segment === '.' || (!segment && index < segments.length - 1))) {
    throw new Error('ZIP 包含不安全的文件路径，请重新从 Apple 健康导出。');
  }
}

function checkExtra(bytes) {
  const data = view(bytes);
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) throw invalidZIP();
    const kind = data.getUint16(offset, true), length = data.getUint16(offset + 2, true);
    if (kind === 1) throw zip64Error();
    offset += 4 + length;
    if (offset > bytes.length) throw invalidZIP();
  }
}

async function findExport(file) {
  // Read the bounded end record and directory, never the unrelated ECG/route
  // payloads. Apple exports can contain many of those files.
  const tailStart = Math.max(0, file.size - 65557);
  const tail = await readSlice(file, tailStart, file.size), end = view(tail);
  let endOffset = -1;
  for (let offset = tail.length - 22; offset >= 0; offset--) {
    if (end.getUint32(offset, true) === 0x06054b50 && offset + 22 + end.getUint16(offset + 20, true) === tail.length) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) throw invalidZIP();
  const disk = end.getUint16(endOffset + 4, true), directoryDisk = end.getUint16(endOffset + 6, true);
  const diskCount = end.getUint16(endOffset + 8, true), count = end.getUint16(endOffset + 10, true);
  const directorySize = end.getUint32(endOffset + 12, true), directoryOffset = end.getUint32(endOffset + 16, true);
  if (disk || directoryDisk || diskCount !== count || count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) throw zip64Error();
  if (directorySize > MAX_DIRECTORY_BYTES || directoryOffset + directorySize > tailStart + endOffset) throw invalidZIP();
  const directory = await readSlice(file, directoryOffset, directoryOffset + directorySize), data = view(directory);
  let offset = 0, selected;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > directory.length || data.getUint32(offset, true) !== 0x02014b50) throw invalidZIP();
    const flags = data.getUint16(offset + 8, true), method = data.getUint16(offset + 10, true);
    const crc = data.getUint32(offset + 16, true), compressedSize = data.getUint32(offset + 20, true), size = data.getUint32(offset + 24, true);
    const nameSize = data.getUint16(offset + 28, true), extraSize = data.getUint16(offset + 30, true), commentSize = data.getUint16(offset + 32, true);
    const startDisk = data.getUint16(offset + 34, true), localOffset = data.getUint32(offset + 42, true);
    const next = offset + 46 + nameSize + extraSize + commentSize;
    if (next > directory.length) throw invalidZIP();
    if (startDisk || compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) throw zip64Error();
    const nameBytes = directory.subarray(offset + 46, offset + 46 + nameSize), name = decodeName(nameBytes);
    checkPath(name);
    checkExtra(directory.subarray(offset + 46 + nameSize, offset + 46 + nameSize + extraSize));
    // Apple localizes this member name when Health exports in Chinese.
    if (/^(?:export|导出)\.xml$/i.test(name.split('/').at(-1))) {
      if (selected) throw new Error('ZIP 中有多个健康数据 XML，请解压后选择唯一的 export.xml 或 导出.xml。');
      if (flags & 0x41) throw new Error('不支持加密 ZIP，请选择 Apple 健康原始导出的 ZIP。');
      if (method !== 0 && method !== 8) throw new Error('此 ZIP 压缩方式不受支持，请先在本机解压并选择 export.xml。');
      if (flags & 0x2020) throw invalidZIP();
      if (size > MAX_XML_BYTES) throw new Error('export.xml 超过 150 MB，请使用较小的健康数据文件。');
      if (localOffset + 30 > directoryOffset || compressedSize > directoryOffset - localOffset) throw invalidZIP();
      selected = { flags, method, crc, compressedSize, size, localOffset, nameBytes, directoryOffset };
    }
    offset = next;
  }
  if (offset !== directory.length) throw invalidZIP();
  if (!selected) throw new Error('ZIP 中没有找到 export.xml 或 导出.xml。请在「文件」中解压，再选择健康数据 XML；不要选择 export_cda.xml。');
  return selected;
}

async function payloadOffset(file, entry) {
  const header = await readSlice(file, entry.localOffset, entry.localOffset + 30), data = view(header);
  if (data.getUint32(0, true) !== 0x04034b50 || data.getUint16(6, true) !== entry.flags || data.getUint16(8, true) !== entry.method) throw invalidZIP();
  const nameSize = data.getUint16(26, true), extraSize = data.getUint16(28, true);
  const start = entry.localOffset + 30, payloadStart = start + nameSize + extraSize;
  if (payloadStart + entry.compressedSize > entry.directoryOffset) throw invalidZIP();
  const metadata = await readSlice(file, start, payloadStart);
  if (nameSize !== entry.nameBytes.length || metadata.subarray(0, nameSize).some((byte, index) => byte !== entry.nameBytes[index])) throw invalidZIP();
  checkExtra(metadata.subarray(nameSize));
  if (!(entry.flags & 8) && (data.getUint32(14, true) !== entry.crc || data.getUint32(18, true) !== entry.compressedSize || data.getUint32(22, true) !== entry.size)) throw invalidZIP();
  return payloadStart;
}

async function readXML(file, start, compressedSize, entry) {
  const decoder = new TextDecoder('utf-8', { fatal: true }), parts = [];
  let size = 0, crc = 0xffffffff;
  const accept = bytes => {
    size += bytes.length;
    if (size > MAX_XML_BYTES || (entry && size > entry.size)) throw new Error('export.xml 解压后的大小超出限制或声明大小。');
    if (entry) for (let index = 0; index < bytes.length; index++) crc = crcTable[(crc ^ bytes[index]) & 255] ^ (crc >>> 8);
    try { parts.push(decoder.decode(bytes, { stream: true })); }
    catch { throw new Error('export.xml 不是有效的 UTF-8 编码文件，请重新从 Apple 健康导出。'); }
  };
  const inflater = entry?.method === 8 ? new Inflate(accept) : null;
  try {
    if (compressedSize === 0 && inflater) inflater.push(new Uint8Array(), true);
    for (let offset = 0; offset < compressedSize; offset += CHUNK_BYTES) {
      const end = Math.min(offset + CHUNK_BYTES, compressedSize);
      const bytes = await readSlice(file, start + offset, start + end);
      if (inflater) inflater.push(bytes, end === compressedSize);
      else accept(bytes);
    }
  } catch (error) {
    if (/export\.xml/.test(error.message)) throw error;
    throw invalidZIP();
  }
  if (entry && size !== entry.size) throw new Error('export.xml 解压后的大小与 ZIP 声明大小不一致，文件可能已损坏。');
  if (entry && ((crc ^ 0xffffffff) >>> 0) !== entry.crc) throw new Error('export.xml 的 CRC 校验失败，ZIP 文件可能已损坏。');
  try { parts.push(decoder.decode()); }
  catch { throw new Error('export.xml 不是有效的 UTF-8 编码文件，请重新从 Apple 健康导出。'); }
  return parts.join('');
}

/** Read Apple Health XML or ZIP in the browser. No file bytes leave the device. */
export async function readHealthFile(file) {
  if (!file || typeof file.name !== 'string' || !Number.isSafeInteger(file.size) || file.size < 0) throw new Error('请选择 Apple 健康导出的 XML 或 ZIP 文件。');
  if (file.size > MAX_HEALTH_FILE_BYTES) throw new Error('文件超过 200 MB，请先在本机解压，再选择 150 MB 以内的 export.xml。');
  if (/\.xml$/i.test(file.name)) {
    if (file.size > MAX_XML_BYTES) throw new Error('XML 文件超过 150 MB，请使用较小的健康数据文件。');
    return readXML(file, 0, file.size);
  }
  if (!/\.zip$/i.test(file.name)) throw new Error('请选择 Apple 健康导出的 XML 或 ZIP 文件。');
  const entry = await findExport(file), start = await payloadOffset(file, entry);
  return readXML(file, start, entry.compressedSize, entry);
}
