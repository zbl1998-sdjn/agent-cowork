// @ts-check

import zlib from 'node:zlib';

/**
 * @typedef {{ maxEntries?: number, maxEntryBytes?: number, maxTotalUncompressedBytes?: number, maxCompressionRatio?: number }} ZipReadOptions
 * @typedef {{ name: string, method: number, compressedSize: number, uncompressedSize: number, crc32: number, content: Buffer }} ZipReadEntry
 * @typedef {{ name: string, content: Buffer | string }} ZipCreateEntry
 */

const DEFAULT_MAX_ENTRIES = 1000;
const DEFAULT_MAX_ENTRY_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_UNCOMPRESSED_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_COMPRESSION_RATIO = 200;

const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i += 1) {
  let c = i;
  for (let j = 0; j < 8; j += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[i] = c >>> 0;
}

/**
 * @param {Buffer} buffer
 * @returns {number}
 */
export function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * @param {Buffer} buffer
 * @returns {number}
 */
function findEndOfCentralDirectory(buffer) {
  const minOffset = Math.max(0, buffer.length - 0xffff - 22);
  for (let offset = buffer.length - 22; offset >= minOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      return offset;
    }
  }
  throw new Error('ZIP end of central directory not found');
}

/**
 * @param {unknown} name
 * @returns {string}
 */
function normalizeZipName(name) {
  const normalized = String(name || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.includes('../')) {
    throw new Error(`Invalid ZIP entry name: ${name}`);
  }
  return normalized;
}

/**
 * @param {Buffer} buffer
 * @param {ZipReadOptions} [options]
 * @returns {ZipReadEntry[]}
 */
export function readZipEntries(buffer, options = {}) {
  const maxEntries = Math.min(Math.max(Number(options.maxEntries || DEFAULT_MAX_ENTRIES), 1), DEFAULT_MAX_ENTRIES);
  const maxEntryBytes = Math.min(Math.max(Number(options.maxEntryBytes || DEFAULT_MAX_ENTRY_BYTES), 1), DEFAULT_MAX_ENTRY_BYTES);
  const maxTotalUncompressedBytes = Math.min(
    Math.max(Number(options.maxTotalUncompressedBytes || DEFAULT_MAX_TOTAL_UNCOMPRESSED_BYTES), 1),
    DEFAULT_MAX_TOTAL_UNCOMPRESSED_BYTES,
  );
  const maxCompressionRatio = Math.min(Math.max(Number(options.maxCompressionRatio || DEFAULT_MAX_COMPRESSION_RATIO), 1), DEFAULT_MAX_COMPRESSION_RATIO);
  if (!Buffer.isBuffer(buffer)) {
    throw new Error('ZIP input must be a Buffer');
  }
  const eocdOffset = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  if (entryCount > maxEntries) {
    throw new Error(`ZIP has too many entries (${entryCount}; max ${maxEntries})`);
  }
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  /** @type {ZipReadEntry[]} */
  const entries = [];
  let totalUncompressed = 0;
  let offset = centralDirectoryOffset;

  for (let i = 0; i < entryCount; i += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('Invalid ZIP central directory header');
    }
    const method = buffer.readUInt16LE(offset + 10);
    const entryCrc = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const name = normalizeZipName(buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8'));
    offset += 46 + nameLength + extraLength + commentLength;
    totalUncompressed += uncompressedSize;
    if (uncompressedSize > maxEntryBytes) {
      throw new Error(`ZIP entry too large for ${name} (${uncompressedSize}; max ${maxEntryBytes})`);
    }
    if (totalUncompressed > maxTotalUncompressedBytes) {
      throw new Error(`ZIP total uncompressed size exceeds max ${maxTotalUncompressedBytes}`);
    }
    if (compressedSize > 0 && uncompressedSize / compressedSize > maxCompressionRatio) {
      throw new Error(`ZIP entry compression ratio too high for ${name}`);
    }

    if (buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      throw new Error(`Invalid ZIP local header for ${name}`);
    }
    const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataOffset = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataOffset, dataOffset + compressedSize);
    let content;
    if (method === 0) {
      content = Buffer.from(compressed);
    } else if (method === 8) {
      content = zlib.inflateRawSync(compressed, { maxOutputLength: maxEntryBytes });
    } else {
      throw new Error(`Unsupported ZIP compression method ${method} for ${name}`);
    }
    if (uncompressedSize !== content.length) {
      throw new Error(`ZIP entry size mismatch for ${name}`);
    }
    entries.push({
      name,
      method,
      compressedSize,
      uncompressedSize,
      crc32: entryCrc,
      content,
    });
  }

  return entries;
}

/**
 * @param {ZipCreateEntry[]} entries
 * @returns {Buffer}
 */
export function createZip(entries) {
  if (!Array.isArray(entries)) {
    throw new Error('entries must be an array');
  }
  /** @type {Buffer[]} */
  const localParts = [];
  /** @type {Buffer[]} */
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const name = normalizeZipName(entry.name);
    const nameBuffer = Buffer.from(name, 'utf8');
    const content = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(String(entry.content ?? ''), 'utf8');
    const checksum = crc32(content);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);

    localParts.push(local, nameBuffer, content);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuffer);

    offset += local.length + nameBuffer.length + content.length;
  }

  const centralDirectoryOffset = offset;
  const centralDirectory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(centralDirectoryOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, eocd]);
}
