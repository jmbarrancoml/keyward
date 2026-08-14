import { deflateRawSync, crc32 } from 'node:zlib';

/**
 * Builds a zip in memory, so the tests for the zip reader do not depend on the
 * `zip` command being installed. Windows has no such command, and the reader
 * itself is pure JavaScript, so shelling out was testing the wrong machine.
 *
 * Only what the reader has to cope with: stored and deflated entries, several
 * of them, and an archive comment after the end-of-central-directory record.
 */

const DOS_TIME = 0x6000; // 12:00:00, fixed so archives are reproducible
const DOS_DATE = 0x5821; // 2024-01-01

function entry(name, body, store) {
  const raw = Buffer.from(body);
  const data = store ? raw : deflateRawSync(raw, { level: 9 });
  return {
    name: Buffer.from(name, 'utf8'),
    method: store ? 0 : 8,
    crc: crc32(raw),
    csize: data.length,
    usize: raw.length,
    data,
  };
}

function localHeader(e) {
  const head = Buffer.alloc(30);
  head.writeUInt32LE(0x04034b50, 0);
  head.writeUInt16LE(20, 4); // version needed
  head.writeUInt16LE(e.method, 8);
  head.writeUInt16LE(DOS_TIME, 10);
  head.writeUInt16LE(DOS_DATE, 12);
  head.writeUInt32LE(e.crc, 14);
  head.writeUInt32LE(e.csize, 18);
  head.writeUInt32LE(e.usize, 22);
  head.writeUInt16LE(e.name.length, 26);
  return Buffer.concat([head, e.name, e.data]);
}

function centralHeader(e, offset) {
  const head = Buffer.alloc(46);
  head.writeUInt32LE(0x02014b50, 0);
  head.writeUInt16LE(20, 4); // version made by
  head.writeUInt16LE(20, 6); // version needed
  head.writeUInt16LE(e.method, 10);
  head.writeUInt16LE(DOS_TIME, 12);
  head.writeUInt16LE(DOS_DATE, 14);
  head.writeUInt32LE(e.crc, 16);
  head.writeUInt32LE(e.csize, 20);
  head.writeUInt32LE(e.usize, 24);
  head.writeUInt16LE(e.name.length, 28);
  head.writeUInt32LE(offset, 42);
  return Buffer.concat([head, e.name]);
}

/**
 * @param {Record<string, string|Buffer>} files
 * @param {{ store?: boolean, comment?: string }} [opts]
 */
export function makeZip(files, opts = {}) {
  const entries = Object.entries(files).map(([name, body]) => entry(name, body, opts.store === true));

  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const local = localHeader(e);
    centrals.push(centralHeader(e, offset));
    locals.push(local);
    offset += local.length;
  }

  const directory = Buffer.concat(centrals);
  const comment = Buffer.from(opts.comment ?? '', 'utf8');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(comment.length, 20);

  return Buffer.concat([...locals, directory, end, comment]);
}
