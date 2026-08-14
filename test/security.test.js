import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, statSync, readFileSync } from 'node:fs';
import { makeZip } from './helpers/zip.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../dist/db.js';
import { zipToText } from '../dist/unzip.js';

/**
 * These cover the ways keyward could hurt someone who runs it, rather than the
 * ways it could be wrong. Each one is here because the failure was real when it
 * was written, not because the category sounded worrying.
 */

test('an archive that unpacks to more than it should is refused', () => {
  // 300MB of zeros compresses to under 300KB. Before the cap, importing that
  // took the process from 49MB resident to 959MB, off a file small enough to
  // arrive by email.
  const dir = mkdtempSync(join(tmpdir(), 'keyward-bomb-'));
  try {
    const bomb = makeZip({ 'big.txt': Buffer.alloc(120 * 1024 * 1024, 0) });
    writeFileSync(join(dir, 'bomb.zip'), bomb);
    assert.ok(bomb.length < 300 * 1024, `the bomb should be small, it is ${bomb.length} bytes`);

    const before = process.memoryUsage().rss;
    assert.throws(() => zipToText(readFileSync(join(dir, 'bomb.zip'))), /unpacks to more than/);
    const grew = (process.memoryUsage().rss - before) / 1024 / 1024;
    assert.ok(grew < 80, `rejecting it should stay cheap, but memory grew ${grew.toFixed(0)}MB`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an ordinary archive still opens', () => {
  const dir = mkdtempSync(join(tmpdir(), 'keyward-ok-'));
  try {
    writeFileSync(join(dir, 'ok.zip'), makeZip({ 'keys.txt': 'AAAAA-BBBBB-CCCCC\n' }));
    assert.match(zipToText(readFileSync(join(dir, 'ok.zip'))), /AAAAA-BBBBB-CCCCC/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the database is not readable by other accounts on the machine', () => {
  // It is the ledger of who holds which key. SQLite creates files with whatever
  // the umask allows, which is normally world-readable.
  const dir = mkdtempSync(join(tmpdir(), 'keyward-perm-'));
  try {
    const file = join(dir, 'ledger.db');
    const db = openDb(file);
    db.close();
    if (process.platform === 'win32') {
      // Windows has no mode bits to check. keyward rewrites the ACL instead,
      // and test/keystore.test.js is where that platform gets exercised.
      assert.ok(statSync(file).isFile());
    } else {
      const mode = statSync(file).mode & 0o777;
      assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the served pages carry the headers that keep them contained', async () => {
  const { serve } = await import('../dist/ui/server.js');
  const dir = mkdtempSync(join(tmpdir(), 'keyward-hdr-'));
  const handle = await serve({ dbFile: join(dir, 'h.db'), port: 0, open: false });
  try {
    const url = new URL(handle.url);
    const res = await fetch(`${url.origin}/?t=${url.searchParams.get('t')}`);
    const csp = res.headers.get('content-security-policy') ?? '';

    // Nothing loads from the network, nothing frames it, no form posts away.
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /form-action 'self'/);
    assert.match(csp, /base-uri 'none'/);
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    // The token is in the URL, so it must not ride along to a shop link.
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  } finally {
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
