import { inflateRawSync } from 'node:zlib';

/**
 * Just enough ZIP to read what Steamworks hands you: a small archive with a
 * text file in it. Written out rather than pulled in, because a dependency
 * would be the first one in a tool whose main claim is that it has none, and
 * node:zlib already does the hard part.
 *
 * Reads the central directory rather than walking local headers, since a local
 * header may carry zero sizes and defer them to a trailing data descriptor.
 */

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/**
 * A hard ceiling on what comes out, not on what goes in. Deflate happily turns
 * 300KB of archive into 300MB of text, so without this a file small enough to
 * arrive by email can exhaust the machine's memory. 32MB is over a million
 * keys, which is far more than any studio has.
 */
const MAX_UNPACKED = 32 * 1024 * 1024;

export function looksLikeZip(buf: Buffer): boolean {
  return buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
}

function findEocd(buf: Buffer): number {
  // The comment field means the record is not always the last 22 bytes.
  const earliest = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= earliest; i--) {
    if (buf.readUInt32LE(i) === EOCD) return i;
  }
  return -1;
}

export interface ZipEntry {
  name: string;
  text: string;
}

export function readZipText(buf: Buffer): ZipEntry[] {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('That does not look like a zip file.');

  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  let budget = MAX_UNPACKED;

  for (let i = 0; i < count; i++) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== CENTRAL) break;

    const method = buf.readUInt16LE(offset + 10);
    const compressed = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localAt = buf.readUInt32LE(offset + 42);
    const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString('utf8');
    offset += 46 + nameLen + extraLen + commentLen;

    // Directories, and the metadata folders a Mac adds to every archive.
    if (name.endsWith('/') || name.startsWith('__MACOSX/')) continue;
    if (buf.readUInt32LE(localAt) !== LOCAL) continue;

    const localNameLen = buf.readUInt16LE(localAt + 26);
    const localExtraLen = buf.readUInt16LE(localAt + 28);
    const start = localAt + 30 + localNameLen + localExtraLen;
    const raw = buf.subarray(start, start + compressed);

    let text: string;
    try {
      if (method === 0) {
        if (raw.length > budget) throw new Error('over budget');
        text = raw.toString('utf8');
      } else if (method === 8) {
        // The budget is shared across entries, so a thousand small bombs cost
        // the same as one large one.
        text = inflateRawSync(raw, { maxOutputLength: budget }).toString('utf8');
      } else {
        continue; // some other compression method; nothing sane to do
      }
    } catch {
      throw new Error(
        `That archive unpacks to more than ${MAX_UNPACKED / 1024 / 1024}MB of text, which is far ` +
          'more than a batch of keys. Unzip it yourself and paste the keys if it is genuine.',
      );
    }
    budget -= text.length;

    entries.push({ name, text });
  }

  if (entries.length === 0) throw new Error('That zip has nothing readable in it.');
  return entries;
}

/** Everything readable in the archive, run together for key scanning. */
export function zipToText(buf: Buffer): string {
  return readZipText(buf)
    .map((e) => e.text)
    .join('\n');
}
