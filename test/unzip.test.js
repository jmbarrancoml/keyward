import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { looksLikeZip, readZipText, zipToText } from '../dist/unzip.js';
import { extractKeys } from '../dist/csv.js';
import { makeZip } from './helpers/zip.js';

/**
 * The download from Steamworks is a zip. Reading it here rather than pulling in
 * a library keeps the runtime dependency count at zero, which is the whole
 * trust argument for a tool people hand a partner session cookie to.
 */

test('reads a deflated archive, the ordinary case', () => {
  const keys = Array.from({ length: 60 }, (_, i) => `AAA${String(i).padStart(2, '0')}-BBBBB-CCCCC`);
  const zip = makeZip({ 'keys.txt': keys.join('\n') });
  assert.equal(looksLikeZip(zip), true);
  assert.deepEqual(extractKeys(zipToText(zip)), keys);
});

test('reads a stored archive, where nothing was compressed', () => {
  // An uncompressed entry is a different code path in the reader.
  const zip = makeZip({ 'keys.txt': 'AAAAA-BBBBB-CCCCC\n' }, { store: true });
  assert.deepEqual(extractKeys(zipToText(zip)), ['AAAAA-BBBBB-CCCCC']);
});

test('reads every file in the archive, not only the first', () => {
  const zip = makeZip({
    'press.txt': 'AAAAA-BBBBB-CCCCC',
    'creators.txt': 'DDDDD-EEEEE-FFFFF',
  });
  assert.equal(readZipText(zip).length, 2);
  assert.deepEqual(extractKeys(zipToText(zip)).sort(), ['AAAAA-BBBBB-CCCCC', 'DDDDD-EEEEE-FFFFF']);
});

test('a zip with a comment is still found', () => {
  // The end-of-archive record is not always the last 22 bytes, so scanning
  // backwards for it matters.
  const zip = makeZip({ 'keys.txt': 'AAAAA-BBBBB-CCCCC' }, { comment: 'a note about this batch' });
  assert.deepEqual(extractKeys(zipToText(zip)), ['AAAAA-BBBBB-CCCCC']);
});

test('something that is not a zip is refused, not misread', () => {
  assert.equal(looksLikeZip(Buffer.from('AAAAA-BBBBB-CCCCC')), false);
  assert.throws(() => zipToText(Buffer.from('not an archive at all')), /does not look like a zip/);
});

test('the CLI takes the zip straight from Steamworks', () => {
  const home = mkdtempSync(join(tmpdir(), 'keyward-home-'));
  const dir = mkdtempSync(join(tmpdir(), 'keyward-cli-zip-'));
  try {
    writeFileSync(
      join(dir, 'keys.zip'),
      makeZip({ 'keys.txt': 'AAAAA-BBBBB-CCCCC\nDDDDD-EEEEE-FFFFF\n' }),
    );

    const run = (args) =>
      execFileSync(process.execPath, [join(process.cwd(), 'dist', 'cli.js'), ...args], {
        env: { ...process.env, HOME: home, USERPROFILE: home },
        encoding: 'utf8',
      });

    run(['game', 'add', '--name', 'G']);
    const out = run(['import', 'keys', '--game', 'G', '--batch', 'press', '--file', join(dir, 'keys.zip')]);
    assert.match(out, /Imported 2 new keys/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
