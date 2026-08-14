import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../dist/db.js';
import { seedDemo } from '../dist/commands/demo.js';
import { traceKey } from '../dist/commands/trace.js';
import { buildReport } from '../dist/commands/report.js';

function seeded(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'keyward-trace-'));
  const db = openDb(join(dir, 'demo.db'));
  try {
    seedDemo(db);
    return fn(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const keyOf = (db, sql, ...args) => db.prepare(sql).get(...args).key;

test('a traced key names the recipient it was sent to', () =>
  seeded((db) => {
    // Constrained to the retail-bundle cluster: this distributor also handles
    // other titles for the demo studio, exactly as one would in real life, so
    // "any key of theirs" is not a specific enough question.
    const key = keyOf(
      db,
      `SELECT k.key FROM keys k
         JOIN assignments a ON a.key_id = k.id
         JOIN recipients r ON r.id = a.recipient_id
        WHERE r.name = 'Halcyon Distribution' AND a.campaign = 'retail-bundle' LIMIT 1`,
    );
    const r = traceKey(db, key);
    assert.equal(r.verdict, 'assigned');
    assert.equal(r.recipient, 'Halcyon Distribution');
    assert.equal(r.recipientKind, 'partner');
    assert.equal(r.batch, 'publisher-partners');
    assert.equal(r.campaign, 'retail-bundle');
    assert.equal(r.game, 'Lanternfall');
  }));

test('a key that was never handed out is flagged differently', () =>
  seeded((db) => {
    // Not the same finding at all: nobody was given this, so it did not leak
    // through a recipient.
    const key = keyOf(
      db,
      'SELECT key FROM keys WHERE id NOT IN (SELECT key_id FROM assignments) LIMIT 1',
    );
    const r = traceKey(db, key);
    assert.equal(r.verdict, 'unassigned');
    assert.equal(r.recipient, undefined);
    assert.ok(r.batch, 'the batch is still known');
  }));

test('a key from someone else is unknown, not silently attributed', () =>
  seeded((db) => {
    const r = traceKey(db, 'ZZZZZ-ZZZZZ-ZZZZZ');
    assert.equal(r.verdict, 'unknown');
    assert.equal(r.recipient, undefined);
    assert.equal(r.game, undefined);
  }));

test('keys are matched regardless of case and surrounding whitespace', () =>
  seeded((db) => {
    const key = keyOf(db, 'SELECT key FROM keys LIMIT 1');
    assert.equal(traceKey(db, `  ${key.toLowerCase()}  `).verdict !== 'unknown', true);
  }));

test('something that is not a key is rejected rather than reported unknown', () =>
  seeded((db) => {
    // "unknown" would read as "not yours", which is a different and wrong
    // answer to give someone who pasted an order number by mistake.
    assert.throws(() => traceKey(db, 'not-a-key'), /not shaped like a Steam key/);
    assert.throws(() => traceKey(db, ''), /not shaped like a Steam key/);
  }));

test('the batch breakdown puts the bleeding channel first', () =>
  seeded((db) => {
    const { batches } = buildReport(db, { game: 'Lanternfall', dormantDays: 14 });
    assert.ok(batches.length >= 4);
    assert.equal(batches[0].batch, 'publisher-partners');

    const rate = (b) => b.dormant / Math.max(b.assigned, 1);
    for (let i = 1; i < batches.length; i++) {
      assert.ok(rate(batches[i - 1]) >= rate(batches[i]), 'batches must be ordered by dormancy rate');
    }
    // And the signal has to be worth acting on, not noise.
    assert.ok(rate(batches[0]) > rate(batches[batches.length - 1]) * 2);
  }));

test('every dormant key carries the batch it came from', () =>
  seeded((db) => {
    const { suspects } = buildReport(db, { game: 'Lanternfall', dormantDays: 14 });
    for (const s of suspects) assert.ok(s.batch, `${s.key} has no batch`);
  }));
