import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../dist/db.js';
import { seedDemo, isDemo } from '../dist/commands/demo.js';
import { buildReport } from '../dist/commands/report.js';
import { STEAM_KEY_RE } from '../dist/csv.js';

function seeded(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'keyward-demo-'));
  const db = openDb(join(dir, 'demo.db'));
  try {
    return fn(db, seedDemo(db));
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('seeding is deterministic', () => {
  // Screenshots and the README sample are generated from this, so the same
  // command has to produce the same database every time.
  const keysOf = () => seeded((db) => db.prepare('SELECT key FROM keys ORDER BY id').all().map((r) => r.key));
  assert.deepEqual(keysOf(), keysOf());
});

test('the database is flagged as demo so the UI can say so', () => {
  seeded((db) => assert.equal(isDemo(db), true));
});

test('demo keys are shaped like real Steam keys', () => {
  seeded((db) => {
    const keys = db.prepare('SELECT key FROM keys').all().map((r) => r.key);
    assert.equal(keys.length, 310);
    for (const k of keys) assert.match(k, STEAM_KEY_RE);
    // Steam's alphabet drops vowels and confusable glyphs; matching it is what
    // makes the demo read as real at a glance.
    for (const k of keys) assert.doesNotMatch(k, /[AEIOULSZ01]/);
  });
});

test('the three games cover the three states the UI has to render', () => {
  seeded((db) => {
    const leaking = buildReport(db, { game: 'Lanternfall', dormantDays: 14 });
    assert.ok(leaking.keyshopListings.length >= 4, 'the leaking game must show keyshop listings');
    assert.ok(leaking.suspects.length > 5, 'and a dormant-key shortlist');

    const healthy = buildReport(db, { game: 'Tidewright', dormantDays: 14 });
    assert.equal(healthy.keyshopListings.length, 0, 'the healthy game must have no keyshop listings');
    assert.equal(healthy.suspects.length, 0, 'and nothing dormant');

    const fresh = buildReport(db, { game: 'Nine Lives of Ash', dormantDays: 14 });
    assert.equal(fresh.lastScan, null, 'the fresh game must never have been scanned');
  });
});

test('the dormant list is dominated by one channel partner', () => {
  // The point the report exists to make: a leak is usually a partner sitting on
  // a block of keys, not a reviewer with one. If this stops holding, the demo
  // no longer demonstrates anything.
  seeded((db) => {
    const { suspects } = buildReport(db, { game: 'Lanternfall', dormantDays: 14 });
    const counts = new Map();
    for (const s of suspects) counts.set(s.recipient, (counts.get(s.recipient) ?? 0) + 1);
    const [top, n] = [...counts].sort((a, b) => b[1] - a[1])[0];
    assert.equal(top, 'Halcyon Distribution');
    assert.ok(n >= 5, `expected a cluster of at least 5 keys, got ${n}`);
  });
});

test('no real studio, outlet or creator appears in the demo data', () => {
  // Every row here sits next to "may have leaked your key". Shipping a real
  // name in one would be publishing an accusation.
  seeded((db) => {
    const names = [
      ...db.prepare('SELECT name FROM recipients').all().map((r) => r.name),
      ...db.prepare('SELECT name FROM games').all().map((r) => r.name),
    ].map((n) => n.toLowerCase());

    const real = ['ign', 'kotaku', 'polygon', 'eurogamer', 'pc gamer', 'rock paper', 'gamespot',
                  'dicehit', 'restory', 'valve', 'tinybuild', 'devolver', 'annapurna'];
    for (const r of real) {
      assert.ok(!names.some((n) => n.includes(r)), `demo data must not name "${r}"`);
    }
    assert.ok(names.every((n) => !n.includes('@gmail') && !n.includes('@outlook')));
  });
});
