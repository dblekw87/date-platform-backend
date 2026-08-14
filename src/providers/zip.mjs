import { inflateRawSync } from "node:zlib";

/**
 * Reads a single entry out of a ZIP archive.
 *
 * DART ships its corporation index as a ZIP, and Node has no archive reader —
 * only raw deflate. Rather than take a dependency for one file a year, this
 * walks the central directory and inflates the entry.
 */

const endOfCentralDirectorySignature = 0x06054b50;
const centralDirectorySignature = 0x02014b50;

function findEndOfCentralDirectory(buffer) {
  // The record sits at the very end, after a comment of at most 65535 bytes.
  const earliest = Math.max(0, buffer.length - 65_557);

  for (let offset = buffer.length - 22; offset >= earliest; offset -= 1) {
    if (buffer.readUInt32LE(offset) === endOfCentralDirectorySignature) return offset;
  }

  return -1;
}

/** Returns the first entry whose name matches, inflated, or null. */
export function readZipEntry(buffer, matches) {
  const end = findEndOfCentralDirectory(buffer);

  if (end === -1) throw new Error("ZIP end-of-central-directory not found");

  const entryCount = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);

  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(offset) !== centralDirectorySignature) break;

    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");

    if (matches(name)) {
      // Local headers repeat the name and extra fields with their own lengths.
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      const data = buffer.subarray(start, start + compressedSize);

      return method === 0 ? data : inflateRawSync(data);
    }

    offset += 46 + nameLength + extraLength + commentLength;
  }

  return null;
}
