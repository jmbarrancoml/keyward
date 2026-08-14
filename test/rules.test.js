import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../dist/db.js';
import { seedDemo } from '../dist/commands/demo.js';
import { recordSighting } from '../dist/commands/trace.js';
import { evaluateRules, DEFAULT_THRESHOLDS, RULES, SEVERITY_ORDER } from '../dist/rules.js';

function seeded(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'keyward-rules-'));
  const db = openDb(join(dir, 'demo.db'));
  try {
    seedDemo(db);
    const game = db.prepare("SELECT id FROM games WHERE name = 'Lanternfall'").get();
    return fn(db, game.id);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const run = (db, gameId, over = {}) =>
  evaluateRules(db, gameId, { ...DEFAULT_THRESHOLDS, ...over });

const byRule = (findings, rule) => findings.filter((f) => f.rule === rule);

test('every documented rule can actually fire', () =>
  seeded((db, gameId) => {
    const key = db
      .prepare(
        `SELECT k.key FROM keys k
           JOIN assignments a ON a.key_id = k.id
           JOIN recipients r ON r.id = a.recipient_id
          WHERE r.name = 'Halcyon Distribution' AND a.campaign = 'retail-bundle' LIMIT 1`,
      )
      .get().key;
    recordSighting(db, key, 'Instant Gaming');

    // The region rule needs a batch that was locked and a sighting somewhere
    // else. publisher-partners is locked to MX in the demo data.
    const locked = db
      .prepare(
        `SELECT k.key FROM keys k
           JOIN batches b ON b.id = k.batch_id
          WHERE b.name = 'publisher-partners' AND b.region = 'MX' LIMIT 1`,
      )
      .get().key;
    recordSighting(db, locked, 'Kinguin', undefined, undefined, 'ES');

    const fired = new Set(run(db, gameId).map((f) => f.rule));
    for (const r of RULES) {
      assert.ok(fired.has(r.id), `rule "${r.id}" is documented but never fires on the demo data`);
    }
  }));

test('findings are ordered by how conclusive they are', () =>
  seeded((db, gameId) => {
    const findings = run(db, gameId);
    for (let i = 1; i < findings.length; i++) {
      assert.ok(
        SEVERITY_ORDER[findings[i - 1].severity] <= SEVERITY_ORDER[findings[i].severity],
        'a weaker signal must never appear above a stronger one',
      );
    }
  }));

test('a recorded sighting is the only "certain" finding', () =>
  seeded((db, gameId) => {
    assert.equal(run(db, gameId).filter((f) => f.severity === 'certain').length, 0);

    const key = db.prepare('SELECT key FROM keys LIMIT 1').get().key;
    recordSighting(db, key, 'Kinguin');

    const certain = run(db, gameId).filter((f) => f.severity === 'certain');
    assert.equal(certain.length, 1);
    assert.equal(certain[0].rule, 'confirmed-on-sale');
    assert.match(certain[0].summary, /Kinguin/);
  }));

test('keys redeemed without ever being handed out are attributed to the studio, not a person', () =>
  seeded((db, gameId) => {
    const [f] = byRule(run(db, gameId), 'unassigned-activated');
    assert.ok(f, 'the rule must fire on the demo data');
    assert.equal(f.subjectKind, 'studio');
    assert.equal(f.severity, 'high');
    // Naming a recipient here would be wrong: nobody was given these keys.
    // However it is phrased, it must not point the finger at a contact.
    assert.match(f.why, /no contact of yours/i);
    assert.match(f.why, /Steamworks/);
  }));

test('the dormant cluster names the distributor, and one stray key does not fire it', () =>
  seeded((db, gameId) => {
    const cluster = byRule(run(db, gameId), 'dormant-cluster');
    assert.ok(cluster.some((f) => f.subject === 'Halcyon Distribution'));

    // Raise the bar past the biggest cluster and it must go quiet rather than
    // degrade into naming everyone with one forgotten key.
    const strict = byRule(run(db, gameId, { clusterMin: 50 }), 'dormant-cluster');
    assert.equal(strict.length, 0);
  }));

test('thresholds actually change what fires', () =>
  seeded((db, gameId) => {
    const loose = run(db, gameId, { clusterMin: 2, oversuppliedMin: 3 }).length;
    const strict = run(db, gameId, { clusterMin: 20, oversuppliedMin: 200, batchRatePct: 99 }).length;
    assert.ok(loose > strict, `loosening thresholds must surface more (${loose} vs ${strict})`);
  }));

test('a batch is only a hotspot when it beats the game average, not just the bar', () =>
  seeded((db, gameId) => {
    // Every batch above 1% would otherwise fire in a game that leaks everywhere,
    // which tells the studio nothing about where to look.
    const findings = byRule(run(db, gameId, { batchRatePct: 1 }), 'batch-hotspot');
    const batches = db
      .prepare('SELECT COUNT(*) AS n FROM batches b WHERE b.game_id = ?')
      .get(gameId).n;
    assert.ok(findings.length < batches, 'not every batch can be the hotspot');
  }));

test('every finding explains itself and carries no bare accusation', () =>
  seeded((db, gameId) => {
    for (const f of run(db, gameId)) {
      assert.ok(f.why.length > 40, `${f.rule} has no explanation worth reading`);
      assert.ok(f.summary.length > 0);
      assert.ok(['recipient', 'batch', 'studio'].includes(f.subjectKind));
    }
  }));

test('a sighting for a key that is not ours is refused', () =>
  seeded((db) => {
    assert.throws(() => recordSighting(db, 'ZZZZZ-ZZZZZ-ZZZZZ', 'G2A'), /not in this database/);
  }));
